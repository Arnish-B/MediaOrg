#!/usr/bin/env node
/**
 * Reel / MediaOrg — one-shot ratings backfill
 *
 *   node backfill-ratings.js            fill anything missing
 *   node backfill-ratings.js --force    refetch everything, even rows already present
 *   node backfill-ratings.js --dry      fetch and report, write nothing
 *
 * Walks every title either person has interacted with and fills, per title:
 *
 *   tmdb         TMDB's own vote average          worker /tmdb
 *   imdb         IMDb score and vote count        worker /omdb
 *   metacritic   Metascore                        worker /omdb
 *   rt           Tomatometer                      worker /omdb, Ratings array
 *   letterboxd   weighted average, films only     letterboxd.com JSON-LD
 *
 * The OMDb key never appears here; the worker holds it. The worker's
 * ALLOWED_ORIGIN check only fires when an Origin header is present, and Node
 * sends none, so this runs without loosening anything.
 *
 * Your own 0.5-5.0 ratings live in `interaction` and are never touched.
 *
 * Values land in media_rating with is_manual = false, so a future refresh
 * worker is free to overwrite them. Anything you type in by hand later with
 * is_manual = true is left alone by both this script and the app.
 */

const SUPA = "https://qxmtxmumnudsyyhvzpkc.supabase.co";
const KEY = "sb_publishable_3wETr10Yuy8RvDUhbl94Og_BoqZvcVQ";
const WORKER = "https://mediaorg.d86532an.workers.dev";

const UA = "MediaOrg-backfill/1.0 (personal two-user media tracker)";
const WORKER_GAP = 260;   // TMDB allows 40 per 10s; the worker caches on top
const LB_GAP = 1200;      // letterboxd.com is a courtesy scrape, so go slowly

const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;

function num(v) {
  if (v == null) return null;
  const t = String(v).replace(/,/g, "").trim();
  if (!t || t === "N/A") return null;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

const sbHeaders = () => ({
  apikey: KEY,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
});

async function sbGet(path) {
  const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function sbUpsert(table, rows, conflict) {
  const r = await fetch(`${SUPA}/rest/v1/${table}?on_conflict=${conflict}`, {
    method: "POST",
    headers: { ...sbHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/* ------------------------------------------------------------- sources */

const OMDB_SOURCES = {
  "Internet Movie Database": { key: "imdb", scale: "/10" },
  "Rotten Tomatoes": { key: "rt", scale: "%" },
  Metacritic: { key: "metacritic", scale: "/100" },
};

async function fromTmdb(kind, id) {
  const path = kind === "movie" ? "movie" : "tv";
  const d = await getJSON(`${WORKER}/tmdb/${path}/${id}?append_to_response=external_ids`);
  return {
    tmdb: num(d.vote_average),
    tmdbVotes: num(d.vote_count),
    imdbId: (d.external_ids && d.external_ids.imdb_id) || null,
  };
}

async function fromOmdb(imdbId) {
  const o = await getJSON(`${WORKER}/omdb?i=${encodeURIComponent(imdbId)}`);
  if (!o || o.Response === "False") return {};
  const out = {};
  const iv = num(o.imdbRating);
  if (iv != null) out.imdb = { value: iv, scale: "/10", votes: num(o.imdbVotes) };
  const mv = num(o.Metascore);
  if (mv != null) out.metacritic = { value: mv, scale: "/100", votes: null };
  for (const r of o.Ratings || []) {
    const m = OMDB_SOURCES[r && r.Source];
    if (!m || out[m.key]) continue;
    const v = num(r.Value);            // "93%" and "74/100" both parse
    if (v != null) out[m.key] = { value: v, scale: m.scale, votes: null };
  }
  return out;
}

/**
 * Letterboxd has no API and never answered the access request, so this reads
 * the public film page. /tmdb/<id>/ redirects to the right film, which avoids
 * guessing slugs from titles. Letterboxd carries films only — there is no TV
 * on the site at all, so shows are skipped rather than reported as failures.
 */
async function fromLetterboxd(tmdbId) {
  const r = await fetch(`https://letterboxd.com/tmdb/${tmdbId}/`, {
    headers: { "user-agent": UA, accept: "text/html" },
    redirect: "follow",
  });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  const txt = m[1]
    .replace(/^\s*\/\*\s*<!\[CDATA\[\s*\*\//, "")
    .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, "")
    .trim();
  let ld;
  try { ld = JSON.parse(txt); } catch { return null; }
  const ar = ld && ld.aggregateRating;
  const v = ar && num(ar.ratingValue);
  if (v == null) return null;
  return { value: v, scale: "/5", votes: ar.ratingCount ? num(ar.ratingCount) : null };
}

/* ---------------------------------------------------------------- main */

async function main() {
  console.log(DRY ? "DRY RUN — nothing will be written\n" : "");

  const titles = await sbGet(
    "interaction?select=media_key,media(key,title,year,kind,source)&limit=5000"
  ).catch(async () => {
    const [ints, media] = await Promise.all([
      sbGet("interaction?select=media_key&limit=5000"),
      sbGet("media?select=key,title,year,kind,source&limit=5000"),
    ]);
    const byKey = Object.fromEntries(media.map((m) => [m.key, m]));
    return ints.map((i) => ({ media_key: i.media_key, media: byKey[i.media_key] || null }));
  });

  const seen = new Map();
  for (const row of titles) {
    const k = row.media_key;
    if (!seen.has(k)) seen.set(k, row.media || { key: k, title: k, kind: null });
  }
  const list = [...seen.entries()].map(([key, m]) => ({ key, ...m }));
  list.sort((a, b) => String(a.title).localeCompare(String(b.title)));

  const existingRows = await sbGet("media_rating?select=media_key,source,is_manual&limit=20000");
  const existing = new Map();
  for (const r of existingRows) {
    if (!existing.has(r.media_key)) existing.set(r.media_key, new Map());
    existing.get(r.media_key).set(r.source, r.is_manual);
  }

  console.log(`${list.length} titles interacted with.`);
  console.log(`${existingRows.length} rating rows already stored.\n`);

  const report = { tmdb: 0, imdb: 0, metacritic: 0, rt: 0, letterboxd: 0 };
  const gaps = { tmdb: [], imdb: [], metacritic: [], rt: [], letterboxd: [] };
  const broken = [];
  let done = 0;

  for (const t of list) {
    done++;
    const label = `${String(done).padStart(3)}/${list.length}  ${t.title}`;
    const parts = (t.key || "").split(":");            // tmdb:movie:1234
    const src = parts[0], kind = parts[1], id = parts[2];
    const have = existing.get(t.key) || new Map();
    const isFilm = kind === "movie";

    const wanted = ["tmdb", "imdb", "metacritic", "rt"].concat(isFilm ? ["letterboxd"] : []);
    if (!FORCE && wanted.every((s) => have.has(s))) {
      console.log(`${label} — already complete, skipped`);
      for (const s of wanted) report[s]++;
      continue;
    }

    if (src !== "tmdb") {
      broken.push(`${t.title} — not a TMDB title (${t.key}), no IMDb id to look up`);
      console.log(`${label} — skipped, non-TMDB source`);
      continue;
    }

    const writes = [];
    const now = new Date().toISOString();
    const add = (source, value, scale, votes) => {
      if (value == null) return;
      if (have.get(source) === true) return;           // never clobber a manual row
      writes.push({
        media_key: t.key, source, value: round1(value), scale,
        votes: votes == null ? null : Math.round(votes),
        fetched_at: now, is_manual: false,
      });
      report[source]++;
    };

    let imdbId = null;
    try {
      const d = await fromTmdb(kind, id);
      imdbId = d.imdbId;
      add("tmdb", d.tmdb, "/10", d.tmdbVotes);
      if (d.tmdb == null) gaps.tmdb.push(t.title);
    } catch (e) {
      gaps.tmdb.push(t.title);
      broken.push(`${t.title} — TMDB: ${e.message}`);
    }
    await sleep(WORKER_GAP);

    if (imdbId) {
      try {
        const o = await fromOmdb(imdbId);
        add("imdb", o.imdb?.value, "/10", o.imdb?.votes);
        add("metacritic", o.metacritic?.value, "/100", null);
        add("rt", o.rt?.value, "%", null);
        if (!o.imdb) gaps.imdb.push(t.title);
        if (!o.metacritic) gaps.metacritic.push(t.title);
        if (!o.rt) gaps.rt.push(t.title);
      } catch (e) {
        gaps.imdb.push(t.title); gaps.metacritic.push(t.title); gaps.rt.push(t.title);
        broken.push(`${t.title} — OMDb: ${e.message}`);
      }
      await sleep(WORKER_GAP);
    } else {
      gaps.imdb.push(t.title); gaps.metacritic.push(t.title); gaps.rt.push(t.title);
      broken.push(`${t.title} — TMDB holds no IMDb id, so OMDb cannot be addressed`);
    }

    if (isFilm) {
      try {
        const lb = await fromLetterboxd(id);
        if (lb) add("letterboxd", lb.value, "/5", lb.votes);
        else gaps.letterboxd.push(t.title);
      } catch (e) {
        gaps.letterboxd.push(t.title);
        broken.push(`${t.title} — Letterboxd: ${e.message}`);
      }
      await sleep(LB_GAP);
    }

    if (writes.length && !DRY) {
      try {
        await sbUpsert("media_rating", writes, "media_key,source");
      } catch (e) {
        broken.push(`${t.title} — WRITE FAILED: ${e.message}`);
        console.log(`${label} — ${writes.length} scores, WRITE FAILED`);
        continue;
      }
    }
    console.log(`${label} — ${writes.length} scores${DRY ? " (not written)" : ""}`);
  }

  const films = list.filter((t) => (t.key || "").split(":")[1] === "movie").length;
  console.log("\n" + "=".repeat(64));
  console.log(`tmdb        ${report.tmdb}/${list.length}`);
  console.log(`imdb        ${report.imdb}/${list.length}`);
  console.log(`metacritic  ${report.metacritic}/${list.length}`);
  console.log(`rt          ${report.rt}/${list.length}`);
  console.log(`letterboxd  ${report.letterboxd}/${films} films (TV is not on Letterboxd)`);

  for (const [k, v] of Object.entries(gaps)) {
    if (!v.length) continue;
    console.log(`\nNo ${k} score published for ${v.length}:`);
    console.log("  " + v.join("\n  "));
  }
  if (broken.length) {
    console.log(`\nErrors (${broken.length}):`);
    console.log("  " + broken.join("\n  "));
  }
  console.log("\nDone.");
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
