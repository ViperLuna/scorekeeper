/* Scorekeeper UI. Everything is built with DOM calls (no innerHTML) so player
   names can never inject markup. */
(function () {
  'use strict';
  const L = window.SKLogic;
  const api = window.SKAPI;
  const root = document.getElementById('app');
  const LAST_KEY = 'sk_last_code';

  const S = {
    view: 'home',
    game: null, players: [], events: [],
    unsub: null, poll: null, seq: 0, refreshTimer: null,
    hooks: [],           // functions re-run after every render (open dialogs)
    pin: null,           // editor PIN, kept in memory only
  };

  // ---------------------------------------------------------------- helpers
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (Array.isArray(k)) return k.forEach(add);
      if (k == null || k === false) return;
      el.appendChild(k.nodeType ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  }
  const fmt = (n) => String(L.round(n));
  const sign = (n) => (n > 0 ? '+' + fmt(n) : fmt(n));

  let toastTimer;
  function toast(msg, ms) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms || 3000);
  }
  function fail(e) { console.error(e); toast((e && e.message) || 'Something went wrong'); }

  function modal(build, opts) {
    const dlg = h('dialog', { class: 'modal' });
    const close = () => { if (dlg.open) dlg.close(); };
    dlg.addEventListener('close', () => { dlg.remove(); if (opts && opts.onClose) opts.onClose(); });
    dlg.appendChild(build(close));
    document.body.appendChild(dlg);
    dlg.showModal();
    return { dlg, close };
  }

  function confirmDialog({ title, message, ok }) {
    return new Promise((resolve) => {
      let result = false;
      modal((close) => h('div', { class: 'mbody' },
        h('h2', {}, title),
        h('p', {}, message),
        h('div', { class: 'mrow' },
          h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
          h('button', { class: 'btn', onclick: () => { result = true; close(); } }, ok || 'Confirm'))),
      { onClose: () => resolve(result) });
    });
  }

  function show(view, ...nodes) {
    S.view = view;
    root.replaceChildren(...nodes);
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------- home
  function renderHome() {
    leaveGame(true);
    const last = localStorage.getItem(LAST_KEY);
    const codeInput = h('input', { class: 'input code', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '5', placeholder: '12345', 'aria-label': 'Game code' });
    const join = () => joinByCode(codeInput.value.trim());
    codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });

    show('home', h('main', { class: 'home' },
      h('h1', {}, 'Scorekeeper'),
      !api.configured && h('p', { class: 'notice' }, 'Not connected to Supabase yet. Add the project URL and anon key to js/config.js.'),
      h('div', { class: 'stack' },
        h('button', { class: 'btn big', onclick: openNewGame, disabled: !api.configured }, 'New game'),
        h('div', { class: 'joinrow' }, codeInput, h('button', { class: 'btn', onclick: join, disabled: !api.configured }, 'Join')),
        last && h('button', { class: 'btn ghost', onclick: () => joinByCode(last) }, 'Resume game ' + last),
        h('div', { class: 'row2' },
          h('button', { class: 'btn ghost', onclick: renderStats, disabled: !api.configured }, 'Stats'),
          h('button', { class: 'btn ghost', onclick: renderEditorGate, disabled: !api.configured }, 'Game editor')))));
  }

  async function joinByCode(code) {
    if (!/^\d{5}$/.test(code)) return toast('Codes are 5 digits');
    try {
      const d = await api.loadGame(code);
      if (!d) return toast('No game with code ' + code);
      enterGame(d);
    } catch (e) { fail(e); }
  }

  const QUICK = { id: null, name: 'Quick game', config: L.DEFAULT_CONFIG };

  async function openNewGame() {
    let types = [];
    try { types = await api.listGameTypes(); } catch (e) { return fail(e); }
    const sel = h('select', { class: 'input' },
      h('option', { value: '' }, 'Quick game (+1 / −1)'),
      types.map((t) => h('option', { value: t.id }, t.name)));
    const teams = h('select', { class: 'input' },
      h('option', { value: '0' }, 'No teams'),
      [2, 3, 4].map((n) => h('option', { value: String(n) }, n + ' teams')));
    const practice = h('input', { type: 'checkbox' });
    modal((close) => h('div', { class: 'mbody' },
      h('h2', {}, 'New game'),
      h('label', { class: 'field' }, h('span', {}, 'Game'), sel),
      h('label', { class: 'field' }, h('span', {}, 'Teams'), teams),
      h('label', { class: 'check' }, practice, h('span', {}, 'Practice mode (not saved to stats)')),
      h('div', { class: 'mrow' },
        h('button', { class: 'btn ghost', onclick: close }, 'Cancel'),
        h('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            try {
              const t = types.find((x) => x.id === sel.value);
              const gt = t ? { id: t.id, name: t.name, config: L.normalizeConfig(t.config) } : { ...QUICK, config: L.normalizeConfig(QUICK.config) };
              const game = await api.createGame({ gameType: gt, teams: Number(teams.value), practice: practice.checked });
              close();
              const d = await api.loadGame(game.code);
              enterGame(d, true);
            } catch (err) { e.target.disabled = false; fail(err); }
          },
        }, 'Create'))));
  }

  // ------------------------------------------------------------- game session
  function enterGame(d, fresh) {
    leaveGame(true);
    S.game = d.game; S.players = d.players; S.events = d.events;
    localStorage.setItem(LAST_KEY, d.game.code);
    S.unsub = api.subscribe(d.game.id, scheduleRefresh);
    S.poll = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 8000);
    keepAwake();
    renderGame();
    if (fresh) openRoster();
  }

  function leaveGame(quiet) {
    if (S.unsub) { try { S.unsub(); } catch (e) { /* ignore */ } }
    clearInterval(S.poll); clearTimeout(S.refreshTimer);
    S.unsub = null; S.poll = null; S.game = null; S.players = []; S.events = []; S.hooks = [];
    if (!quiet) renderHome();
  }

  function scheduleRefresh() {
    clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(refresh, 120);
  }

  async function refresh() {
    if (!S.game) return;
    const mine = ++S.seq;
    try {
      const d = await api.loadGame(S.game.code);
      if (mine !== S.seq || !S.game) return; // a newer refresh is on its way
      if (!d) { toast('That game was removed'); localStorage.removeItem(LAST_KEY); return leaveGame(); }
      S.game = d.game; S.players = d.players; S.events = d.events;
      renderGame();
    } catch (e) { console.error(e); }
  }

  let wake = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.game) { keepAwake(); refresh(); }
  });

  // -------------------------------------------------------------- game screen
  function gridFor(n) {
    if (n <= 3) return { cols: Math.max(n, 1), rows: 1 };
    if (n === 4) return { cols: 2, rows: 2 };
    const cols = Math.ceil(n / 2);
    return { cols, rows: n > cols * 2 ? 3 : 2 };
  }

  function currentState() {
    const g = S.game;
    const cfg = L.normalizeConfig(g.config);
    const units = L.getUnits(g, S.players);
    const totals = L.foldEvents(S.events, g, units);
    const rows = units.filter((u) => u.members.length).map((u) => ({ key: u.key, score: totals[u.key].score }));
    const auto = L.evaluate(cfg, rows, false);
    return { g, cfg, units, totals, rows, auto };
  }

  function renderGame() {
    const { g, cfg, units, totals, rows, auto } = currentState();
    const finished = g.status === 'finished';
    const { canUndo, canRedo } = L.undoState(S.events, g);
    const names = (keys) => keys.map((k) => (units.find((u) => u.key === k) || {}).name).filter(Boolean).join(' & ');
    const grid = gridFor(units.length);
    const winners = new Set(finished || auto.over ? (auto.over ? auto : L.evaluate(cfg, rows, true)).winners : []);

    const bar = h('header', { class: 'topbar' },
      h('div', { class: 'tl' },
        h('button', { class: 'chip', onclick: () => { navigator.clipboard && navigator.clipboard.writeText(g.code); toast('Code ' + g.code + ' copied'); }, title: 'Tap to copy' }, g.code),
        h('span', { class: 'gname' }, g.game_name)),
      g.practice ? h('div', { class: 'practice' }, 'PRACTICE MODE') : h('div', { class: 'spacer' }),
      h('div', { class: 'tr' },
        h('button', { class: 'icon', onclick: doUndo, disabled: !canUndo || finished, 'aria-label': 'Undo' }, '↶'),
        h('button', { class: 'icon', onclick: doRedo, disabled: !canRedo || finished, 'aria-label': 'Redo' }, '↷'),
        h('button', { class: 'icon', onclick: openMenu, 'aria-label': 'Menu' }, '⋯'),
        fsButton()));

    let body;
    if (!units.length) {
      body = h('div', { class: 'empty' },
        h('p', {}, 'No players yet.'),
        h('button', { class: 'btn big', onclick: openRoster }, 'Add players'));
    } else {
      body = h('main', { class: 'panels', style: `--cols:${grid.cols};--rows:${grid.rows}` },
        units.map((u) => panel(u, totals[u.key], cfg, winners, finished)));
    }

    const banner = !finished && auto.over && h('div', { class: 'banner' },
      h('span', {}, auto.draw ? 'Draw: ' + names(auto.winners) : '🏆 ' + names(auto.winners) + ' wins!'),
      g.practice
        ? h('button', { class: 'btn small', onclick: doReset }, 'Reset')
        : h('button', { class: 'btn small', onclick: () => doFinish(false) }, 'Finish & save'));
    const hint = !finished && !auto.over && auto.message && h('div', { class: 'banner soft' }, auto.message);

    const done = finished && h('div', { class: 'overlay' },
      h('div', { class: 'card' },
        h('h2', {}, g.practice ? 'Game over' : 'Game saved'),
        h('p', { class: 'big' }, winners.size && !(L.evaluate(cfg, rows, true).draw) ? '🏆 ' + names([...winners]) : 'Draw'),
        h('ol', { class: 'rank' }, rows.slice().sort((a, b) => (cfg.direction === 'low' ? a.score - b.score : b.score - a.score))
          .map((r) => h('li', {}, names([r.key]) + ' — ' + fmt(r.score)))),
        h('div', { class: 'mrow' },
          h('button', { class: 'btn ghost', onclick: () => leaveGame() }, 'Home'),
          h('button', { class: 'btn', onclick: doReset }, 'Play again'))));

    root.replaceChildren(h('div', { id: 'game', class: g.practice ? 'is-practice' : '' },
      bar, h('div', { class: 'rotate-hint' }, 'Turn your phone sideways for the best view'),
      banner || hint || null, body, done || null));
    S.view = 'game';
    S.hooks.forEach((fn) => fn());
  }

  function panel(u, t, cfg, winners, finished) {
    const n = cfg.buttons.length;
    const bc = n <= 2 ? n : n <= 4 ? 2 : 3;
    const counters = Object.entries(t.counters);
    const live = u.members.length > 0 && !finished;
    return h('section', { class: 'panel' + (winners.has(u.key) ? ' winner' : '') },
      h('div', { class: 'pname' }, u.name),
      S.game.teams > 0 && h('div', { class: 'members' }, u.members.length ? u.members.map((m) => m.name).join(', ') : 'no players yet'),
      h('div', { class: 'score' }, fmt(t.score)),
      h('div', { class: 'counters' },
        counters.map(([k, v]) => h('span', {}, k + ' ' + v)),
        t.attempts > 0 && counters.length > 0 ? h('span', {}, 'of ' + t.attempts) : null),
      h('div', { class: 'btns', style: `--bcols:${bc}` },
        cfg.buttons.map((b) => h('button', {
          class: 'sbtn', disabled: !live,
          onclick: () => tap(u, b),
        }, b.label || sign(b.points)))));
  }

  function fsButton() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (standalone) return null;
    return h('button', { class: 'icon', 'aria-label': 'Full screen', onclick: toggleFullscreen }, '⛶');
  }

  async function toggleFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (el.requestFullscreen) {
      try {
        await el.requestFullscreen();
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      } catch (e) { toast('Full screen was blocked'); }
    } else {
      toast('iPhone: tap Share, then "Add to Home Screen", and open it from there for full screen.', 6000);
    }
  }

  // ------------------------------------------------------------- game actions
  function tap(u, b) {
    const g = S.game;
    const ev = {
      id: 'tmp' + Math.random(), game_id: g.id, epoch: g.epoch, voided: false,
      game_player_id: g.teams > 0 ? null : u.key, team: g.teams > 0 ? u.team : null,
      label: b.label, points: b.points, stat: b.stat || null, attempt: !!b.attempt,
    };
    S.events.push(ev);
    renderGame();
    if (navigator.vibrate) navigator.vibrate(8);
    api.addEvent(ev).then(scheduleRefresh).catch((e) => {
      S.events = S.events.filter((x) => x !== ev);
      renderGame();
      fail(e);
    });
  }
  const doUndo = () => api.undo(S.game).then(refresh).catch(fail);
  const doRedo = () => api.redo(S.game).then(refresh).catch(fail);

  async function doReset() {
    const ok = await confirmDialog({
      title: 'Reset game?',
      message: 'All scores go back to zero for everyone in this game. Nothing is saved to stats.',
      ok: 'Reset',
    });
    if (!ok) return;
    try { await api.resetGame(S.game); await refresh(); } catch (e) { fail(e); }
  }

  async function doFinish(manual) {
    const { g, cfg, units, totals, rows, auto } = currentState();
    if (!rows.length) return toast('Add some players first');
    const outcome = auto.over ? auto : L.evaluate(cfg, rows, true);
    const nm = (keys) => keys.map((k) => units.find((u) => u.key === k).name).join(' & ');
    const who = outcome.draw ? 'Result: draw.' : 'Winner: ' + nm(outcome.winners) + '.';
    if (g.practice) {
      return toast('Practice game: ' + who + ' Nothing is saved.', 5000);
    }
    const ok = await confirmDialog({
      title: 'Finish game?',
      message: who + ' This will be saved to player stats and can’t be undone.',
      ok: 'Finish & save',
    });
    if (!ok) return;
    try {
      await api.finishGame(g, L.buildResult(g, units, totals, outcome));
      await refresh();
    } catch (e) { fail(e); }
  }

  async function doTogglePractice() {
    const g = S.game;
    if (g.practice) {
      const ok = await confirmDialog({
        title: 'Turn off practice mode?',
        message: 'This game will count toward player stats when it finishes. Current scores stay as they are. Reset first if you want a clean start.',
        ok: 'Turn off',
      });
      if (!ok) return;
    }
    try { await api.setPractice(g.id, !g.practice); await refresh(); } catch (e) { fail(e); }
  }

  function openMenu() {
    const g = S.game;
    modal((close) => {
      const act = (label, fn) => h('button', { class: 'btn wide', onclick: () => { close(); fn(); } }, label);
      return h('div', { class: 'mbody' },
        h('h2', {}, g.game_name + ' · ' + g.code),
        h('div', { class: 'stack' },
          act('Players' + (g.teams > 0 ? ' & teams' : ''), openRoster),
          act(g.practice ? 'Turn practice mode OFF' : 'Turn practice mode ON', doTogglePractice),
          act('Reset game', doReset),
          g.status === 'playing' && act('Finish game', () => doFinish(true)),
          act('Leave game', () => leaveGame()),
          h('button', { class: 'btn ghost wide', onclick: close }, 'Close')));
    });
  }

  // ------------------------------------------------------------------- roster
  let knownPlayers = [];
  async function openRoster() {
    try { knownPlayers = await api.listPlayers(); } catch (e) { knownPlayers = []; }
    const listId = 'pl' + Date.now();
    const list = h('div', { class: 'rlist' });
    const input = h('input', { class: 'input', placeholder: 'Player name', maxlength: '24', list: listId, autocomplete: 'off' });
    const datalist = h('datalist', { id: listId }, knownPlayers.map((p) => h('option', { value: p.name })));
    const add = async () => {
      const name = input.value.trim();
      if (!name) return;
      if (S.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) { toast(name + ' is already in this game'); return; }
      input.value = '';
      try {
        const p = await api.findOrCreatePlayer(name);
        let team = 1;
        if (S.game.teams > 0) {
          const counts = Array.from({ length: S.game.teams }, (_, i) => S.players.filter((x) => x.team === i + 1).length);
          team = counts.indexOf(Math.min(...counts)) + 1;
        }
        await api.addGamePlayer(S.game.id, p, team, S.players.length);
        await refresh();
      } catch (e) { fail(e); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

    const draw = () => {
      list.replaceChildren(...(S.players.length ? S.players.map((p) => h('div', { class: 'rrow' },
        h('span', { class: 'rname' }, p.name),
        S.game.teams > 0 && h('select', {
          class: 'input small', 'aria-label': 'Team for ' + p.name,
          onchange: (e) => api.setPlayerTeam(p.id, Number(e.target.value)).then(refresh).catch(fail),
        }, Array.from({ length: S.game.teams }, (_, i) => h('option', { value: String(i + 1), selected: p.team === i + 1 }, 'Team ' + (i + 1)))),
        h('button', {
          class: 'icon small', 'aria-label': 'Remove ' + p.name,
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Remove ' + p.name + '?',
              message: 'Their points in this game are removed too.',
              ok: 'Remove',
            });
            if (ok) api.removeGamePlayer(p.id).then(refresh).catch(fail);
          },
        }, '✕'))) : [h('p', { class: 'muted' }, 'Nobody yet. Add a name below. Known names pull up their stats automatically.')]));
    };

    const m = modal((close) => h('div', { class: 'mbody' },
      h('h2', {}, 'Players'),
      list,
      h('div', { class: 'addrow' }, input, datalist, h('button', { class: 'btn', onclick: add }, 'Add')),
      S.game.teams > 0 && h('p', { class: 'muted' }, 'Pick each person’s team. Scores are kept per team.'),
      h('div', { class: 'mrow' }, h('button', { class: 'btn', onclick: close }, 'Done'))),
    { onClose: () => { S.hooks = S.hooks.filter((f) => f !== draw); } });
    S.hooks.push(draw);
    draw();
    return m;
  }

  // -------------------------------------------------------------------- stats
  async function renderStats() {
    show('stats', h('main', { class: 'page' }, h('p', { class: 'muted' }, 'Loading…')));
    let players, results;
    try { [players, results] = await Promise.all([api.listPlayers(), api.listResults()]); } catch (e) { fail(e); return renderHome(); }

    const pSel = h('select', { class: 'input' }, players.map((p) => h('option', { value: p.id }, p.name)));
    const opts = L.gameOptions(results);
    const gSel = h('select', { class: 'input' }, h('option', { value: '' }, 'All games'), opts.map((o) => h('option', { value: o.key }, o.name)));
    const vsSel = h('select', { class: 'input' });
    const out = h('div', { class: 'statout' });

    const card = (label, value, sub) => h('div', { class: 'stat' }, h('div', { class: 'sv' }, value), h('div', { class: 'sl' }, label), sub && h('div', { class: 'ss' }, sub));
    const pct = (n) => (Math.round(n * 10) / 10) + '%';

    const draw = () => {
      const pid = pSel.value, key = gSel.value || null;
      // refresh opponent list
      const prev = vsSel.value;
      vsSel.replaceChildren(h('option', { value: '' }, 'Head to head…'),
        ...players.filter((p) => p.id !== pid).map((p) => h('option', { value: p.id }, 'vs ' + p.name)));
      vsSel.value = prev && prev !== pid ? prev : '';

      if (!pid) { out.replaceChildren(h('p', { class: 'muted' }, 'No players yet. Finish a game and they’ll show up here.')); return; }
      const s = L.playerStats(results, pid, key);
      if (!s.played) { out.replaceChildren(h('p', { class: 'muted' }, 'No finished games yet for this selection.')); }
      else {
        const cs = Object.entries(s.counters);
        out.replaceChildren(
          h('div', { class: 'stats' },
            card('Games', s.played),
            card('Wins', s.wins),
            card('Losses', s.losses),
            card('Draws', s.draws),
            card('Win %', pct(s.winPct)),
            card('Total points', fmt(s.totalPoints)),
            card('Avg / game', fmt(s.avgPoints)),
            card('High', fmt(s.high)),
            card('Low', fmt(s.low)),
            card('Win streak', s.streak, 'best ' + s.bestStreak),
            card('Last played', new Date(s.lastPlayed).toLocaleDateString())),
          cs.length > 0 && h('h3', {}, 'Counted'),
          cs.length > 0 && h('div', { class: 'stats' }, cs.map(([k, v]) =>
            card(k, v, s.attempts > 0 ? pct((v / s.attempts) * 100) + ' of ' + s.attempts + ' throws' : null))));
      }
      if (vsSel.value) {
        const hh = L.headToHead(results, pid, vsSel.value, key);
        const them = players.find((p) => p.id === vsSel.value).name;
        const me = players.find((p) => p.id === pid).name;
        out.appendChild(h('div', { class: 'h2h' }, h('h3', {}, 'Head to head'),
          hh.games ? h('p', {}, me + ' ' + hh.aWins + ' – ' + hh.bWins + ' ' + them + (hh.draws ? ' (' + hh.draws + ' draws)' : '') + ' in ' + hh.games + ' games') : h('p', { class: 'muted' }, 'No games between them yet.')));
      }
    };
    [pSel, gSel, vsSel].forEach((el) => el.addEventListener('change', draw));

    show('stats', h('main', { class: 'page' },
      h('div', { class: 'phead' }, h('button', { class: 'btn ghost small', onclick: renderHome }, '← Home'), h('h1', {}, 'Stats')),
      h('div', { class: 'filters' }, pSel, gSel, vsSel), out));
    draw();
  }

  // ------------------------------------------------------------------- editor
  const TEMPLATES = {
    'Simple counter': { buttons: [{ label: '+1', points: 1 }, { label: '−1', points: -1 }], direction: 'high', target: null, winBy: 0, tie: 'continue' },
    'Bottle Flip': { buttons: [{ label: '+1', points: 1, attempt: true }, { label: '−1', points: -1 }, { label: 'LINE', points: 0, stat: 'Line', attempt: true }, { label: 'MISS', points: 0, attempt: true }], direction: 'high', target: null, winBy: 0, tie: 'continue' },
    'Race to 11, win by 2': { buttons: [{ label: '+1', points: 1 }, { label: '−1', points: -1 }], direction: 'high', target: 11, winBy: 2, tie: 'continue' },
    'Euchre (first to 10)': { buttons: [{ label: '+1', points: 1 }, { label: '+2', points: 2 }, { label: '+4', points: 4 }, { label: '−1', points: -1 }], direction: 'high', target: 10, winBy: 0, tie: 'continue' },
    'Uno (lowest wins, 500 limit)': { buttons: [{ label: '+10', points: 10 }, { label: '+25', points: 25 }, { label: '+50', points: 50 }, { label: '+100', points: 100 }, { label: '−10', points: -10 }], direction: 'low', target: 500, winBy: 0, tie: 'continue' },
  };

  async function renderEditorGate() {
    if (S.pin) return renderEditor();
    let isSet;
    try { isSet = await api.pinIsSet(); } catch (e) { return fail(e); }
    const p1 = h('input', { class: 'input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', placeholder: isSet ? 'PIN' : 'New PIN', autocomplete: 'off' });
    const p2 = h('input', { class: 'input', type: 'password', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Type it again', autocomplete: 'off' });
    const go = async () => {
      const pin = p1.value;
      if (!/^\d+$/.test(pin)) return toast('Digits only');
      try {
        if (!isSet) {
          if (pin !== p2.value) return toast('The two PINs don’t match');
          await api.setPin(pin);
        } else if (!(await api.checkPin(pin))) return toast('Wrong PIN');
        S.pin = pin;
        renderEditor();
      } catch (e) { fail(e); }
    };
    [p1, p2].forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); }));
    show('editor', h('main', { class: 'page narrow' },
      h('div', { class: 'phead' }, h('button', { class: 'btn ghost small', onclick: renderHome }, '← Home'), h('h1', {}, 'Game editor')),
      h('p', {}, isSet ? 'Enter your editor PIN.' : 'First time here. Pick a PIN (digits only) and enter it twice.'),
      h('div', { class: 'stack' }, p1, !isSet && p2, h('button', { class: 'btn', onclick: go }, isSet ? 'Unlock' : 'Set PIN'))));
    p1.focus();
  }

  async function renderEditor() {
    let types;
    try { types = await api.listGameTypes(); } catch (e) { return fail(e); }
    const tpl = h('select', { class: 'input' }, h('option', { value: '' }, 'Start from…'), Object.keys(TEMPLATES).map((k) => h('option', { value: k }, k)));
    show('editor', h('main', { class: 'page narrow' },
      h('div', { class: 'phead' }, h('button', { class: 'btn ghost small', onclick: renderHome }, '← Home'), h('h1', {}, 'Game editor')),
      h('div', { class: 'stack' },
        types.length ? types.map((t) => h('div', { class: 'lrow' },
          h('span', { class: 'rname' }, t.name),
          h('button', { class: 'btn small', onclick: () => renderEditForm(t) }, 'Edit'),
          h('button', {
            class: 'btn ghost small',
            onclick: async () => {
              const ok = await confirmDialog({ title: 'Delete ' + t.name + '?', message: 'The game type is removed. Past results and saved stats are kept.', ok: 'Delete' });
              if (!ok) return;
              try { await api.deleteGameType(S.pin, t.id); renderEditor(); } catch (e) { fail(e); }
            },
          }, 'Delete'))) : h('p', { class: 'muted' }, 'No games yet. Make your first one below.'),
        h('div', { class: 'row2' }, tpl, h('button', {
          class: 'btn',
          onclick: () => renderEditForm({ id: null, name: tpl.value && tpl.value.split(' (')[0].split(',')[0] || '', config: TEMPLATES[tpl.value] || L.DEFAULT_CONFIG }),
        }, 'New game')))));
  }

  function renderEditForm(t) {
    const d = { id: t.id, name: t.name, config: JSON.parse(JSON.stringify(L.normalizeConfig(t.config))) };
    const c = d.config;
    const numIn = (val, set, ph) => h('input', { class: 'input small', type: 'number', step: 'any', value: val == null ? '' : val, placeholder: ph || '', oninput: (e) => set(e.target.value) });

    const buttonsBox = h('div', { class: 'blist' });
    const drawButtons = () => buttonsBox.replaceChildren(
      h('div', { class: 'bhead' }, h('span', {}, 'Button text'), h('span', {}, 'Points'), h('span', {}, 'Count as (optional)'), h('span', { title: 'Counts toward attempts for percentages' }, 'Attempt'), h('span', {})),
      ...c.buttons.map((b, i) => h('div', { class: 'brow' },
        h('input', { class: 'input small', value: b.label, placeholder: '+1', maxlength: '12', oninput: (e) => { b.label = e.target.value; } }),
        numIn(b.points, (v) => { b.points = Number(v) || 0; }, '0'),
        h('input', { class: 'input small', value: b.stat, placeholder: 'e.g. Line', maxlength: '20', oninput: (e) => { b.stat = e.target.value; } }),
        h('input', { type: 'checkbox', checked: b.attempt, 'aria-label': 'Counts as an attempt', onchange: (e) => { b.attempt = e.target.checked; } }),
        h('button', { class: 'icon small', 'aria-label': 'Remove button', onclick: () => { if (c.buttons.length > 1) { c.buttons.splice(i, 1); drawButtons(); } else toast('Keep at least one button'); } }, '✕'))),
      h('button', { class: 'btn ghost small', onclick: () => { c.buttons.push({ label: '', points: 1, stat: '', attempt: false }); drawButtons(); } }, '+ Add button'));
    drawButtons();

    const nameIn = h('input', { class: 'input', value: d.name, maxlength: '40', placeholder: 'Game name', oninput: (e) => { d.name = e.target.value; } });
    const dir = h('select', { class: 'input', onchange: (e) => { c.direction = e.target.value; } },
      h('option', { value: 'high', selected: c.direction === 'high' }, 'Highest score wins'),
      h('option', { value: 'low', selected: c.direction === 'low' }, 'Lowest score wins'));
    const tie = h('select', { class: 'input', onchange: (e) => { c.tie = e.target.value; } },
      h('option', { value: 'continue', selected: c.tie === 'continue' }, 'Keep playing until someone leads'),
      h('option', { value: 'draw', selected: c.tie === 'draw' }, 'End as a draw'));

    const save = async (e) => {
      if (!d.name.trim()) return toast('Give the game a name');
      const cfg = L.normalizeConfig(c);
      cfg.buttons = cfg.buttons.map((b) => ({ ...b, label: b.label.trim() || sign(b.points) }));
      e.target.disabled = true;
      try { await api.saveGameType(S.pin, d.id, d.name, cfg); toast('Saved'); renderEditor(); }
      catch (err) { e.target.disabled = false; fail(err); if (/wrong pin/i.test(err.message)) { S.pin = null; renderEditorGate(); } }
    };

    show('editor', h('main', { class: 'page narrow' },
      h('div', { class: 'phead' }, h('button', { class: 'btn ghost small', onclick: renderEditor }, '← Back'), h('h1', {}, d.id ? 'Edit game' : 'New game')),
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn),
      h('h3', {}, 'Score buttons'),
      h('p', { class: 'muted' }, 'Points can be negative or 0. A button with a "Count as" name is tallied in that game’s stats (like “Line”), even at 0 points. Tick Attempt on the ones that count as a throw/try so stats can show percentages.'),
      buttonsBox,
      h('details', { open: c.target != null || c.direction === 'low' || undefined },
        h('summary', {}, 'Win rules'),
        h('label', { class: 'field' }, h('span', {}, 'Who wins'), dir),
        h('label', { class: 'field' }, h('span', {}, 'Target / limit score (blank = none)'), numIn(c.target, (v) => { c.target = v === '' ? null : Number(v); }, 'none')),
        h('p', { class: 'muted' }, 'Highest wins: reaching the target wins. Lowest wins: reaching the limit ends the game and the lowest score wins (like Uno). With no target, you end the game yourself.'),
        h('label', { class: 'field' }, h('span', {}, 'Must win by'), numIn(c.winBy || 0, (v) => { c.winBy = Number(v) || 0; }, '0')),
        h('label', { class: 'field' }, h('span', {}, 'If tied at the end'), tie)),
      h('div', { class: 'mrow' }, h('button', { class: 'btn ghost', onclick: renderEditor }, 'Cancel'), h('button', { class: 'btn', onclick: save }, 'Save'))));
  }

  // -------------------------------------------------------------------- start
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  renderHome();
})();
