/**
 * CloudRoot Worker — serves cloud.model.earth: the website and its API.
 *
 * Static files: every path except /api/* (and /ingest/*) is served from the
 * build folder assembled from the webroot (scripts/build-static.mjs, [assets]
 * in wrangler.toml). Those requests never reach this code unless no file
 * matches, in which case they're handed back to the static files for a 404.
 *
 * API:
 *   POST /api/chat                      LLM proxy (chat.js)
 *   GET  /api/key-status, /api/server-keys, /api/public-key
 *   POST /api/validate-key              "keys" widget endpoints (keys.js)
 *   /api/auth/*, /api/oauth/*           sign-in (auth/index.js)
 *   GET  /api/cms/auth, /api/cms/callback  GitHub sign-in for Sveltia CMS (cms-auth.js)
 *   /api/health, /api/models, /api/generate/*, /api/upload/tripo,
 *   /api/proxy/model                    Arts Engine (requests/engine/worker/engine.js)
 *
 * Transcript intake: POST /ingest/<WEBHOOK_SECRET> from the TranscripTonic
 * extension opens a PR in ARCHIVIST_REPO (the tonic submodule, tonic/src).
 *
 * Pages on this origin need no CORS entry; other origins calling the API
 * from a browser are listed in ALLOWED_ORIGINS (http.js).
 */

import { handleChat } from "./chat.js";
import { handleKeyStatus, handlePublicKey, handleValidateKey } from "./keys.js";
import { handleAuth, isAuthPath } from "./auth/index.js";
import { handleCmsAuth, isCmsAuthPath } from "./cms-auth.js";
// Kept in the requests submodule beside the engine's Rust backend (rust-api),
// which it ports.
import { handleEngine, isEnginePath } from "../../requests/engine/worker/engine.js";
// The tonic submodule's Worker, run here instead of deployed on its own.
import tonic from "../../tonic/src/index.js";
import { corsHeaders, json, withCors } from "./http.js";

async function routeApi(request, env, ctx, url) {
  const path = url.pathname;
  const isGet = request.method === "GET";

  if (path === "/api/chat") return handleChat(request, env);
  if ((path === "/api/key-status" || path === "/api/server-keys") && isGet) return handleKeyStatus(env);
  if (path === "/api/public-key" && isGet) return handlePublicKey(env);
  if (path === "/api/validate-key") return handleValidateKey(request, env);
  if (isAuthPath(path)) return handleAuth(request, env, ctx, url);
  if (isCmsAuthPath(path)) return handleCmsAuth(request, env, url);
  if (isEnginePath(path)) return handleEngine(request, env);

  // e.g. /api/save-file, which only the local dev server provides.
  return json({ error: `No API at ${path}` }, 404);
}

// The auth submodule is a Next.js app, so /auth/ serves its static export
// (auth/out) rather than its source. Redirects from the asset server (adding
// a trailing slash) are pointed back under /auth/.
async function serveAuthExport(request, env, url) {
  const assetUrl = new URL(url);
  assetUrl.pathname = "/auth/out" + url.pathname.slice("/auth".length);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));
  const location = response.headers.get("Location");
  if (!location) return response;
  const target = new URL(location, assetUrl);
  if (target.origin !== url.origin || !target.pathname.startsWith("/auth/out")) return response;
  const headers = new Headers(response.headers);
  headers.set("Location", "/auth" + target.pathname.slice("/auth/out".length) + target.search);
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/ingest/")) return tonic.fetch(request, env);
    if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return serveAuthExport(request, env, url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    let response;
    try {
      response = await routeApi(request, env, ctx, url);
    } catch (err) {
      console.error(`[${url.pathname}]`, err);
      response = json({ error: "Internal error" }, 500);
    }
    return withCors(request, env, response);
  },
};
