-- Reel / MediaOrg — V0.5 schema
-- Paste the whole file into Supabase → SQL Editor → Run.
--
-- Scope: two people, one shared list, one solo list each, half-star ratings,
-- notes, episode progress, and a six-shelf tier list.
--
-- Identity is provisional: a device picker, no auth. app_user.auth_id is the
-- hook for magic-link later — mapping an account onto an existing person is a
-- single UPDATE, and not one interaction row moves.

-- ---------------------------------------------------------------- people

create table if not exists app_user (
  id           uuid primary key default gen_random_uuid(),
  handle       text unique not null,
  display_name text not null,
  initial      char(1) not null,
  bar_colour   text not null,
  auth_id      uuid unique,              -- null until magic-link lands
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------- media snapshot (interim)
-- A thin denormalised cache so lists, tiers and the library render without
-- refetching TMDB. The spec's full `entity` / `entity_field` tables replace
-- this once the ingest pipeline exists; `key` is already the composite id
-- that the client's adapters emit, so the migration is a backfill, not a
-- rewrite.

create table if not exists media (
  key        text primary key,           -- 'tmdb:movie:1234', 'mal:52991', 'tvmaze:82'
  source     text not null,              -- tmdb | mal | tvmaze
  kind       text not null,              -- movie | show | anime | anime film
  title      text not null,
  year       int,
  poster     text,
  genres     text[] default '{}',
  updated_at timestamptz not null default now()
);

create index if not exists media_kind_idx on media (kind);

-- ----------------------------------------------------------- interactions
-- One row per (person, title, kind of opinion). The unique constraint makes
-- every write an upsert: re-rating a film replaces the rating rather than
-- appending a second one.

create table if not exists interaction (
  id         bigserial primary key,
  user_id    uuid not null references app_user(id) on delete cascade,
  media_key  text not null references media(key)   on delete cascade,
  kind       text not null check (kind in (
                'watched', 'rating', 'note',
                'playlist_shared', 'playlist_solo', 'progress',
                -- one person declining a title the other put forward alone;
                -- see passed.sql, which adds this to an existing deployment
                'passed')),
  value      jsonb,                      -- rating: 4.5 | note: "..." | progress: {"s":1,"e":12}
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, media_key, kind)
);

create index if not exists interaction_media_idx on interaction (media_key, kind);
create index if not exists interaction_user_idx  on interaction (user_id, kind, updated_at desc);

-- ------------------------------------------------------------------ tiers
-- Six shelves. Shelf 0 holds everything touched but unrated and carries null
-- bounds. Bands are lower-exclusive, upper-inclusive: "3 to 4" owns 3.5 and
-- 4.0, which is what gives 5.0 a home in the top shelf.
-- idx allows up to 10 so half-point granularity needs no migration.

create table if not exists tier (
  user_id     uuid not null references app_user(id) on delete cascade,
  idx         int not null check (idx between 0 and 10),
  label       text not null,
  lower_bound numeric(2,1),
  upper_bound numeric(2,1),
  primary key (user_id, idx),
  constraint tier_zero_is_unbounded check ((idx = 0) = (lower_bound is null)),
  constraint tier_bounds_ordered   check (lower_bound is null or lower_bound <= upper_bound)
);

-- ------------------------------------------------------------------ views

-- The home screen: titles both people swiped into the shared list.
create or replace view mutual_match as
select
  i.media_key,
  max(i.created_at) as matched_at,
  count(distinct i.user_id) as want_count
from interaction i
where i.kind = 'playlist_shared'
group by i.media_key
having count(distinct i.user_id) >= 2;

-- Everything one person has touched, with provenance and their own rating.
create or replace view library as
select
  i.user_id,
  i.media_key,
  bool_or(i.kind = 'playlist_shared')                      as in_shared,
  bool_or(i.kind = 'playlist_solo')                        as in_solo,
  bool_or(i.kind = 'watched')                              as watched,
  max(case when i.kind = 'rating'
           then (i.value #>> '{}')::numeric end)           as rating,
  max(i.updated_at)                                        as touched_at
from interaction i
group by i.user_id, i.media_key;

-- ------------------------------------------------------------------- seed

insert into app_user (handle, display_name, initial, bar_colour) values
  ('arnish', 'Arnish', 'A', '#1D9E75'),
  ('two',    'Second', 'B', '#7F77DD')
on conflict (handle) do nothing;

-- Six shelves for everyone who exists.
insert into tier (user_id, idx, label, lower_bound, upper_bound)
select u.id, t.idx, t.label, t.lo, t.hi
from app_user u
cross join (values
  (0, 'Unrated', null::numeric, null::numeric),
  (1, 'No',      0.0, 1.0),
  (2, 'Weak',    1.0, 2.0),
  (3, 'Fine',    2.0, 3.0),
  (4, 'Strong',  3.0, 4.0),
  (5, 'Canon',   4.0, 5.0)
) as t(idx, label, lo, hi)
on conflict (user_id, idx) do nothing;

-- ------------------------------------------------------- row-level security
--
-- Read this before running it.
--
-- RLS is enabled, but with a device picker there is no authenticated user, so
-- these policies grant the anon role full access. That is not security; it is
-- RLS switched on with the door held open, so that turning auth on later is a
-- policy change rather than a schema change.
--
-- Concretely: anyone holding the publishable key and the project URL can read
-- and write these tables. Both will sit in a public repo. The data is film
-- opinions, so the impact is low, but it is genuinely open.
--
-- When magic-link lands, replace each policy body with
--   using (user_id = (select id from app_user where auth_id = auth.uid()))
-- and the model becomes real.

alter table app_user    enable row level security;
alter table media       enable row level security;
alter table interaction enable row level security;
alter table tier        enable row level security;

drop policy if exists open_app_user    on app_user;
drop policy if exists open_media       on media;
drop policy if exists open_interaction on interaction;
drop policy if exists open_tier        on tier;

create policy open_app_user    on app_user    for all using (true) with check (true);
create policy open_media       on media       for all using (true) with check (true);
create policy open_interaction on interaction for all using (true) with check (true);
create policy open_tier        on tier        for all using (true) with check (true);
