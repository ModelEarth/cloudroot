// Endpoints for the "keys" widget (keys/key-manager.js) and requests/engine.
// Ported from chat/server.mjs, which serves the same paths locally.
//
// GET  /api/key-status, /api/server-keys
//      Which providers this Worker holds a key for, e.g. ["anthropic","openai"]
//      — never the key values themselves.
// GET  /api/public-key
//      Public half of BROWSER_ENCRYPTION_PRIVATE_KEY as a JWK, used by the
//      widget to encrypt a browser-held key for the server, plus
//      server_providers: the providers it may do that for. 404 when unset.
// POST /api/validate-key  { provider, key } -> { valid: true | false | null }
//      Checks a key against the provider's API without storing it. The Arts
//      Engine's passphrase, typed as the Gemini key, counts as valid.
//
// A key the widget encrypted for the server arrives as "rsa:<base64>", so page
// scripts never hold the real key after it's saved. It decrypts to
// "<provider>\n<key>", and is opened only for that provider and only on a route
// that sends keys to that provider's fixed address. Anyone with the value can
// still use the key through these routes, so no route may let the caller choose
// where the key goes: /api/generate/3d posts it to a URL in the request body,
// which is why Meshy and Tripo keys stay in the browser.

import { getConfiguredProviders } from "./chat.js";
import { configuredValue, json } from "./http.js";
import { checkEnginePassphrase } from "../../requests/engine/worker/engine.js";

export function handleKeyStatus(env) {
  return json(getConfiguredProviders(env));
}

// Providers whose keys the Worker can use from an encrypted value: each has a
// fixed address in requests/engine/worker/engine.js and engine/worker/claude-voice-api.js.
const SERVER_PROVIDERS = ["anthropic", "google", "openai", "xai", "groq", "together", "fireworks", "mistral", "perplexity", "deepseek", "pollinations"];

const ENCRYPTED_PREFIX = "rsa:";
const RSA_OAEP = { name: "RSA-OAEP", hash: "SHA-256" };

function isServerKeyRoute(path) {
  return path === "/api/models" || path === "/api/claude-voice" || path === "/api/generate/text"
    || path === "/api/generate/image" || path === "/api/generate/video" || path.startsWith("/api/generate/video/");
}

// BROWSER_ENCRYPTION_PRIVATE_KEY is a PKCS#8 PEM, with newlines escaped as \n in env files.
function importPrivateKey(pem, extractable) {
  const base64 = pem.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, RSA_OAEP, extractable, ["decrypt"]);
}

export async function handlePublicKey(env) {
  const pem = configuredValue(env, "BROWSER_ENCRYPTION_PRIVATE_KEY");
  if (!pem) return new Response("Server encryption key not configured", { status: 404 });
  try {
    const { kty, n, e } = await crypto.subtle.exportKey("jwk", await importPrivateKey(pem, true));
    return json({ kty, n, e, server_providers: SERVER_PROVIDERS });
  } catch {
    return new Response("Server encryption key not configured", { status: 404 });
  }
}

// The real key inside an encrypted value, or null if it can't be opened for this provider.
async function openEncryptedKey(env, value, provider) {
  const pem = configuredValue(env, "BROWSER_ENCRYPTION_PRIVATE_KEY");
  if (!pem || !SERVER_PROVIDERS.includes(provider)) return null;
  try {
    const ciphertext = Uint8Array.from(atob(value.slice(ENCRYPTED_PREFIX.length)), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(RSA_OAEP, await importPrivateKey(pem, false), ciphertext);
    const text = new TextDecoder().decode(plain);
    const split = text.indexOf("\n");
    if (split < 0 || text.slice(0, split) !== provider) return null;
    return text.slice(split + 1) || null;
  } catch {
    return null;
  }
}

// Swaps an encrypted X-Provider-Key for the real key before the request reaches
// its route. Returns the request to use, or a Response refusing it.
export async function openProviderKeyHeader(request, env, path) {
  const value = (request.headers.get("x-provider-key") || "").trim();
  if (!value.startsWith(ENCRYPTED_PREFIX)) return request;
  if (!isServerKeyRoute(path) || request.headers.get("x-provider-url")) {
    return json({ error: "An encrypted key can't be used with this request." }, 400);
  }
  const provider = (request.headers.get("x-provider-name") || "").trim();
  const key = await openEncryptedKey(env, value, provider);
  if (!key) return json({ error: "This saved key can't be read. Enter it again on the keys page." }, 400);
  const headers = new Headers(request.headers);
  headers.set("x-provider-key", key);
  return new Request(request, { headers });
}

export async function handleValidateKey(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const { provider, key: sent } = (await request.json()) || {};
    if (!provider || !sent) return json({ error: "Missing provider or key" }, 400);
    const key = String(sent).startsWith(ENCRYPTED_PREFIX) ? await openEncryptedKey(env, String(sent), provider) : sent;
    if (!key) return json({ valid: false });
    const passphrase = await checkEnginePassphrase(env, provider, key);
    if (passphrase === "match") return json({ valid: true });
    if (passphrase === "invalid") return json({ valid: false, error: "Passkey contains invalid phrase." });

    const valid = await validateProviderKey(provider, key);
    if (valid === "unsupported") return json({ valid: null, error: "Unsupported provider" });
    return json({ valid });
  } catch {
    return json({ valid: null });
  }
}

// [url, init, status codes that mean "rejected"] per provider.
const VALIDATORS = {
  anthropic: (key) => ["https://api.anthropic.com/v1/models", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }, [401, 403]],
  openai: (key) => ["https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } }, [401, 403]],
  google: (key) => [`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1`, {}, [400, 403]],
  xai: (key) => ["https://api.x.ai/v1/models", { headers: { Authorization: `Bearer ${key}` } }, [401, 403]],
  github: (key) => ["https://api.github.com/user", { headers: { Authorization: `Bearer ${key}`, "User-Agent": "codechat-key-validator" } }, [401, 403]],
};

async function validateProviderKey(provider, key) {
  const validator = VALIDATORS[provider];
  if (!validator) return "unsupported";
  const [url, init, rejected] = validator(key);
  const response = await fetch(url, init);
  if (response.status === 200) return true;
  if (rejected.includes(response.status)) return false;
  return null;
}
