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

export const isVeilPath = (path) => path.startsWith(VEIL_API);

export async function handleVeil(request, env, ctx, url) {
  const handler = HANDLERS[url.pathname.slice(VEIL_API.length)];
  if (!handler) return Response.json({ error: `No API at ${url.pathname}` }, { status: 404 });

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
    await requestContext.run({ waitUntil: (promise) => ctx.waitUntil(promise) }, () => handler(req, res));
  } catch (err) {
    console.error(`[${url.pathname}]`, err);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
  if (status === 204 || status === 304 || request.method === "HEAD") payload = null;
  return new Response(payload, { status, headers: out });
}
