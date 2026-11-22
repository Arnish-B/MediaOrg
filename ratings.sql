-- Reel / MediaOrg — external ratings with provenance
--
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
--
-- This is a deliberately narrow stand-in for the spec's `entity_field`. It
-- keeps the two properties that make that design worth having, and drops the
-- rest until the ingest pipeline exists:
--
--   1. Every value records WHERE it came from and WHEN. A number with no
--      source and no timestamp cannot be refreshed, cannot be audited, and
--      goes stale silently while still looking authoritative. That is the
--      whole reason this table exists rather than four columns on `media`.
--   2. `is_manual` wins over any fetcher, so a score you type in by hand is
--      never overwritten by a worker.
--
-- Migrating to the spec's `entity_field` later is a backfill, not a rewrite:
-- `media_key` maps to `entity_id`, `source` and `fetched_at` carry across
-- unchanged, and `scale` becomes implicit in the field name.
--
-- No foreign key to `media` on purpose. A rating is a fact about a title,
-- not about your relationship to it, so the ratings corner can cache a score
-- for something you only glanced at and never added to a list.

create table if not exists media_rating (
  media_key  text        not null,
  source     text        not null,   -- imdb | metacritic | tmdb | mal | tvmaze | letterboxd | rt
  value      numeric(5,1) not null,
  scale      text        not null,   -- '/10' | '/100' | '/5' | '%'
  votes      bigint,
  fetched_at timestamptz not null default now(),
  is_manual  boolean     not null default false,
  primary key (media_key, source)
);

-- Staleness sweeps read this: "every imdb row older than seven days".
create index if not exists media_rating_staleness
  on media_rating (source, fetched_at)
  where is_manual = false;

-- Same posture as the rest of the schema: RLS on, policies open, and said out
-- loud rather than implied. Anyone holding the publishable key can read and
-- write this table. The contents are public film scores, so the exposure is
-- nil, but it is genuinely open until magic-link auth lands.
alter table media_rating enable row level security;

drop policy if exists open_media_rating on media_rating;
create policy open_media_rating on media_rating for all using (true) with check (true);

-- Older deployments may predate the columns above; add them idempotently so a
-- re-run upgrades an existing table rather than failing.
alter table media_rating add column if not exists votes      bigint;
alter table media_rating add column if not exists is_manual  boolean not null default false;
alter table media_rating add column if not exists fetched_at timestamptz not null default now();
