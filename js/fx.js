/* Broadcast-style effects: score roll + pop, floating +N/-N, button call-outs
   (LINE, MISS, ...), hot streaks, an intro splash, and the victory show.

   Effects live in their own #fx layer, so redraws of the game screen never cut
   them short. They are driven by *what changed* between renders, so taps from
   other devices (and undo) animate the same way as your own taps. */
(function () {
  'use strict';
  const L = window.SKLogic;
  const KEY = 'sk_fx';
  const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function enabled() {
    try {
      const v = localStorage.getItem(KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) { /* storage blocked */ }
    return !reduce;
  }
  function setEnabled(on) {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* ignore */ }
    document.body.classList.toggle('fx-off', !on);
    if (!on) clearLayer();
  }
  document.body.classList.toggle('fx-off', !enabled());

  // ---------------------------------------------------------------- plumbing
  let layer = null;
  function getLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.id = 'fx';
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    return layer;
  }
  function clearLayer() { if (layer) layer.replaceChildren(); }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const sel = (key) => '.panel[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]';
  const midRect = (key) => { const m = document.querySelector(sel(key) + ' .mid'); return m ? m.getBoundingClientRect() : null; };
  const scoreEl = (key) => document.querySelector(sel(key) + ' .score');
  function place(node, r) {
    node.style.left = r.left + 'px'; node.style.top = r.top + 'px';
    node.style.width = r.width + 'px'; node.style.height = r.height + 'px';
  }
  function later(node, ms) { setTimeout(() => node.remove(), ms); }
  const fmt = (n) => String(L.round(n));

  // ------------------------------------------------------------ score + delta
  const shown = {}, rolls = {};

  function bump(key, from, to) {
    const node = scoreEl(key);
    if (!node) return;
    const start = shown[key] !== undefined ? shown[key] : from;
    cancelAnimationFrame(rolls[key]);
    node.classList.remove('bump-up', 'bump-down');
    void node.offsetWidth;
    node.classList.add(to > from ? 'bump-up' : 'bump-down');
    node.textContent = fmt(start);

    const t0 = performance.now(), dur = 520;
    const ints = Number.isInteger(start) && Number.isInteger(to);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      let v = start + (to - start) * e;
      v = ints ? Math.round(v) : L.round(v);
      shown[key] = v;
      const cur = scoreEl(key);
      if (cur) cur.textContent = p >= 1 ? fmt(to) : String(v);
      if (p < 1) rolls[key] = requestAnimationFrame(step); else delete shown[key];
    };
    rolls[key] = requestAnimationFrame(step);

    const r = midRect(key);
    if (!r) return;
    const d = L.round(to - from);
    const box = el('div', 'fx-delta ' + (d > 0 ? 'up' : 'down'));
    place(box, r);
    const t = el('span', null, (d > 0 ? '+' : '') + fmt(d).replace('-', '−'));
    t.style.fontSize = Math.max(26, Math.min(r.height * 0.32, 90)) + 'px';
    t.style.setProperty('--dx', Math.round((Math.random() - 0.5) * 40) + 'px');
    box.appendChild(t);
    getLayer().appendChild(box);
    later(box, 1100);
  }

  // ----------------------------------------------------------------- callouts
  const MISSY = /miss|whiff|oops|foul|fault|out|drop/i;
  const numericish = (s) => /^[+−\-–]?\s*\d+(\.\d+)?$/.test((s || '').trim());

  function callout(key, text, kind) {
    const r = midRect(key);
    if (!r || !text) return;
    document.querySelectorAll('#fx .fx-callout[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]').forEach((n) => n.remove());
    const box = el('div', 'fx-callout ' + kind);
    box.dataset.key = key;
    place(box, r);
    const t = el('span', null, String(text).toUpperCase());
    const len = Math.max(3, text.length);
    t.style.fontSize = Math.max(22, Math.min(r.height * 0.36, r.width / (len * 0.55), 110)) + 'px';
    box.appendChild(t);
    getLayer().appendChild(box);
    later(box, 1700);
  }

  // ----------------------------------------------------------------- confetti
  function confetti(cx, cy) {
    const cv = el('canvas', 'fx-confetti');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const cols = ['#c92a2a', '#f2c14e', '#ffffff', '#ff6b6b', '#ffd97a'];
    const ps = Array.from({ length: 150 }, () => {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15, sp = 6 + Math.random() * 11;
      return { x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, w: 6 + Math.random() * 7, h: 3 + Math.random() * 5,
        r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, c: cols[(Math.random() * cols.length) | 0], life: 0 };
    });
    let last = performance.now();
    const end = last + 4200;
    const frame = (now) => {
      const dt = Math.min(32, now - last) / 16.7; last = now;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = 0;
      ps.forEach((p) => {
        p.vy += 0.28 * dt; p.vx *= 0.995; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life += dt;
        if (p.y < innerHeight + 20 && p.life < 260) {
          alive++;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
          ctx.globalAlpha = Math.max(0, 1 - p.life / 260); ctx.fillStyle = p.c;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
        }
      });
      if (alive && now < end && cv.isConnected) requestAnimationFrame(frame); else cv.remove();
    };
    requestAnimationFrame(frame);
    return cv;
  }

  // ------------------------------------------------------------------ victory
  function clearVictory() { document.querySelectorAll('#fx .fx-victory').forEach((n) => n.remove()); }

  function victory(winnerKeys, draw, names) {
    clearVictory();
    const v = el('div', 'fx-victory' + (draw ? ' draw' : ''));
    v.appendChild(el('div', 'vburst'));
    const banner = el('div', 'vbanner');
    banner.appendChild(el('div', 'vtitle', draw ? 'DRAW' : 'VICTORY'));
    banner.appendChild(el('div', 'vname', (names || []).join(' & ')));
    v.appendChild(banner);
    getLayer().appendChild(v);
    if (!draw) {
      const r = winnerKeys.length ? midRect(winnerKeys[0]) : null;
      v.appendChild(confetti(r ? r.left + r.width / 2 : innerWidth / 2, r ? r.top + r.height * 0.55 : innerHeight * 0.6));
      if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 140]);
    }
    later(v, 5200);
  }

  // -------------------------------------------------------------------- intro
  function intro(gameName, names) {
    const box = el('div', 'fx-intro');
    if (names.length === 2) {
      const a = el('div', 'islab left'); a.appendChild(el('span', null, names[0]));
      const b = el('div', 'islab right'); b.appendChild(el('span', null, names[1]));
      box.append(a, el('div', 'ivs', 'VS'), b);
    } else {
      const a = el('div', 'islab left wide'); a.appendChild(el('span', null, names.join('  •  ')));
      box.appendChild(a);
    }
    box.appendChild(el('div', 'igame', gameName));
    getLayer().appendChild(box);
    later(box, 2600);
  }

  // ------------------------------------------------------------ idle ambience
  // After a quiet spell, the board breathes and a light sweep + "LIVE" lower
  // third glides by now and then, so it's clear the game is still running.
  const cfg = { idleMs: 12000, everyMs: 18000 };
  let lastAct = Date.now(), nextSweep = 0, lastGame = null;

  function activity() {
    lastAct = Date.now(); nextSweep = 0;
    document.body.classList.remove('idle');
  }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, activity, true));

  function sweep() {
    const g = lastGame;
    const band = el('div', 'fx-sweep');
    getLayer().appendChild(band);
    later(band, 3200);
    if (g) {
      const low = el('div', 'fx-lower');
      low.appendChild(el('b', g.practice ? 'practice' : 'live', g.practice ? 'PRACTICE' : 'LIVE'));
      low.appendChild(el('span', null, g.game_name));
      low.appendChild(el('i', null, 'CODE ' + g.code));
      getLayer().appendChild(low);
      later(low, 4200);
    }
  }

  setInterval(() => {
    const body = document.body;
    if (!document.getElementById('game') || document.hidden || !enabled()) { body.classList.remove('idle'); return; }
    if (document.querySelector('dialog[open]') || document.querySelector('#fx .fx-victory') || document.querySelector('.overlay')) return;
    if (Date.now() - lastAct < cfg.idleMs) return;
    body.classList.add('idle');
    if (Date.now() >= nextSweep) { sweep(); nextSweep = Date.now() + cfg.everyMs; }
  }, 1000);

  // ------------------------------------------------------------------ the diff
  let snap = null;
  const introShown = {};

  function snapshot(ctx) {
    const counts = new Map(), meta = new Map(), seq = [];
    ctx.events.forEach((e) => {
      if (e.voided || e.epoch !== ctx.game.epoch) return;
      const unit = L.eventKey(e, ctx.game);
      const sig = unit + '|' + e.label + '|' + e.points + '|' + (e.stat || '');
      counts.set(sig, (counts.get(sig) || 0) + 1);
      meta.set(sig, { unit, label: e.label, points: Number(e.points) || 0, stat: e.stat || '' });
      seq.push({ unit, points: Number(e.points) || 0 });
    });
    const scores = {};
    ctx.rows.forEach((r) => { scores[r.key] = r.score; });
    return { key: ctx.key, counts, meta, seq, scores, over: ctx.auto.over, total: seq.length };
  }

  function run(ctx) {
    const cur = snapshot(ctx);
    const prev = snap && snap.key === ctx.key ? snap : null;
    snap = cur;
    lastGame = ctx.game;
    if (!prev || prev.total !== cur.total || JSON.stringify(prev.scores) !== JSON.stringify(cur.scores)) activity();

    if (!enabled()) return;

    // Intro splash: once per game/reset, as soon as players are in and no dialog is open.
    if (!introShown[ctx.key] && !document.querySelector('dialog[open]') && !ctx.finished) {
      const withPlayers = ctx.units.filter((u) => u.members.length);
      if (withPlayers.length && cur.total === 0) {
        introShown[ctx.key] = true;
        intro(ctx.game.game_name, withPlayers.map((u) => u.name));
        return;
      }
    }
    if (!prev) return;

    // Undoing the winning point cancels the victory show.
    if (prev.over && !cur.over) clearVictory();

    // Score changes: roll the number, pop it, float the +N / -N.
    Object.keys(cur.scores).forEach((k) => {
      const from = prev.scores[k], to = cur.scores[k];
      if (from !== undefined && from !== to) bump(k, from, to);
    });

    // New button presses: flash the button's name over that player's score.
    const fresh = [];
    cur.counts.forEach((n, sig) => {
      const add = n - (prev.counts.get(sig) || 0);
      for (let i = 0; i < add; i++) fresh.push(cur.meta.get(sig));
    });
    if (fresh.length <= 4) {
      fresh.forEach((m, i) => {
        const named = m.stat || !numericish(m.label);
        if (m.points !== 0 && !m.stat && numericish(m.label)) return;   // plain +N / -N: the delta says it all
        if (m.points !== 0 && !named) return;
        const text = numericish(m.label) && m.stat ? m.stat : (m.label || m.stat);
        if (!text || (numericish(text) && m.points !== 0)) return;
        const kind = MISSY.test(m.label + ' ' + m.stat) ? 'miss' : 'hit';
        setTimeout(() => callout(m.unit, text, kind), i * 180);
      });
    }

    // Hot streak: 3, 6, 9... scoring presses in a row by the same player/team.
    if (fresh.length === 1 && !(cur.over && !prev.over) && ctx.units.filter((u) => u.members.length).length > 1) {
      const last = cur.seq[cur.seq.length - 1];
      if (last && last.points > 0) {
        let run = 0;
        for (let i = cur.seq.length - 1; i >= 0 && cur.seq[i].unit === last.unit && cur.seq[i].points > 0; i--) run++;
        if (run >= 3 && run % 3 === 0) setTimeout(() => callout(last.unit, 'ON FIRE 🔥', 'fire'), 450);
      }
    }

    // The win.
    if (!prev.over && cur.over) {
      victory(ctx.auto.winners, ctx.auto.draw, ctx.auto.winners.map((k) => (ctx.units.find((u) => u.key === k) || {}).name).filter(Boolean));
    }
  }

  function reset() { snap = null; clearLayer(); }

  window.SKFX = { run, reset, enabled, setEnabled, cfg };
})();
