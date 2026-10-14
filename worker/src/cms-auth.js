// GitHub sign-in for Sveltia CMS and localsite's content tools.
//
// Implements the popup handshake Sveltia CMS (and Netlify/Decap CMS) uses
// with an external OAuth client:
//
//   GET /api/cms/auth?provider=github&site_id=...&scope=...
//       Redirects the popup to GitHub's authorize page, with a state cookie.
//   GET /api/cms/callback?code=...&state=...
//       Exchanges the code for a token, then returns a page that posts
//       "authorization:github:success:{token}" to the window that opened it.
//
// GitHub's "Authorize <name>" page shows the OAuth app's registered name, so
// register the app as e.g. "Model Earth CMS" (automation/README.md). Its
// client id and secret are CMS_GITHUB_CLIENT_ID / CMS_GITHUB_CLIENT_SECRET,
// separate from the social sign-in app because the callback URL differs.
//
// The token is only posted to this origin or one listed in ALLOWED_ORIGINS,
// so another site can't open the popup and collect a visitor's token.

import { allowedOrigins, configuredValue } from "./http.js";

const STATE_COOKIE = "cms_oauth_state";
// Scopes a page may request. public_repo covers forking DesktopFolders/content
// and writing to the fork; repo adds private repositories.
const ALLOWED_SCOPES = new Set(["repo", "public_repo", "read:user", "user:email"]);
const DEFAULT_SCOPE = "public_repo";

export function isCmsAuthPath(path) {
  return path === "/api/cms/auth" || path === "/api/cms/callback";
}

export async function handleCmsAuth(request, env, url) {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const clientId = configuredValue(env, "CMS_GITHUB_CLIENT_ID");
  const clientSecret = configuredValue(env, "CMS_GITHUB_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return handshakePage(env, url, { error: "GitHub sign-in for the CMS isn't set up on this server.", errorCode: "MISCONFIGURED_CLIENT" });
  }
  if (url.pathname === "/api/cms/auth") return startAuth(url, clientId);
  return finishAuth(request, env, url, clientId, clientSecret);
}

function startAuth(url, clientId) {
  const provider = url.searchParams.get("provider") || "github";
  if (provider !== "github") {
    return new Response(`Unsupported provider: ${provider}`, { status: 400 });
  }
  const scope = (url.searchParams.get("scope") || DEFAULT_SCOPE)
    .split(/[\s,]+/)
    .filter((s) => ALLOWED_SCOPES.has(s))
    .join(" ") || DEFAULT_SCOPE;
  const state = crypto.randomUUID();
  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", `${url.origin}/api/cms/callback`);
  authorize.searchParams.set("scope", scope);
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/api/cms; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

async function finishAuth(request, env, url, clientId, clientSecret) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(request, STATE_COOKIE);
  if (url.searchParams.get("error")) {
    return handshakePage(env, url, { error: url.searchParams.get("error_description") || "Sign-in was cancelled.", errorCode: "AUTH_DENIED" });
  }
  if (!code || !state || state !== cookieState) {
    return handshakePage(env, url, { error: "Sign-in expired or didn't match. Please try again.", errorCode: "CSRF_DETECTED" });
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "cloudroot-worker" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: `${url.origin}/api/cms/callback` }),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.access_token) {
    return handshakePage(env, url, { error: data.error_description || "GitHub didn't return a token.", errorCode: "TOKEN_REQUEST_FAILED" });
  }
  return handshakePage(env, url, { token: data.access_token });
}

// The page the popup ends on. It announces itself to the opener, waits for
// the opener to echo "authorizing:github", and answers that origin only if
// it's allowed.
function handshakePage(env, url, result) {
  const provider = "github";
  const state = result.token ? "success" : "error";
  const content = result.token ? { provider, token: result.token } : { provider, error: result.error, errorCode: result.errorCode };
  const origins = [url.origin, ...allowedOrigins(env)];
  const message = `authorization:${provider}:${state}:${JSON.stringify(content)}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head><body>
<p style="font-family:system-ui,sans-serif">${state === "success" ? "Signed in. You can close this window." : "Sign-in failed. You can close this window."}</p>
<script>
(function () {
  var allowed = ${scriptJson(origins)};
  var message = ${scriptJson(message)};
  window.addEventListener("message", function (event) {
    if (event.source !== window.opener || event.data !== "authorizing:${provider}") return;
    if (allowed.indexOf(event.origin) < 0) return;
    window.opener.postMessage(message, event.origin);
  });
  if (window.opener) window.opener.postMessage("authorizing:${provider}", "*");
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Clear the one-time state.
      "Set-Cookie": `${STATE_COOKIE}=; Path=/api/cms; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    },
  });
}

// JSON for inside a <script> tag: escapes "<" so an error message from the
// query string can't close the tag.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}
