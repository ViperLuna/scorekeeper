// Run with: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../js/logic.js');

const ev = (key, points, extra) => ({ id: Math.random(), epoch: 0, voided: false, game_player_id: key, team: null, points, ...extra });
const game = { id: 'g', epoch: 0, teams: 0, game_name: 'T', config: L.DEFAULT_CONFIG };
const players = [{ id: 'a', player_id: 'pa', name: 'Viper', team: 1 }, { id: 'b', player_id: 'pb', name: 'Kid', team: 1 }];
const rowsOf = (events, g = game, ps = players) => {
  const units = L.getUnits(g, ps);
  const t = L.foldEvents(events, g, units);
  return { units, t, rows: units.map((u) => ({ key: u.key, score: t[u.key].score })) };
};

test('scores add up, undone events and old resets are ignored', () => {
  const events = [ev('a', 1), ev('a', 1), ev('b', -1), ev('a', 5, { voided: true }), ev('a', 9, { epoch: -1 })];
  const { t } = rowsOf(events);
  assert.equal(t.a.score, 2);
  assert.equal(t.b.score, -1);
});

test('no target: nothing ends automatically, manual finish picks leader', () => {
  const { rows } = rowsOf([ev('a', 3), ev('b', 1)]);
  assert.equal(L.evaluate(L.DEFAULT_CONFIG, rows, false).over, false);
  const m = L.evaluate(L.DEFAULT_CONFIG, rows, true);
  assert.deepEqual(m.winners, ['a']);
  assert.equal(m.draw, false);
});

test('highest wins: first to target wins', () => {
  const cfg = { ...L.DEFAULT_CONFIG, target: 10 };
  const o = L.evaluate(cfg, rowsOf([ev('a', 10), ev('b', 7)]).rows, false);
  assert.deepEqual(o.winners, ['a']);
  assert.equal(o.over, true);
});

test('Uno style: lowest wins when someone hits the limit', () => {
  const cfg = { ...L.DEFAULT_CONFIG, direction: 'low', target: 500 };
  assert.equal(L.evaluate(cfg, rowsOf([ev('a', 450), ev('b', 200)]).rows, false).over, false);
  const o = L.evaluate(cfg, rowsOf([ev('a', 510), ev('b', 200)]).rows, false);
  assert.equal(o.over, true);
  assert.deepEqual(o.winners, ['b']);
});

test('win by 2: 11-10 keeps going, 12-10 ends', () => {
  const cfg = { ...L.DEFAULT_CONFIG, target: 11, winBy: 2 };
  const a = L.evaluate(cfg, rowsOf([ev('a', 11), ev('b', 10)]).rows, false);
  assert.equal(a.over, false);
  assert.match(a.message, /win by 2/i);
  const b = L.evaluate(cfg, rowsOf([ev('a', 12), ev('b', 10)]).rows, false);
  assert.equal(b.over, true);
});

test('tie at the target: continue vs draw', () => {
  const rows = rowsOf([ev('a', 10), ev('b', 10)]).rows;
  assert.equal(L.evaluate({ ...L.DEFAULT_CONFIG, target: 10, tie: 'continue' }, rows, false).over, false);
  const d = L.evaluate({ ...L.DEFAULT_CONFIG, target: 10, tie: 'draw' }, rows, false);
  assert.equal(d.over, true);
  assert.equal(d.draw, true);
  assert.equal(d.winners.length, 2);
});

test('counters and attempts (bottle flip / fridge magnets)', () => {
  const events = [
    ev('a', 0, { stat: 'Line', attempt: true }),
    ev('a', 3, { stat: 'Zone 3', attempt: true }),
    ev('a', 0, { attempt: true }),
    ev('a', 0, { stat: 'Line', attempt: true, voided: true }),
  ];
  const { t } = rowsOf(events);
  assert.deepEqual(t.a.counters, { Line: 1, 'Zone 3': 1 });
  assert.equal(t.a.attempts, 3);
  assert.equal(t.a.score, 3);
});

test('teams: events and scores roll up per team', () => {
  const g = { ...game, teams: 2 };
  const ps = [{ id: 'a', player_id: 'pa', name: 'A', team: 1 }, { id: 'b', player_id: 'pb', name: 'B', team: 1 }, { id: 'c', player_id: 'pc', name: 'C', team: 2 }];
  const events = [{ id: 1, epoch: 0, voided: false, team: 1, game_player_id: null, points: 2 }, { id: 2, epoch: 0, voided: false, team: 2, game_player_id: null, points: 1 }];
  const { units, t } = rowsOf(events, g, ps);
  assert.equal(units.length, 2);
  assert.equal(t['team:1'].score, 2);
  const res = L.buildResult({ ...g, game_type_id: null }, units, t, { over: true, draw: false, winners: ['team:1'] });
  assert.equal(res.players.filter((p) => p.result === 'win').length, 2);
  assert.equal(res.players.find((p) => p.name === 'C').result, 'loss');
});

test('undo / redo availability', () => {
  const e = (id, voided) => ({ id, epoch: 0, voided });
  assert.deepEqual(L.undoState([], game), { canUndo: false, canRedo: false });
  assert.deepEqual(L.undoState([e(1, false), e(2, false)], game), { canUndo: true, canRedo: false });
  assert.deepEqual(L.undoState([e(1, false), e(2, true)], game), { canUndo: true, canRedo: true });
  // a newer live event clears redo
  assert.deepEqual(L.undoState([e(1, false), e(2, true), e(3, false)], game), { canUndo: true, canRedo: false });
});

test('player stats, streaks and head to head', () => {
  const r = (n, wa, wb) => ({
    game_id: 'g' + n, game_type_id: 't1', game_name: 'Darts', teams: 0, finished_at: '2026-01-0' + n,
    players: [
      { player_id: 'pa', name: 'A', score: 10 + n, result: wa, counters: { Line: 1 }, attempts: 4 },
      { player_id: 'pb', name: 'B', score: 5, result: wb, counters: {}, attempts: 0 },
    ],
  });
  const results = [r(1, 'win', 'loss'), r(2, 'win', 'loss'), r(3, 'loss', 'win'), r(4, 'draw', 'draw')];
  const s = L.playerStats(results, 'pa', null);
  assert.equal(s.played, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 1);
  assert.equal(s.draws, 1);
  assert.equal(s.winPct, 50);
  assert.equal(s.bestStreak, 2);
  assert.equal(s.streak, 0);
  assert.equal(s.counters.Line, 4);
  assert.equal(s.attempts, 16);
  assert.equal(s.high, 14);
  assert.equal(s.low, 11);
  const hh = L.headToHead(results, 'pa', 'pb', null);
  assert.deepEqual(hh, { games: 4, aWins: 2, bWins: 1, draws: 1 });
  assert.equal(L.playerStats(results, 'pa', 'name:Other').played, 0);
});
