// Sign-in (BetterAuth), rebuilt from chat's Next.js routes for the Worker.
//
// /api/auth/configured-providers  social providers with a client id + secret
// /api/auth/db-status             "ok" | "not-configured" | "unreachable"
// /api/auth/*                     BetterAuth: sign-in, sign-up, sign-out,
//                                 get-session, OAuth callbacks, ...
// /api/oauth/:provider?redirect=  starts social sign-in by top-level
//                                 navigation, for pages on other origins
// /api/oauth/relay?redirect=      returns there with #auth_user=<base64url>
//
// The auth submodule's pages (/auth/) and the localsite sign-in widget
// (/auth/js/auth-plugin.js) call these. Without POSTGRES_URL, BetterAuth runs
// stateless (sessions in an encrypted cookie): social sign-in still works,
// email/password does not.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { allowedOrigins, configuredValue, json } from "../http.js";
import { openDatabase, databaseStatus } from "./db.js";
import { databasePasswordHashing } from "./password.js";
import * as schema from "./schema.js";

// Provider id -> env names of its OAuth client. A provider is offered only
// when both are set.
const SOCIAL_PROVIDERS = {
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  microsoft: ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
  linkedin: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
  discord: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET"],
  facebook: ["FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET"],
};

export function configuredSocialProviders(env) {
  return Object.entries(SOCIAL_PROVIDERS)
    .filter(([, [id, secret]]) => configuredValue(env, id) && configuredValue(env, secret))
    .map(([provider]) => provider);
}

function socialProviderOptions(env) {
  const options = {};
  for (const provider of configuredSocialProviders(env)) {
    const [id, secret] = SOCIAL_PROVIDERS[provider];
    options[provider] = {
      clientId: configuredValue(env, id),
      clientSecret: configuredValue(env, secret),
      ...(provider === "microsoft" ? { tenantId: "common" } : {}),
    };
  }
  return options;
}

function createAuth(env, origin, database) {
  const baseURL = env.BETTER_AUTH_BASE_URL || origin;
  const secure = baseURL.startsWith("https://");
  return betterAuth({
    basePath: "/api/auth",
    baseURL,
    secret: configuredValue(env, "BETTER_AUTH_SECRET"),
    ...(database
      ? {
          database: drizzleAdapter(database.db, {
            provider: "pg",
            schema: {
              user: schema.user,
              session: schema.session,
              account: schema.account,
              verification: schema.verification,
            },
          }),
        }
      : {}),
    emailAndPassword: {
      enabled: !!database,
      requireEmailVerification: false,
      ...(database ? { password: databasePasswordHashing(database) } : {}),
    },
    account: {
      storeStateStrategy: "cookie",
      accountLinking: {
        enabled: true,
        trustedProviders: Object.keys(SOCIAL_PROVIDERS),
      },
    },
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "user", input: false },
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 5 * 60, strategy: "jwe" },
    },
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      useSecureCookies: secure,
      // Lax: pages on this origin, and on other model.earth subdomains
      // (same site), still send the cookie.
      defaultCookieAttributes: { sameSite: "lax", secure, httpOnly: true, path: "/" },
    },
    onAPIError: { errorURL: "/auth/" },
    trustedOrigins: [origin, new URL(baseURL).origin, ...allowedOrigins(env)],
    socialProviders: socialProviderOptions(env),
  });
}

// Only this origin and ALLOWED_ORIGINS may be sent back to after sign-in.
function allowedRedirect(env, origin, redirect) {
  if (!redirect) return null;
  try {
    const target = new URL(redirect);
    return [origin, ...allowedOrigins(env)].includes(target.origin) ? target : null;
  } catch {
    return null;
  }
}

function signInPage(origin, params) {
  const page = new URL("/auth/", origin);
  for (const [key, value] of Object.entries(params)) page.searchParams.set(key, value);
  return Response.redirect(page.toString(), 302);
}

async function startSocialSignIn(auth, env, request, url, provider) {
  const redirect = allowedRedirect(env, url.origin, url.searchParams.get("redirect"));
  if (!SOCIAL_PROVIDERS[provider]) return new Response("Invalid provider", { status: 400 });
  if (!redirect) return new Response("redirect must be a URL on an allowed origin", { status: 400 });
  if (!configuredSocialProviders(env).includes(provider)) {
    return signInPage(url.origin, { error: "provider_not_configured", provider });
  }

  // Return through the relay, which reads the session first-party before
  // sending the browser back to the original page.
  const callbackURL = `${url.origin}/api/oauth/relay?redirect=${encodeURIComponent(redirect.toString())}`;
  const result = await auth.api.signInSocial({
    body: { provider, callbackURL, disableRedirect: true },
    headers: request.headers,
    asResponse: true,
  });
  const data = await result.json().catch(() => ({}));
  if (!data.url) return signInPage(url.origin, { error: "provider_not_configured", provider });

  const response = new Response(null, { status: 302, headers: { Location: data.url } });
  for (const cookie of result.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
  return response;
}

function base64url(text) {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function relay(auth, env, request, url) {
  const destination = allowedRedirect(env, url.origin, url.searchParams.get("redirect"));
  if (!destination) return new Response("redirect must be a URL on an allowed origin", { status: 400 });

  const session = await auth.api.getSession({ headers: request.headers }).catch(() => null);
  if (session?.user) {
    const { id, name, email, image } = session.user;
    const user = { id, name, email, image: image ?? null };
    destination.hash = `auth_user=${base64url(encodeURIComponent(JSON.stringify(user)))}`;
  }
  return Response.redirect(destination.toString(), 302);
}

export function isAuthPath(pathname) {
  return pathname.startsWith("/api/auth/") || pathname.startsWith("/api/oauth/");
}

export async function handleAuth(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/api/auth/configured-providers") {
    return json({ providers: configuredSocialProviders(env) });
  }
  if (path === "/api/auth/db-status") {
    return json({ status: await databaseStatus(env) });
  }
  if (!configuredValue(env, "BETTER_AUTH_SECRET")) {
    return json({ error: "Sign-in is not configured on this server (BETTER_AUTH_SECRET is missing)." }, 503);
  }

  const database = openDatabase(env);
  try {
    const auth = createAuth(env, url.origin, database);
    if (path === "/api/oauth/relay") return await relay(auth, env, request, url);
    if (path.startsWith("/api/oauth/")) {
      return await startSocialSignIn(auth, env, request, url, path.split("/")[3]);
    }
    return await auth.handler(request);
  } finally {
    if (database) ctx.waitUntil(database.close());
  }
}
