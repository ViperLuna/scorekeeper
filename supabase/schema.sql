-- =====================================================================
-- Scorekeeper database setup
-- Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------

-- Holds the editor PIN (hashed). Nobody can read this table through the API.
create table if not exists sk_settings (
  id int primary key default 1 check (id = 1),
  pin_hash text not null
);

-- Game types made in the editor (name + buttons + rules).
create table if not exists sk_game_types (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text generated always as (lower(trim(name))) stored unique,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Permanent player profiles. Just a name.
create table if not exists sk_players (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_key text generated always as (lower(trim(name))) stored unique,
  created_at timestamptz not null default now()
);

-- Live games. Found by the 5 digit code. Auto-deleted when stale.
create table if not exists sk_games (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  game_type_id uuid references sk_game_types(id) on delete set null,
  game_name text not null,
  config jsonb not null,
  teams int not null default 0,
  practice boolean not null default false,
  status text not null default 'playing' check (status in ('playing', 'finished')),
  epoch int not null default 0,          -- bumped by "Reset game"
  created_at timestamptz not null default now(),
  last_active timestamptz not null default now()
);

-- Who is in a live game.
create table if not exists sk_game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references sk_games(id) on delete cascade,
  player_id uuid not null references sk_players(id),
  name text not null,
  team int not null default 1,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (game_id, player_id)
);

-- Every button tap is one row. Scores are totalled from these, so two people
-- tapping at the same moment never overwrite each other.
create table if not exists sk_events (
  id bigint generated always as identity primary key,
  game_id uuid not null references sk_games(id) on delete cascade,
  epoch int not null default 0,
  game_player_id uuid references sk_game_players(id) on delete cascade,
  team int,
  label text not null,
  points numeric not null default 0,
  stat text,
  attempt boolean not null default false,
  voided boolean not null default false,  -- undo flips this
  created_at timestamptz not null default now()
);
create index if not exists sk_events_game_idx on sk_events (game_id, epoch, id);

-- One permanent row per finished (non-practice) game. Stats are calculated from these.
create table if not exists sk_results (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null,
  epoch int not null default 0,
  game_type_id uuid references sk_game_types(id) on delete set null,
  game_name text not null,
  direction text not null default 'high',
  teams int not null default 0,
  players jsonb not null,
  finished_at timestamptz not null default now(),
  unique (game_id, epoch)
);

-- ---------------------------------------------------------------------
-- Keep games "alive" while people are tapping
-- ---------------------------------------------------------------------
create or replace function sk_touch_game() returns trigger
language plpgsql as $$
begin
  update sk_games set last_active = now() where id = new.game_id;
  return new;
end $$;

drop trigger if exists sk_events_touch on sk_events;
create trigger sk_events_touch after insert on sk_events
  for each row execute function sk_touch_game();

-- ---------------------------------------------------------------------
-- Auto-cleanup: live games untouched for 3 days are deleted (their events and
-- rosters go with them). Finished games already saved a row in sk_results,
-- and player profiles are never deleted. The app calls this whenever a new
-- game is created, so no scheduler is needed.
-- ---------------------------------------------------------------------
create or replace function sk_cleanup() returns void
language sql security definer set search_path = public as $$
  delete from sk_games where last_active < now() - interval '3 days';
$$;

-- ---------------------------------------------------------------------
-- Row Level Security: the public (anon) key can only do what the app needs.
-- ---------------------------------------------------------------------
alter table sk_settings     enable row level security;
alter table sk_game_types   enable row level security;
alter table sk_players      enable row level security;
alter table sk_games        enable row level security;
alter table sk_game_players enable row level security;
alter table sk_events       enable row level security;
alter table sk_results      enable row level security;

revoke all on sk_settings, sk_game_types, sk_players, sk_games,
              sk_game_players, sk_events, sk_results from anon, authenticated;

-- Game types: read only. Changes go through the PIN-checked functions below.
grant select on sk_game_types to anon, authenticated;
-- Players: look up and create. No renaming or deleting from the app.
grant select, insert on sk_players to anon, authenticated;
-- Live games.
grant select, insert, update on sk_games to anon, authenticated;
grant select, insert, update, delete on sk_game_players to anon, authenticated;
grant select, insert, update on sk_events to anon, authenticated;
-- Results: read and add. No editing from the app.
grant select, insert on sk_results to anon, authenticated;

do $$
declare t text;
begin
  for t in select unnest(array['sk_game_types','sk_players','sk_games','sk_game_players','sk_events','sk_results']) loop
    execute format('drop policy if exists "sk read" on %I', t);
    execute format('create policy "sk read" on %I for select to anon, authenticated using (true)', t);
  end loop;

  for t in select unnest(array['sk_players','sk_games','sk_game_players','sk_events','sk_results']) loop
    execute format('drop policy if exists "sk insert" on %I', t);
    execute format('create policy "sk insert" on %I for insert to anon, authenticated with check (true)', t);
  end loop;

  for t in select unnest(array['sk_games','sk_game_players','sk_events']) loop
    execute format('drop policy if exists "sk update" on %I', t);
    execute format('create policy "sk update" on %I for update to anon, authenticated using (true) with check (true)', t);
  end loop;

  drop policy if exists "sk delete" on sk_game_players;
  create policy "sk delete" on sk_game_players for delete to anon, authenticated using (true);
end $$;

-- ---------------------------------------------------------------------
-- PIN protected editor functions
-- ---------------------------------------------------------------------
create or replace function sk_pin_is_set() returns boolean
language sql security definer set search_path = public as $$
  select exists (select 1 from sk_settings);
$$;

create or replace function sk_set_pin(p_pin text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{1,32}$' then
    raise exception 'PIN must be 1-32 digits';
  end if;
  if exists (select 1 from sk_settings) then
    raise exception 'PIN is already set';
  end if;
  insert into sk_settings (id, pin_hash) values (1, crypt(p_pin, gen_salt('bf')));
  return true;
end $$;

create or replace function sk_check_pin(p_pin text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean;
begin
  select (pin_hash = crypt(coalesce(p_pin, ''), pin_hash)) into ok from sk_settings;
  if ok is not true then
    perform pg_sleep(0.7);  -- slows down guessing
    return false;
  end if;
  return true;
end $$;

create or replace function sk_save_game_type(p_pin text, p_id uuid, p_name text, p_config jsonb)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare new_id uuid;
begin
  if not sk_check_pin(p_pin) then raise exception 'Wrong PIN'; end if;
  if p_name is null or length(trim(p_name)) = 0 then raise exception 'Name required'; end if;
  if p_id is null then
    insert into sk_game_types (name, config) values (trim(p_name), p_config) returning id into new_id;
  else
    update sk_game_types set name = trim(p_name), config = p_config, updated_at = now()
      where id = p_id returning id into new_id;
  end if;
  return new_id;
end $$;

create or replace function sk_delete_game_type(p_pin text, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not sk_check_pin(p_pin) then raise exception 'Wrong PIN'; end if;
  delete from sk_game_types where id = p_id;
end $$;

revoke all on function sk_pin_is_set(), sk_set_pin(text), sk_check_pin(text),
  sk_save_game_type(text, uuid, text, jsonb), sk_delete_game_type(text, uuid),
  sk_cleanup() from public;
grant execute on function sk_pin_is_set(), sk_set_pin(text), sk_check_pin(text),
  sk_save_game_type(text, uuid, text, jsonb), sk_delete_game_type(text, uuid),
  sk_cleanup() to anon, authenticated;

-- ---------------------------------------------------------------------
-- Live updates
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array['sk_games','sk_game_players','sk_events']) loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- =====================================================================
-- Forgot your editor PIN? Run this, then open the editor and set a new one:
--   delete from sk_settings;
-- =====================================================================
