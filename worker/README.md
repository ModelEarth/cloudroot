# CloudRoot Worker

One Cloudflare Worker serves **https://cloud.model.earth**: the website and
its API on the same origin. There is no separate API host.

```
browser ──> cloud.model.earth ──┬─ /api/*      Worker code (src/)
                                └─ everything  static files (dist/), assembled
                                   else        from the webroot + submodules
```

Pages call `/api/...` on their own origin, so they need no CORS entry.
GitHub Actions builds the static files, pushes config from GitHub secrets
into the Worker, and deploys on every push to `main`.

## Static files

`scripts/build-static.mjs` (`npm run build`) copies the webroot into
`dist/`, with the submodules checked out. It leaves out `chat/` (Next.js,
deployed to Vercel), servers and tooling (`worker/`, `automation/`,
`support/`), dot-files, `node_modules` and key files.

The `auth` submodule is a Next.js app, so its **static export** (`auth/out`,
from `pnpm build` in `auth/`) is copied to `/auth/` in its place. Every one
of its pages is a client component calling `/api/auth`, so no Next.js server
is needed.

`wrangler.toml`'s `[assets]` serves `dist/`; `run_worker_first` sends only
`/api/*` and `/ingest/*` to the Worker code.

## API

| Path | Purpose | Source |
|---|---|---|
| `POST /api/chat` | LLM proxy (Anthropic, OpenAI) | `src/chat.js` |
| `GET /api/key-status`, `/api/server-keys` | Which provider keys the Worker holds (ids only) | `src/keys.js` |
| `GET /api/public-key` | Public JWK of `BROWSER_ENCRYPTION_PRIVATE_KEY` (404 when unset) | `src/keys.js` |
| `POST /api/validate-key` | Checks a provider key against the provider's API | `src/keys.js` |
| `/api/auth/*` | Sign-in (BetterAuth): sign-up, sign-in, sign-out, session, OAuth callbacks | `src/auth/` |
| `GET /api/auth/configured-providers`, `/api/auth/db-status` | Which social providers are set up; database status | `src/auth/` |
| `GET /api/oauth/:provider?redirect=`, `/api/oauth/relay` | Social sign-in by navigation, for pages on other origins | `src/auth/` |
| `GET /api/cms/auth`, `/api/cms/callback` | GitHub sign-in popup for Sveltia CMS and localsite's content tools (needs `CMS_GITHUB_CLIENT_ID`, `CMS_GITHUB_CLIENT_SECRET`) | `src/cms-auth.js` |
| `GET /api/health`, `/api/models`; `POST /api/generate/text`, `image`, `video`, `3d`; `GET /api/generate/video/:id`; `POST /api/upload/tripo`; `GET /api/proxy/model` | Arts Engine API, using the visitor's own keys | `requests/engine/worker/engine.js` |
| `POST /ingest/:WEBHOOK_SECRET` | Transcript webhook from the TranscripTonic extension: opens a PR in `ARCHIVIST_REPO` (needs `WEBHOOK_SECRET`, `ARCHIVIST_TOKEN`) | `tonic/src/` (submodule, not published as static files) |

`/api/server-keys`, `/api/public-key` and `/api/validate-key`
mirror the routes in `chat/server.mjs`, so the `keys` widget and
`requests/engine` work unchanged. The Arts Engine routes are a JavaScript
port of `requests/engine/rust-api`, kept in the `requests` submodule beside
it; locally the engine page still uses the Rust backend on port 8082.
Unlike rust-api, they don't use the Worker's own keys on their own: each
request carries the visitor's key. The exception is Gemini: typing the
`ARTS_ENGINE_PASSPHRASE` secret (12+ characters) as the Gemini key uses the
Worker's `GEMINI_API_KEY` instead. Both are synced from the env file by
`automation/sync-config.sh`. `/api/save-file` (localsite's Markdown
editor) writes to local disk, so it stays local-only; on Cloudflare it
returns 404 and the editor falls back to copying to the clipboard.

## Sign-in

`src/auth/` runs BetterAuth on the Worker, rebuilt from chat's Next.js
routes (see `auth/PLAN.md`). The sign-in pages are the `auth` submodule at
`/auth/`, and localsite's sign-in widget loads `/auth/js/auth-plugin.js`
(set in `support/site/config.yaml`).

- **Without `POSTGRES_URL`**: BetterAuth runs stateless, keeping the session
  in an encrypted cookie. Social sign-in works; email/password is off.
- **With `POSTGRES_URL`**: users, sessions and accounts are stored in
  Postgres, and email/password is on.

Social providers turn on individually once both `<PROVIDER>_CLIENT_ID` and
`<PROVIDER>_CLIENT_SECRET` are set. Register each OAuth app's callback as
`https://cloud.model.earth/api/auth/callback/<provider>`
(e.g. `.../callback/github`).

### CMS sign-in

`src/cms-auth.js` signs editors in to GitHub for Sveltia CMS and localsite's
content tools (`localsite/edit/`), using the popup handshake Sveltia expects
from an external OAuth client. Point the CMS at it with `auth_base_url` and
`auth_endpoint` in the `cms:` block of `support/site/config.yaml`.

It uses its own GitHub OAuth app, `CMS_GITHUB_CLIENT_ID` /
`CMS_GITHUB_CLIENT_SECRET`, with the callback
`https://cloud.model.earth/api/cms/callback`. GitHub's authorization page
shows that app's name ("Authorize Model Earth CMS"). The token is only posted
to this origin or one in `ALLOWED_ORIGINS`.

### Password hashing in Postgres

The free Workers plan allows 10 ms of CPU per request, and that counts only
time the Worker spends computing, not time spent waiting on the database. So
passwords are hashed inside Postgres with pgcrypto's bcrypt
(`crypt(password, gen_salt('bf', 10))`): the Worker sends the password, waits
for the result, and continues in the same request (`src/auth/password.js`).

Older chat accounts held BetterAuth's default scrypt hashes. The Worker still
accepts one (checked once with `node:crypto`, then rewritten as bcrypt), but
the Neon database started empty, so it shouldn't hold any. That check is
CPU-heavy and could exceed the free plan's limit.

bcrypt reads only the first 72 bytes of a password.

### Database

`POSTGRES_URL` picks the driver (`src/auth/db.js`):

- **Neon** (`*.neon.tech`): Neon's serverless driver over HTTP. Recommended.
- **Any other Postgres, e.g. Supabase**: postgres.js over a TCP socket, one
  connection per request. For Supabase, use the connection pooler URL
  (port 6543); the direct `db.<project>.supabase.co` host is IPv6-only on
  newer projects.

Setup, once per database: `node automation/setup-neon.mjs` (see
[automation/README.md](../automation/README.md#setup-neonmjs)) does all
three steps. By hand:

1. Create the database (Neon: a new project; copy its connection string).
2. Run `auth/db/0001_create_better_auth_tables.sql`, then
   `auth/db/0002_enable_pgcrypto.sql`.
3. Put the connection string in your env file as `AUTH_POSTGRES_URL` and run
   `./automation/sync-config.sh`, which stores it as the `POSTGRES_URL`
   secret (or use `gh secret set POSTGRES_URL`), then redeploy.

**The Worker's database is the Neon project `cloudroot`, the user
database.** chat signs in against it too, as `AUTH_POSTGRES_URL`, and hashes
passwords the same way (`chat/lib/auth/password.ts`). chat's own data is in
a separate Neon project, `chat`, which chat reads as `CHAT_POSTGRES_URL`
(`automation/setup-neon-chat.mjs`; on Vercel it's duplicated as
`POSTGRES_URL`, the standard name Vercel's Postgres integrations use). In
the env file the user database is `AUTH_POSTGRES_URL`, which
`sync-config.sh` sends as this Worker's `POSTGRES_URL` secret; the env
file's own `POSTGRES_URL` is synced only with `--database`.

## Config

Non-secret settings are in `wrangler.toml` `[vars]`:

- `ALLOWED_ORIGINS`: other origins whose pages may call the API from a
  browser, with cookies (e.g. `https://model.earth`). Same-origin pages need
  no entry.

Secrets come from GitHub secrets, and `deploy-worker.yml` uploads them with
each deploy (`wrangler deploy --secrets-file`). Unset GitHub secrets are
skipped, so a value set directly with `wrangler secret put` isn't
overwritten.

| Worker secret | GitHub secret | Needed for |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | same | `/api/chat` |
| `BETTER_AUTH_SECRET` | same | all sign-in (min 32 chars) |
| `POSTGRES_URL` | same | email/password sign-in, stored users |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | `GH_CLIENT_ID`, `GH_CLIENT_SECRET` | GitHub sign-in (GitHub reserves the `GITHUB_` prefix) |
| `GOOGLE_`, `MICROSOFT_`, `LINKEDIN_`, `DISCORD_`, `FACEBOOK_` + `CLIENT_ID` / `CLIENT_SECRET` | same | each social provider |
| `BROWSER_ENCRYPTION_PRIVATE_KEY` | same | `/api/public-key` |
| `CMS_GITHUB_CLIENT_ID`, `CMS_GITHUB_CLIENT_SECRET` | same | `/api/cms/*`, the CMS's GitHub sign-in |

The deploy itself needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
The token needs Workers Scripts edit, plus Workers Routes and DNS edit on the
`model.earth` zone for the `cloud.model.earth` custom domain.
[automation/sync-config.sh](../automation/README.md) copies all of these from
a local env file into GitHub; [automation/manual.md](../automation/manual.md)
covers getting them by hand.

## Local development

```bash
cd auth && pnpm install && pnpm build && cd ..   # sign-in pages (auth/out)
cd worker
npm install
npm run build                    # assemble dist/ (add -- --skip-auth to skip /auth)
npm run dev                      # http://localhost:3701
```

`npm run dev` serves the static files and the API together, like
production. It reads config from your env file (`automation/paths.yaml`
`env_file:`, the file `sync-config.sh` uses), passing the env file's
`AUTH_POSTGRES_URL` as `POSTGRES_URL`. To use other values locally, copy
`.dev.vars.example` to `.dev.vars` (git-ignored), which then takes its place.
Production uses the config pushed by the workflow.

The everyday local server is still `PORT=3700 node chat/server.mjs`, which
serves the same paths from the webroot. Run `npm run dev` here alongside it
for sign-in: the widget calls this Worker directly (`api_url_development` in
`support/site/config.yaml`, which also works from any other local static
server), and `chat/server.mjs` passes `/api/auth/*` and `/api/oauth/*` on to
it, so the auth repo's `/auth/` pages and chat use it too. While the Worker
isn't running, those fall back to chat's own sign-in API.
Social sign-in through the local Worker needs OAuth apps whose callback is
`http://localhost:3701/api/auth/callback/<provider>`.

## Testing from a fork

Verified end to end on 22 Aug 2026 against a fork and a personal Cloudflare
account (as `llm-proxy-worker`, this Worker's earlier name).

**The fork's `main` must be current.** GitHub only shows workflows that exist
on the fork's default branch. Push an up-to-date `main` to the fork first:

```bash
git pull upstream main
git push origin main
```

**`sync-config.sh` needs bash.** It won't run in PowerShell without WSL. On
Windows, set values directly instead:

```powershell
$token = (Select-String -Path path\to\docker\.env -Pattern '^CLOUDFLARE_API_TOKEN=' | Select-Object -First 1).Line -replace '^CLOUDFLARE_API_TOKEN=',''
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/CloudRoot --body $token
```

**Pass `sync-config.sh` both arguments.** Its default path assumes a
`docker` directory that CloudRoot doesn't have.

**Remove the custom domain.** A fork deploying to another Cloudflare account
can't claim `cloud.model.earth`: delete the `routes` line in
`wrangler.toml` and use the `workers.dev` URL.

The Cloudflare credentials alone are enough to deploy. Without LLM keys,
`/api/chat` returns `{"error":"ANTHROPIC_API_KEY not configured"}`; without
`BETTER_AUTH_SECRET`, `/api/auth/*` returns 503.

## Adding more LLM providers

Edit `getModel()` in `src/chat.js`: add a `case` for the provider, wire up
its LangChain chat class, add its key to `PROVIDER_ENV_VARS`, and add the key
to the secret list in `deploy-worker.yml` and as a GitHub secret.

## Files

```
.github/workflows/deploy-worker.yml   CI: build static files, push secrets, deploy
worker/wrangler.toml                  Worker config: assets, custom domain, vars
worker/scripts/build-static.mjs       assembles worker/dist from the webroot
worker/src/index.js                   router: /api/* and /ingest/*; all else static
worker/src/chat.js                    LLM proxy
worker/src/keys.js                    keys widget endpoints
worker/src/auth/                      sign-in: BetterAuth, database, password hashing
worker/src/cms-auth.js                GitHub sign-in popup for Sveltia CMS
worker/src/http.js                    CORS and response helpers
worker/.dev.vars.example              local dev config template
support/site/config.yaml              tells localsite where sign-in lives
```
