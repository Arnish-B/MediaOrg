/**
 * Reel — TMDB proxy
 *
 * The browser never holds the TMDB credential. It calls this worker; the worker
 * attaches the secret and forwards to TMDB. Read-only, GET-only, path-allowlisted
 * so it cannot be used as a general-purpose open proxy.
 *
 * Secret:   TMDB_TOKEN      (v4 read access token, or a v3 api key — both work)
 * Variable: ALLOWED_ORIGIN  (your Pages origin, e.g. https://you.github.io — "*" while testing)
 */

const TMDB_BASE = "https://api.themoviedb.org/3";

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

const CACHE_SECONDS = 86400; // metadata is stable; ratings refresh via the nightly dump

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return err(405, "This proxy is read-only. GET only.", cors);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, configured: Boolean(env.TMDB_TOKEN) }, 200, cors);
    }
    if (!url.pathname.startsWith("/tmdb/")) {
      return err(404, "Unknown route. Use /tmdb/<tmdb-path>.", cors);
    }

    const allowed = env.ALLOWED_ORIGIN || "*";
    if (allowed !== "*" && origin && origin !== allowed) {
      return err(403, "Origin not allowed.", cors);
    }

    const tmdbPath = url.pathname.slice("/tmdb/".length);
    const root = tmdbPath.split("/")[0];
    if (!ALLOWED_ROOTS.has(root)) {
      return err(403, `Path "${root}" is not on the allowlist.`, cors);
    }
    if (!env.TMDB_TOKEN) {
      return err(500, "TMDB_TOKEN secret is not set on this worker.", cors);
    }

    // Cache on the worker's own URL, which keeps the key valid for the Cache API.
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });

    let cached = null;
    try {
      cached = await cache.match(cacheKey);
    } catch (e) {
      cached = null; // Cache API is a no-op in some environments; degrade quietly.
    }
    if (cached) return withCors(cached, cors, "HIT");

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

    let upstream;
    try {
      upstream = await fetch(target.toString(), { headers });
    } catch (e) {
      return err(502, "Could not reach TMDB.", cors);
    }

    const body = await upstream.text();
    const response = new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${CACHE_SECONDS}`,
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
  },
};

function corsHeaders(origin, env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "*";
  return {
    "access-control-allow-origin": allowed === "*" ? "*" : (origin === allowed ? allowed : allowed),
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
