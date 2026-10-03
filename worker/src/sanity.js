// /sanity/* proxy. Locally, chat/server.mjs starts the Sanity Next.js site
// and proxies /sanity to it. A Worker can't run that site, so here /sanity
// is forwarded to wherever it's hosted, set as SANITY_SITE_URL (the origin
// only, e.g. https://sanity-site.example.com — the /sanity path is kept).

import { json } from "./http.js";

export function isSanityPath(pathname) {
  return pathname === "/sanity" || pathname.startsWith("/sanity/");
}

export function proxySanity(request, env, url) {
  if (!env.SANITY_SITE_URL) {
    return new Response("The Sanity site is not configured for this deployment (SANITY_SITE_URL).", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const target = new URL(url.pathname + url.search, env.SANITY_SITE_URL);
  return fetch(new Request(target, request));
}

export function handleSanityStatus(env) {
  return json({
    running: !!env.SANITY_SITE_URL,
    target: env.SANITY_SITE_URL || null,
    missingVars: env.SANITY_SITE_URL ? [] : ["SANITY_SITE_URL"],
  });
}
