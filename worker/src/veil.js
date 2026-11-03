// The Veil (veil/code): its API, written as Vercel functions (veil/code/api/*.js,
// handler(req, res)), run here at /veil/code/api/<name> for the game served from
// /veil/code/. The same files still deploy to Vercel unchanged, where they're at /api/<name>.
//
// Vercel gives the functions a Node request and response; here each call gets a
// small stand-in for both. The game reads its keys from process.env, its sealed
// story files from private/ and its reference portrait from disk, so those are
// handed over first (veil/code/lib/server-files.js), and @vercel/functions'
// waitUntil is pointed at this request's ctx.waitUntil.

import { AsyncLocalStorage } from "node:async_hooks";
import { provideFiles } from "../../veil/code/lib/server-files.js";
// Imported as text and bytes ([[rules]] in wrangler.toml). A new case file in
// private/cases/ needs a line here too.
import bible from "../../veil/code/private/bible.md";
import admins from "../../veil/code/private/admins.txt";
import items from "../../veil/code/private/items.json";
import doriansVeil from "../../veil/code/private/cases/dorians-veil.json";
import fixes from "../../veil/code/private/cases/fixes.json";
import martaReference from "../../veil/code/assets/marta_reference.jpg";
import account from "../../veil/code/api/account.js";
import caseApi from "../../veil/code/api/case.js";
import clips from "../../veil/code/api/clips.js";
import direct from "../../veil/code/api/direct.js";
import generate from "../../veil/code/api/generate.js";
import gradeImage from "../../veil/code/api/grade-image.js";
import illustrate from "../../veil/code/api/illustrate.js";
import library from "../../veil/code/api/library.js";
import progress from "../../veil/code/api/progress.js";
import sceneArt from "../../veil/code/api/scene-art.js";
import store from "../../veil/code/api/store.js";
import trailer from "../../veil/code/api/trailer.js";

export const VEIL_API = "/veil/code/api/";

const HANDLERS = {
  account, case: caseApi, clips, direct, generate, "grade-image": gradeImage,
  illustrate, library, progress, "scene-art": sceneArt, store, trailer,
};

// The environment names the game reads (veil/code/api, veil/code/lib).
const GAME_ENV = /^(GAME_STATE_SECRET|NVIDIA|FAL_|BLOB_READ_WRITE_TOKEN$|COSMOS_|IMAGE_|FILM_)/;

// Vercel's limit on a function's request body.
const MAX_BODY = 4.5 * 1024 * 1024;

// The game's Vercel site, whose Vercel Blob store holds the trailer's videos and the scene pictures. Without a
// BLOB_READ_WRITE_TOKEN here (the site's or the visitor's), these reads pass through to it (server to server, since it sends no CORS headers).
const VEIL_VERCEL = "https://senarastoryenginev1cosmos.vercel.app";
const FROM_VERCEL = new Set(["trailer", "scene-art"]);
const PASSED_HEADERS = ["Content-Type", "Content-Length", "Cache-Control"];

provideFiles({
  "private/bible.md": bible,
  "private/admins.txt": admins,
  "private/items.json": JSON.stringify(items),
  "private/cases/dorians-veil.json": JSON.stringify(doriansVeil),
  "private/cases/fixes.json": JSON.stringify(fixes),
  "assets/marta_reference.jpg": martaReference,
});

// @vercel/functions' waitUntil() looks up the request's context under this symbol.
const requestContext = new AsyncLocalStorage();
globalThis[Symbol.for("@vercel/request-context")] = { get: () => requestContext.getStore() };

// The keys a visitor can give the game on the /keys page (Planet.Live: The Veil in keys/providers.js), sent by
// veil/code/visitor-keys.js. The game reads them from process.env, which here answers from the request's own
// context first, so one visitor's key never reaches another request running at the same time. Without one, the
// site's secret (set from env in handleVeil) is used. (workerd doesn't allow getters on process.env itself.)
const VISITOR_KEYS = { "x-veil-blob-token": "BLOB_READ_WRITE_TOKEN", "x-veil-fal-key": "FAL_KEY" };
const siteEnv = process.env;
const own = (name) => (typeof name === "string" ? requestContext.getStore()?.keys?.[name] : undefined);
process.env = new Proxy(siteEnv, {
  get: (target, name) => own(name) ?? target[name],
  has: (target, name) => own(name) !== undefined || name in target,
});

export const isVeilPath = (path) => path.startsWith(VEIL_API);

export async function handleVeil(request, env, ctx, url) {
  const name = url.pathname.slice(VEIL_API.length);
  const handler = HANDLERS[name];
  if (!handler) return Response.json({ error: `No API at ${url.pathname}` }, { status: 404 });
  const keys = {};
  for (const [header, envName] of Object.entries(VISITOR_KEYS)) {
    const value = (request.headers.get(header) || "").trim();
    if (value) keys[envName] = value;
  }
  if (request.method === "GET" && FROM_VERCEL.has(name) && !env.BLOB_READ_WRITE_TOKEN && !keys.BLOB_READ_WRITE_TOKEN) {
    const r = await fetch(`${VEIL_VERCEL}/api/${name}${url.search}`, { signal: request.signal });
    const headers = new Headers();
    for (const h of PASSED_HEADERS) if (r.headers.has(h)) headers.set(h, r.headers.get(h));
    return new Response(r.body, { status: r.status, headers });
  }

  // The game's own keys and settings only (NVIDIA_API_KEY, FAL_KEY, BLOB_READ_WRITE_TOKEN, GAME_STATE_SECRET, ...).
  // Not the site's other secrets: with OPENAI_API_KEY, every player would spend the site's OpenAI key.
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && GAME_ENV.test(name)) process.env[name] = value;
  }

  let body;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const text = await request.text();
    if (text.length > MAX_BODY) return Response.json({ error: "Request too large." }, { status: 413 });
    const isJson = (request.headers.get("Content-Type") || "").includes("application/json");
    try { body = isJson && text ? JSON.parse(text) : text; } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  }
  const headers = Object.fromEntries(request.headers);
  for (const header of Object.keys(VISITOR_KEYS)) delete headers[header];
  headers["x-forwarded-for"] ||= request.headers.get("CF-Connecting-IP") || "";
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    query: Object.fromEntries(url.searchParams),
    body,
    socket: {},
  };

  let status = 200;
  let payload = null;
  const out = new Headers();
  const res = {
    status(code) { status = code; return res; },
    setHeader(name, value) {
      out.delete(name);
      for (const v of [].concat(value)) out.append(name, String(v));
      return res;
    },
    getHeader: (name) => out.get(name),
    json(data) {
      if (!out.has("Content-Type")) out.set("Content-Type", "application/json; charset=utf-8");
      payload = JSON.stringify(data);
      return res;
    },
    send(data) {
      if (data && typeof data === "object" && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) return res.json(data);
      payload = data;
      return res;
    },
    end(data) { if (data !== undefined) payload = data; return res; },
  };

  try {
    await requestContext.run({ waitUntil: (promise) => ctx.waitUntil(promise), keys }, () => handler(req, res));
  } catch (err) {
    console.error(`[${url.pathname}]`, err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
  if (status === 204 || status === 304 || request.method === "HEAD") payload = null;
  return new Response(payload, { status, headers: out });
}
