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
`/api/*` and `/sanity/*` to the Worker code.

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
| `GET /api/sanity-status`, `/sanity/*` | Proxy to the hosted Sanity site at `SANITY_SITE_URL` | `src/sanity.js` |

`/api/server-keys`, `/api/public-key`, `/api/validate-key` and the Sanity
proxy mirror the routes in `chat/server.mjs`, so the `keys` widget and
`requests/engine` work unchanged. `/api/save-file` (localsite's Markdown
editor) writes to local disk, so it stays local-only; on Cloudflare it
returns 404 and the editor falls back to copying to the clipboard.

## Sign-in

`src/auth/` runs BetterAuth on the Worker, rebuilt from chat's Next.js
routes (see `auth/PLAN.md`). The sign-in pages are the `auth` submodule at
`/auth/`, and localsite's sign-in widget loads `/auth/js/auth-plugin.js`
(set in `webroot.yaml`).

- **Without `POSTGRES_URL`**: BetterAuth runs stateless, keeping the session
  in an encrypted cookie. Social sign-in works; email/password is off.
- **With `POSTGRES_URL`**: users, sessions and accounts are stored in
  Postgres, and email/password is on.

Social providers turn on individually once both `<PROVIDER>_CLIENT_ID` and
`<PROVIDER>_CLIENT_SECRET` are set. Register each OAuth app's callback as
`https://cloud.model.earth/api/auth/callback/<provider>`
(e.g. `.../callback/github`).

### Password hashing in Postgres

The free Workers plan allows 10 ms of CPU per request, and that counts only
time the Worker spends computing, not time spent waiting on the database. So
passwords are hashed inside Postgres with pgcrypto's bcrypt
(`crypt(password, gen_salt('bf', 10))`): the Worker sends the password, waits
for the result, and continues in the same request (`src/auth/password.js`).

Older chat accounts held BetterAuth's default scrypt hashes. The Worker still
accepts one (checked once with `node:crypto`, then rewritten as bcrypt), but
users aren't copied from Supabase, so the Neon database shouldn't hold any.
That check is CPU-heavy and could exceed the free plan's limit.

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

**The Worker's database is the Neon project `cloudroot`.** chat hashes
passwords the same way (`chat/lib/auth/password.ts`), so chat should move to
this database rather than the Worker to chat's Supabase one (`auth/PLAN.md`,
open items 3-4). Users aren't copied from Supabase. Until chat moves, the env
file keeps the Worker's database as `AUTH_POSTGRES_URL`, apart from chat's
`POSTGRES_URL`, and `sync-config.sh` syncs `POSTGRES_URL` only with
`--database`.

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
| `SANITY_SITE_URL` (var or secret) | — | `/sanity/*` proxy |

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
cp .dev.vars.example .dev.vars   # fill in what you need; git-ignored
npm run dev                      # http://localhost:8787
```

`npm run dev` serves the static files and the API together, like
production. `.dev.vars` is only for `wrangler dev`; production uses the
config pushed by the workflow.

The everyday local server is still `PORT=3700 node chat/server.mjs`, which
serves the same paths from the webroot plus chat's own API.

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
worker/src/index.js                   router: /api/* and /sanity/*; all else static
worker/src/chat.js                    LLM proxy
worker/src/keys.js                    keys widget endpoints
worker/src/auth/                      sign-in: BetterAuth, database, password hashing
worker/src/sanity.js                  Sanity proxy
worker/src/http.js                    CORS and response helpers
worker/.dev.vars.example              local dev config template
webroot.yaml                          tells localsite where sign-in lives
```
