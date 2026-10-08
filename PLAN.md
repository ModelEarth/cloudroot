# PLAN.md — CloudRoot on Cloudflare

Goal: one Cloudflare Worker at **cloud.model.earth** serving both the website
and its API, with sign-in on Postgres (Neon preferred, Supabase supported).
`chat/` (Next.js) keeps deploying to Vercel and is not part of the
Cloudflare site.

Repos involved:
- `CloudRoot`: https://github.com/ModelEarth/CloudRoot (holds `worker/`, workflows)
- `auth`: https://github.com/ModelEarth/auth (sign-in pages; see `auth/PLAN.md`)
- `keys`, `localsite`, `requests`, `know`, `feed`, `trade`: static content in the build
- `chat`: https://github.com/ModelEarth/chat (Vercel; not deployed here)

## How it fits together

```
cloud.model.earth ──┬─ /api/*     Worker code: /api/chat, /api/key-status,
                    │             keys widget APIs, /api/auth (sign-in)
                    └─ all else   static files built from the webroot
                                  (submodules checked out), minus chat/,
                                  with auth/ replaced by its static export
```

- **Static files.** Workers serve a folder of static files, so every path
  except `/api/*` comes from `worker/dist`, assembled from the webroot by
  `worker/scripts/build-static.mjs`.
- **API.** `/api/chat` and `/api/key-status` stay as they were, joined by the
  small APIs moved from `chat/server.mjs` and by sign-in.
- **Browser access.** Pages and API share one origin, so the site's own
  browser calls need no allowed-origins entry. `ALLOWED_ORIGINS` in
  `wrangler.toml` lists only other sites (e.g. https://model.earth).
- **No `api.model.earth`.** The API is at `cloud.model.earth/api/...`.

## Steps

### 1. Build folder in CI ✅
`deploy-worker.yml` checks out submodules, builds the `auth` static export,
and runs `npm run build` in `worker/` to assemble `worker/dist`. It deploys on
every push to `main` except chat-only changes.

### 2. Static files and custom domain ✅
`worker/wrangler.toml`: `[assets] directory = "./dist"`, with
`run_worker_first = ["/api/*", "/sanity", "/sanity/*"]`, and
`routes = [{ pattern = "cloud.model.earth", custom_domain = true }]`.
The Worker is renamed `llm-proxy-worker` → `cloudroot`, since it now serves
the whole site. The old `llm-proxy-worker` stays deployed until it's deleted
in the Cloudflare dashboard.

### 3. Route only /api/* to Worker code ✅
`worker/src/index.js` handles `/api/*` (and the `/sanity` proxy), and hands
anything else back to the static files.

### 4. Deploy and check pages ✅
localsite's sign-in defaults assume the chat app under `/chat/`. Rather
than change shared localsite code, CloudRoot ships `/webroot.yaml` (read by
localsite before `docker/webroot.yaml`) pointing the widget at
`/auth/js/auth-plugin.js` and the API at `/api`. The same paths work locally,
where `chat/server.mjs` serves `/auth/js/` from `chat/auth/js/`.
`/api/save-file` stays local-only; on Cloudflare localsite's editor falls
back to the clipboard, as it already does on static hosts.

### 5. Small APIs from chat/server.mjs ✅
Moved into `worker/src/keys.js` and `worker/src/sanity.js`:
- `/api/server-keys` (served by the same handler as `/api/key-status`),
  `/api/public-key`, `/api/validate-key`. Used by the keys widget and
  `requests/engine`.
- `/api/sanity-status` and the `/sanity/*` proxy, forwarding to the hosted
  Sanity site at `SANITY_SITE_URL` (the Worker can't run the site itself).

### 6. Sign-in on the Worker ✅
`worker/src/auth/` runs BetterAuth, replacing chat's Next.js routes for this
site (`/api/auth/*`, `/api/oauth/*`, `configured-providers`, `db-status`).
The `auth` submodule is a static export served at `/auth/`, and carries the
vanilla sign-in widget at `/auth/js/`.

- **Database, generic.** `POSTGRES_URL` picks the driver: Neon's HTTP driver
  for `*.neon.tech`, or postgres.js over TCP for any other Postgres
  (Supabase via its pooler URL).
- **Hashing on Postgres.** Passwords are hashed with pgcrypto's bcrypt inside
  the database. The Workers CPU limit (10 ms on the free plan) counts only
  compute, not time waiting on the database, so the Worker sends the
  password, waits, and gets the result in the same request, with no
  callback. Legacy scrypt hashes from chat are checked once and rewritten as
  bcrypt.
- **Database.** The Neon project `cloudroot` (`aws-us-east-1`), created by
  `automation/setup-neon.mjs` on 8 October 2026. Without `POSTGRES_URL`,
  sessions would live in an encrypted cookie and email/password would be off.

Remaining:
- [x] Neon database created and set as `POSTGRES_URL`
      (`node automation/setup-neon.mjs`). Test an email/password sign-up.
- [ ] Register OAuth apps with callback
      `https://cloud.model.earth/api/auth/callback/<provider>`, and add their
      client id and secret to the env file (the GitHub app's pair syncs as
      `GH_CLIENT_ID` / `GH_CLIENT_SECRET`).
- [ ] Point chat at the same Neon database, after porting its
      Supabase-specific migrations (`auth/PLAN.md`, open items 3-4). Users
      aren't copied from Supabase.

## End state

| | Where | Deployed by |
|---|---|---|
| Website (webroot + submodules) | cloud.model.earth | `deploy-worker.yml` → Worker static files |
| API (`/api/*`) | cloud.model.earth/api | `deploy-worker.yml` → Worker code |
| Sign-in pages | cloud.model.earth/auth/ | `auth` static export, same workflow |
| `chat/` (Next.js) | Vercel | Vercel's git integration, unchanged |

## Superseded: chat on Cloudflare via OpenNext

The earlier plan deployed `chat/` itself to Cloudflare through OpenNext
(`deploy-chat-worker.yml`, Hyperdrive for its Postgres driver). It's on
hold: OpenNext's Cloudflare adapter doesn't support the Node runtime that
Next.js 16 requires for proxy files (see README.md). Chat's pieces this site
needs (sign-in and the small APIs) now run in the CloudRoot Worker instead.
`deploy-chat-worker.yml` only runs when started by hand.
