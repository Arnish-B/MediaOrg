-- Reel / MediaOrg — the 'passed' interaction kind
--
-- Paste into Supabase → SQL Editor → Run. Safe to run more than once.
--
-- A pass records that one person declined a title the OTHER person put forward
-- alone. The title itself is moved by two ordinary writes the client already
-- knows how to make: a playlist_solo row for whoever added it, and the removal
-- of their playlist_shared row. This kind is the audit trail on top of that —
-- it is what lets the app show "she passed" against a title sitting on your own
-- list, and what an undo deletes.
--
-- interaction.kind carries a CHECK constraint, so a new kind needs the
-- constraint rebuilt. The client treats the write of a 'passed' row as
-- optional and swallows its failure, which means the app works correctly
-- before this file is run; you just lose the marker and the explanation.

-- The constraint is auto-named by Postgres, and an older deployment may carry a
-- different name than a newer one. Dropping by predicate rather than by name
-- makes this re-runnable and version-independent.
do $$
declare c text;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'interaction'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%playlist_shared%'
  loop
    execute format('alter table interaction drop constraint %I', c);
  end loop;
end $$;

alter table interaction
  add constraint interaction_kind_check check (kind in (
    'watched', 'rating', 'note',
    'playlist_shared', 'playlist_solo', 'progress',
    'passed'));

-- Sanity check. Both of these should succeed; the second proves the constraint
-- still rejects what it always rejected.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'interaction'::regclass
      and pg_get_constraintdef(oid) like '%passed%'
  ) then
    raise exception 'interaction.kind still refuses the passed kind';
  end if;
end $$;
