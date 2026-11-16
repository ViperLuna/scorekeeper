/* Scorekeeper rules + stats. Pure functions: no DOM, no network. */
(function (root) {
  'use strict';

  const DEFAULT_CONFIG = {
    buttons: [
      { label: '+1', points: 1, stat: '', attempt: false },
      { label: '−1', points: -1, stat: '', attempt: false },
    ],
    direction: 'high', // 'high' = highest score wins, 'low' = lowest wins
    target: null,      // score that triggers the end (null = no target)
    winBy: 0,          // required lead over second place
    tie: 'continue',   // 'continue' or 'draw' when tied at the end
  };

  const round = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

  function normalizeConfig(c) {
    c = c || {};
    const buttons = Array.isArray(c.buttons) && c.buttons.length
      ? c.buttons.map((b) => ({
          label: String(b.label == null ? '' : b.label),
          points: round(b.points),
          stat: String(b.stat || '').trim(),
          attempt: !!b.attempt,
        }))
      : DEFAULT_CONFIG.buttons.map((b) => ({ ...b }));
    const target = c.target === '' || c.target == null || isNaN(Number(c.target)) ? null : Number(c.target);
    return {
      buttons,
      direction: c.direction === 'low' ? 'low' : 'high',
      target,
      winBy: Math.max(0, Number(c.winBy) || 0),
      tie: c.tie === 'draw' ? 'draw' : 'continue',
    };
  }

  /** The things that get a score panel: each player, or each team. */
  function getUnits(game, players) {
    if (game.teams > 0) {
      const out = [];
      for (let t = 1; t <= game.teams; t++) {
        out.push({ key: 'team:' + t, name: 'Team ' + t, team: t, members: players.filter((p) => p.team === t) });
      }
      return out;
    }
    return players.map((p) => ({ key: p.id, name: p.name, team: null, members: [p] }));
  }

  function eventKey(ev, game) {
    return game.teams > 0 ? 'team:' + ev.team : ev.game_player_id;
  }

  /** Total up the (non-undone, current-round-of-reset) events per unit. */
  function foldEvents(events, game, units) {
    const totals = {};
    units.forEach((u) => { totals[u.key] = { score: 0, counters: {}, attempts: 0 }; });
    (events || []).forEach((ev) => {
      if (ev.voided || ev.epoch !== game.epoch) return;
      const t = totals[eventKey(ev, game)];
      if (!t) return;
      t.score = round(t.score + (Number(ev.points) || 0));
      if (ev.stat) t.counters[ev.stat] = (t.counters[ev.stat] || 0) + 1;
      if (ev.attempt) t.attempts += 1;
    });
    return totals;
  }

  /**
   * Decide whether the game is over.
   * rows: [{key, score}] (only units that actually have players)
   * manual: true when a person pressed "Finish game" (ignores target / win-by).
   * -> { over, draw, winners: [keys], message }
   */
  function evaluate(cfg, rows, manual) {
    cfg = normalizeConfig(cfg);
    const none = { over: false, draw: false, winners: [], message: '' };
    if (!rows.length) return none;

    if (!manual) {
      if (cfg.target == null) return none;
      if (!rows.some((r) => r.score >= cfg.target)) return none;
    }

    const sorted = rows.slice().sort((a, b) => (cfg.direction === 'low' ? a.score - b.score : b.score - a.score));
    const best = sorted[0].score;
    const tops = sorted.filter((r) => r.score === best);
    const rest = sorted.filter((r) => r.score !== best);

    if (tops.length > 1) {
      if (manual || cfg.tie === 'draw') {
        return { over: true, draw: true, winners: tops.map((r) => r.key), message: 'Draw' };
      }
      return { ...none, message: 'Tied — keep playing' };
    }

    if (!manual && cfg.winBy > 0 && rest.length && Math.abs(best - rest[0].score) < cfg.winBy) {
      return { ...none, message: 'Must win by ' + cfg.winBy };
    }
    return { over: true, draw: false, winners: [tops[0].key], message: '' };
  }

  /** The row saved permanently when a game finishes. */
  function buildResult(game, units, totals, outcome) {
    const cfg = normalizeConfig(game.config);
    const winners = new Set(outcome.winners);
    const players = [];
    units.forEach((u) => {
      if (!u.members.length) return;
      const t = totals[u.key];
      const result = winners.has(u.key) ? (outcome.draw ? 'draw' : 'win') : 'loss';
      u.members.forEach((p) => {
        players.push({
          player_id: p.player_id,
          name: p.name,
          team: game.teams > 0 ? u.team : null,
          score: t.score,
          result,
          counters: t.counters,
          attempts: t.attempts,
        });
      });
    });
    return {
      game_id: game.id,
      epoch: game.epoch,
      game_type_id: game.game_type_id || null,
      game_name: game.game_name,
      direction: cfg.direction,
      teams: game.teams,
      players,
    };
  }

  /** Undo / redo availability from the event list. */
  function undoState(events, game) {
    const cur = (events || []).filter((e) => e.epoch === game.epoch);
    const lastLive = cur.filter((e) => !e.voided).reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    return {
      canUndo: cur.some((e) => !e.voided),
      canRedo: cur.some((e) => e.voided && (Number(e.id) || 0) > lastLive),
    };
  }

  // ------------------------------------------------------------------ stats

  const gameKey = (r) => r.game_type_id || 'name:' + r.game_name;

  function gameOptions(results) {
    const seen = new Map();
    results.forEach((r) => { if (!seen.has(gameKey(r))) seen.set(gameKey(r), r.game_name); });
    return [...seen.entries()].map(([key, name]) => ({ key, name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  function playerStats(results, playerId, key) {
    const recs = results
      .filter((r) => !key || gameKey(r) === key)
      .map((r) => ({ r, p: (r.players || []).find((p) => p.player_id === playerId) }))
      .filter((x) => x.p)
      .sort((a, b) => new Date(a.r.finished_at) - new Date(b.r.finished_at));

    const s = {
      played: recs.length, wins: 0, losses: 0, draws: 0, winPct: 0,
      totalPoints: 0, avgPoints: 0, high: null, low: null,
      streak: 0, bestStreak: 0, lastPlayed: null, counters: {}, attempts: 0,
    };
    let run = 0;
    recs.forEach(({ r, p }) => {
      if (p.result === 'win') s.wins++; else if (p.result === 'draw') s.draws++; else s.losses++;
      s.totalPoints = round(s.totalPoints + p.score);
      s.high = s.high == null ? p.score : Math.max(s.high, p.score);
      s.low = s.low == null ? p.score : Math.min(s.low, p.score);
      run = p.result === 'win' ? run + 1 : 0;
      s.bestStreak = Math.max(s.bestStreak, run);
      s.lastPlayed = r.finished_at;
      Object.entries(p.counters || {}).forEach(([k, v]) => { s.counters[k] = (s.counters[k] || 0) + v; });
      s.attempts += p.attempts || 0;
    });
    s.streak = run;
    if (s.played) {
      s.winPct = (s.wins / s.played) * 100;
      s.avgPoints = round(s.totalPoints / s.played);
    }
    return s;
  }

  /** How A and B did against each other (games where they were on different sides). */
  function headToHead(results, aId, bId, key) {
    const out = { games: 0, aWins: 0, bWins: 0, draws: 0 };
    results.forEach((r) => {
      if (key && gameKey(r) !== key) return;
      const a = (r.players || []).find((p) => p.player_id === aId);
      const b = (r.players || []).find((p) => p.player_id === bId);
      if (!a || !b) return;
      if (r.teams > 0 && a.team === b.team) return;
      out.games++;
      if (a.result === 'win' && b.result !== 'win') out.aWins++;
      else if (b.result === 'win' && a.result !== 'win') out.bWins++;
      else out.draws++;
    });
    return out;
  }

  const api = {
    DEFAULT_CONFIG, normalizeConfig, getUnits, foldEvents, evaluate, buildResult,
    undoState, gameKey, gameOptions, playerStats, headToHead, round,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SKLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
