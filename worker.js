/**
 * Reel — metadata proxy
 *
 * The browser never holds a credential. It calls this worker; the worker
 * attaches the secret and forwards upstream. Read-only, GET-only, and
 * allowlisted by path and by query parameter so it cannot be used as a
 * general-purpose open proxy.
 *
 * Secrets:  TMDB_TOKEN      (v4 read access token, or a v3 api key — both work)
 *           OMDB_KEY        (optional; without it /omdb answers 503 and the
 *                            client simply keeps showing those rows as absent)
 * Variable: ALLOWED_ORIGIN  (your Pages origin, e.g. https://you.github.io — "*" while testing)
 *
 * Routes:   /health              liveness, and which secrets are configured
 *           /tmdb/<tmdb-path>    TMDB v3, path-allowlisted
 *           /omdb?i=tt0123456    OMDb by IMDb id (or t=title&y=year)
 */

const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com/";

// Only these TMDB top-level paths are reachable through the proxy.
const ALLOWED_ROOTS = new Set([
  "movie",
  "tv",
  "discover",
  "search",
  "genre",
  "person",
  "configuration",
]);

// OMDb takes its whole request in the query string, so the allowlist is on
// parameters rather than path. Anything else, apikey above all, is dropped.
const OMDB_PARAMS = new Set(["i", "t", "y", "type", "season", "episode"]);

const CACHE_SECONDS = 86400;      // TMDB metadata is stable
const OMDB_CACHE_SECONDS = 43200; // IMDb scores drift; the client holds its own TTL too

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return err(405, "This proxy is read-only. GET only.", cors);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        configured: Boolean(env.TMDB_TOKEN),
        omdb: Boolean(env.OMDB_KEY),
      }, 200, cors);
    }

    const allowed = env.ALLOWED_ORIGIN || "*";
    if (allowed !== "*" && origin && origin !== allowed) {
      return err(403, "Origin not allowed.", cors);
    }

    if (url.pathname === "/omdb") return omdb(url, env, ctx, cors);
    if (url.pathname.startsWith("/tmdb/")) return tmdb(url, env, ctx, cors);

    return err(404, "Unknown route. Use /tmdb/<tmdb-path> or /omdb?i=<imdb id>.", cors);
  },
};

async function tmdb(url, env, ctx, cors) {
  const tmdbPath = url.pathname.slice("/tmdb/".length);
  const root = tmdbPath.split("/")[0];
  if (!ALLOWED_ROOTS.has(root)) {
    return err(403, `Path "${root}" is not on the allowlist.`, cors);
  }
  if (!env.TMDB_TOKEN) {
    return err(500, "TMDB_TOKEN secret is not set on this worker.", cors);
  }

  const target = new URL(`${TMDB_BASE}/${tmdbPath}`);
  for (const [key, value] of url.searchParams) {
    if (key === "api_key") continue; // never let a caller inject credentials
    target.searchParams.set(key, value);
  }

  const token = env.TMDB_TOKEN.trim();
  const headers = { accept: "application/json" };
  if (token.includes(".")) {
    headers.Authorization = `Bearer ${token}`; // v4 read access token
  } else {
    target.searchParams.set("api_key", token); // v3 api key
  }

  return proxy(url, target, headers, CACHE_SECONDS, ctx, cors, "TMDB");
}

async function omdb(url, env, ctx, cors) {
  if (!env.OMDB_KEY) {
    // Deliberately not an error the client has to special-case: it reads this
    // as "no external scores available" and renders the rows as absent.
    return err(503, "OMDB_KEY secret is not set on this worker.", cors);
  }

  const target = new URL(OMDB_BASE);
  let addressed = false;
  for (const [key, value] of url.searchParams) {
    if (!OMDB_PARAMS.has(key)) continue; // drops apikey, r=xml, callback=, everything else
    target.searchParams.set(key, value);
    if (key === "i" || key === "t") addressed = true;
  }
  if (!addressed) {
    return err(400, "Pass i=<imdb id> or t=<title>.", cors);
  }
  target.searchParams.set("r", "json");
  target.searchParams.set("apikey", env.OMDB_KEY.trim());

  return proxy(url, target, { accept: "application/json" }, OMDB_CACHE_SECONDS, ctx, cors, "OMDb");
}

/**
 * Shared fetch-and-cache. The cache key is this worker's own URL, never the
 * upstream one, so the credential never becomes part of a cache key.
 */
async function proxy(selfUrl, target, headers, maxAge, ctx, cors, label) {
  const cache = caches.default;
  const cacheKey = new Request(selfUrl.toString(), { method: "GET" });

  let cached = null;
  try {
    cached = await cache.match(cacheKey);
  } catch (e) {
    cached = null; // Cache API is a no-op in some environments; degrade quietly.
  }
  if (cached) return withCors(cached, cors, "HIT");

  let upstream;
  try {
    upstream = await fetch(target.toString(), { headers });
  } catch (e) {
    return err(502, `Could not reach ${label}.`, cors);
  }

  const body = await upstream.text();
  const response = new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${maxAge}`,
    },
  });

  if (upstream.ok) {
    try {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } catch (e) {
      /* cache unavailable; the response still goes out */
    }
  }

  return withCors(response, cors, "MISS");
}

function corsHeaders(env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "*";
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function withCors(response, cors, cacheState) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  out.headers.set("x-proxy-cache", cacheState);
  return out;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors },
  });
}

function err(status, message, cors) {
  return json({ error: message }, status, cors);
}
