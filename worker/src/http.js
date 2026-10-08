// Shared response and cross-origin helpers.
//
// Pages served by this Worker call /api/* on their own origin, so they need
// no CORS headers at all. ALLOWED_ORIGINS (wrangler.toml [vars]) lists the
// other origins — e.g. https://model.earth, or a local static server — whose
// pages may call this API from the browser, with cookies.

export function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // X-Provider-*: the visitor's own LLM key, sent by the Arts Engine page.
    "Access-Control-Allow-Headers": "Content-Type, X-Provider-Name, X-Provider-Key, X-Provider-URL",
    Vary: "Origin",
  };
}

export function withCors(request, env, response) {
  const headers = corsHeaders(request, env);
  if (Object.keys(headers).length === 0) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Unfilled values copied from an .env.example template (e.g.
// "your-google-client-secret") count as unset.
const PLACEHOLDER = /^(your[-_]|sk-your|<|example|placeholder|xxx|changeme|change_me|todo|dummy)/i;

export function configuredValue(env, name) {
  const value = (env[name] || "").trim();
  if (!value || PLACEHOLDER.test(value) || value.includes("_here")) return null;
  return value;
}
