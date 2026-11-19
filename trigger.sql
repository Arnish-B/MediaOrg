-- Reel / MediaOrg — rating implies watched
--
-- The client already writes both rows, but a client-side rule is a convention,
-- not a guarantee: any other writer, a retry that half-fails, or a future
-- import can leave a rating with no matching watched row. This makes it true
-- in the database instead.
--
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
--
-- The reverse does not hold, deliberately: a title can be watched with no
-- rating, which is the whole point of the eye icon.

create or replace function watched_follows_rating()
returns trigger
language plpgsql
as $$
begin
  if new.kind = 'rating' then
    insert into interaction (user_id, media_key, kind, value)
    values (new.user_id, new.media_key, 'watched', null)
    on conflict (user_id, media_key, kind) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_watched_follows_rating on interaction;

create trigger trg_watched_follows_rating
after insert or update of value on interaction
for each row
execute function watched_follows_rating();

-- The inserted row carries kind = 'watched', so the trigger fires again and
-- the `if` guard stops it there. No recursion.

-- Backfill anything rated before this trigger existed.
insert into interaction (user_id, media_key, kind, value)
select r.user_id, r.media_key, 'watched', null
from interaction r
where r.kind = 'rating'
on conflict (user_id, media_key, kind) do nothing;
