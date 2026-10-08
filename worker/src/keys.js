// Endpoints for the "keys" widget (keys/key-manager.js) and requests/engine.
// Ported from chat/server.mjs, which serves the same paths locally.
//
// GET  /api/key-status, /api/server-keys
//      Which providers this Worker holds a key for, e.g. ["anthropic","openai"]
//      — never the key values themselves.
// GET  /api/public-key
//      Public half of BROWSER_ENCRYPTION_PRIVATE_KEY as a JWK, used by the
//      widget to encrypt a browser-held key for the server. 404 when unset.
// POST /api/validate-key  { provider, key } -> { valid: true | false | null }
//      Checks a key against the provider's API without storing it. The Arts
//      Engine's passphrase, typed as the Gemini key, counts as valid.

import { createPrivateKey, createPublicKey } from "node:crypto";
import { getConfiguredProviders } from "./chat.js";
import { configuredValue, json } from "./http.js";
import { checkEnginePassphrase } from "../../requests/engine/worker/engine.js";

export function handleKeyStatus(env) {
  return json(getConfiguredProviders(env));
}

export function handlePublicKey(env) {
  const pem = configuredValue(env, "BROWSER_ENCRYPTION_PRIVATE_KEY");
  if (!pem) return new Response("Server encryption key not configured", { status: 404 });
  try {
    const privateKey = createPrivateKey({ key: pem.replace(/\\n/g, "\n"), format: "pem" });
    return json(createPublicKey(privateKey).export({ format: "jwk" }));
  } catch {
    return new Response("Server encryption key not configured", { status: 404 });
  }
}

export async function handleValidateKey(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  try {
    const { provider, key } = (await request.json()) || {};
    if (!provider || !key) return json({ error: "Missing provider or key" }, 400);
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
