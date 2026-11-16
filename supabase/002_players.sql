-- Player management (rename / delete), PIN protected.
-- Paste into Supabase -> SQL Editor -> Run. Safe to run more than once.

create or replace function sk_rename_player(p_pin text, p_id uuid, p_name text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not sk_check_pin(p_pin) then raise exception 'Wrong PIN'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'Name required'; end if;
  if exists (select 1 from sk_players where name_key = lower(trim(p_name)) and id <> p_id) then
    raise exception 'Another player already has that name';
  end if;
  update sk_players set name = trim(p_name) where id = p_id;
  update sk_game_players set name = trim(p_name) where player_id = p_id;
  -- keep saved results in step so old stats show the new name
  update sk_results r set players = (
    select jsonb_agg(case when e->>'player_id' = p_id::text
                          then jsonb_set(e, '{name}', to_jsonb(trim(p_name))) else e end)
    from jsonb_array_elements(r.players) e)
  where r.players @> jsonb_build_array(jsonb_build_object('player_id', p_id));
end $$;

create or replace function sk_delete_player(p_pin text, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not sk_check_pin(p_pin) then raise exception 'Wrong PIN'; end if;
  delete from sk_game_players where player_id = p_id;   -- leaves any live games (their taps go too)
  delete from sk_players where id = p_id;                -- saved results keep their old name
end $$;

revoke all on function sk_rename_player(text, uuid, text), sk_delete_player(text, uuid) from public;
grant execute on function sk_rename_player(text, uuid, text), sk_delete_player(text, uuid) to anon, authenticated;
