/* Supabase data layer. The UI only talks to window.SKAPI, so tests can swap it out. */
(function () {
  'use strict';
  if (window.SKAPI) return; // a test double was injected first

  const cfg = window.SK_CONFIG || {};
  const configured = !!(cfg.url && cfg.anonKey && window.supabase);
  const sb = configured ? window.supabase.createClient(cfg.url, cfg.anonKey) : null;

  function unwrap(res) {
    if (res.error) {
      const e = new Error(res.error.message || 'Request failed');
      e.code = res.error.code;
      throw e;
    }
    return res.data;
  }

  const randomCode = () => String(Math.floor(10000 + Math.random() * 90000));

  window.SKAPI = {
    configured,

    // ---- editor (PIN protected) ----
    async listGameTypes() {
      return unwrap(await sb.from('sk_game_types').select('*').order('name'));
    },
    async pinIsSet() { return unwrap(await sb.rpc('sk_pin_is_set')); },
    async setPin(pin) { return unwrap(await sb.rpc('sk_set_pin', { p_pin: pin })); },
    async checkPin(pin) { return unwrap(await sb.rpc('sk_check_pin', { p_pin: pin })); },
    async saveGameType(pin, id, name, config) {
      return unwrap(await sb.rpc('sk_save_game_type', { p_pin: pin, p_id: id || null, p_name: name, p_config: config }));
    },
    async deleteGameType(pin, id) {
      unwrap(await sb.rpc('sk_delete_game_type', { p_pin: pin, p_id: id }));
    },

    // ---- players ----
    async listPlayers() {
      return unwrap(await sb.from('sk_players').select('id,name').order('name'));
    },
    async renamePlayer(pin, id, name) {
      unwrap(await sb.rpc('sk_rename_player', { p_pin: pin, p_id: id, p_name: name }));
    },
    async deletePlayer(pin, id) {
      unwrap(await sb.rpc('sk_delete_player', { p_pin: pin, p_id: id }));
    },
    async findOrCreatePlayer(name) {
      name = name.trim();
      const key = name.toLowerCase();
      const find = async () => unwrap(await sb.from('sk_players').select('*').eq('name_key', key).maybeSingle());
      let p = await find();
      if (p) return p;
      const res = await sb.from('sk_players').insert({ name }).select().single();
      if (res.error) {
        if (res.error.code === '23505') return find(); // someone else just made it
        throw new Error(res.error.message);
      }
      return res.data;
    },

    // ---- live games ----
    async createGame({ gameType, teams, practice }) {
      try { await sb.rpc('sk_cleanup'); } catch (e) { /* cleanup is best effort */ }
      for (let i = 0; i < 10; i++) {
        const res = await sb.from('sk_games').insert({
          code: randomCode(),
          game_type_id: gameType.id || null,
          game_name: gameType.name,
          config: gameType.config,
          teams: teams || 0,
          practice: !!practice,
        }).select().single();
        if (!res.error) return res.data;
        if (res.error.code !== '23505') throw new Error(res.error.message);
      }
      throw new Error('Could not find a free game code. Try again.');
    },
    async loadGame(code) {
      const g = unwrap(await sb.from('sk_games').select('*').eq('code', code).maybeSingle());
      if (!g) return null;
      const [players, events] = await Promise.all([
        sb.from('sk_game_players').select('*').eq('game_id', g.id).order('position').order('created_at'),
        sb.from('sk_events').select('*').eq('game_id', g.id).eq('epoch', g.epoch).order('id'),
      ]);
      return { game: g, players: unwrap(players), events: unwrap(events) };
    },
    async setPractice(gameId, practice) {
      unwrap(await sb.from('sk_games').update({ practice }).eq('id', gameId));
    },
    async addGamePlayer(gameId, player, team, position) {
      const res = await sb.from('sk_game_players')
        .insert({ game_id: gameId, player_id: player.id, name: player.name, team: team || 1, position: position || 0 });
      if (res.error && res.error.code !== '23505') throw new Error(res.error.message); // already in the game
    },
    async setPlayerTeam(gpId, team) {
      unwrap(await sb.from('sk_game_players').update({ team }).eq('id', gpId));
    },
    async removeGamePlayer(gpId) {
      unwrap(await sb.from('sk_game_players').delete().eq('id', gpId));
    },

    // ---- scoring ----
    async addEvent(ev) {
      const row = {
        game_id: ev.game_id, epoch: ev.epoch, game_player_id: ev.game_player_id || null, team: ev.team || null,
        label: ev.label, points: ev.points, stat: ev.stat || null, attempt: !!ev.attempt,
      };
      unwrap(await sb.from('sk_events').insert(row));
    },
    async undo(game) {
      const rows = unwrap(await sb.from('sk_events').select('id').eq('game_id', game.id).eq('epoch', game.epoch)
        .eq('voided', false).order('id', { ascending: false }).limit(1));
      if (!rows.length) return;
      unwrap(await sb.from('sk_events').update({ voided: true }).eq('id', rows[0].id));
    },
    async redo(game) {
      const live = unwrap(await sb.from('sk_events').select('id').eq('game_id', game.id).eq('epoch', game.epoch)
        .eq('voided', false).order('id', { ascending: false }).limit(1));
      const lastLive = live.length ? live[0].id : 0;
      const rows = unwrap(await sb.from('sk_events').select('id').eq('game_id', game.id).eq('epoch', game.epoch)
        .eq('voided', true).gt('id', lastLive).order('id').limit(1));
      if (!rows.length) return;
      unwrap(await sb.from('sk_events').update({ voided: false }).eq('id', rows[0].id));
    },
    async resetGame(game) {
      unwrap(await sb.from('sk_games').update({ epoch: game.epoch + 1, status: 'playing' }).eq('id', game.id));
    },
    async finishGame(game, result) {
      const res = await sb.from('sk_results').insert(result);
      if (res.error && res.error.code !== '23505') throw new Error(res.error.message); // already saved
      unwrap(await sb.from('sk_games').update({ status: 'finished' }).eq('id', game.id));
    },
    async listResults() {
      return unwrap(await sb.from('sk_results').select('*').order('finished_at', { ascending: false }).limit(2000));
    },

    // ---- live updates ----
    subscribe(gameId, cb) {
      const ch = sb.channel('game-' + gameId);
      [['sk_games', 'id'], ['sk_game_players', 'game_id'], ['sk_events', 'game_id']].forEach(([table, col]) => {
        ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: col + '=eq.' + gameId }, cb);
      });
      ch.subscribe();
      return () => { sb.removeChannel(ch); };
    },
  };
})();
