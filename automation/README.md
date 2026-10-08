# Cloud Automation

[manual.md](manual.md) | [Social sign-in](#social-sign-in)

## Social sign-in

Social sign-in buttons (Google, GitHub, Microsoft, LinkedIn, Discord,
Facebook) appear once a provider's `<PROVIDER>_CLIENT_ID` and
`<PROVIDER>_CLIENT_SECRET` are both set. Until then the sign-in pages offer
email and password only.

1. Register an OAuth app with each provider. Step-by-step instructions per
   provider are in chat's
   [oauth-setup.md](https://github.com/ModelEarth/chat/blob/main/auth/oauth-setup.md).
   Use these callback URLs:
   - `https://cloud.model.earth/api/auth/callback/<provider>` (the Worker)
   - `https://modelearth.vercel.app/api/auth/callback/<provider>` (chat on Vercel)
   - `http://localhost:3700/api/auth/callback/<provider>` (local)
2. Add each app's client id and secret to your local env file, e.g.
   `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`.
3. Push them where they're used:
   - The Worker: `./automation/sync-config.sh`, which stores them as GitHub
     secrets for the deploy workflow (see below). Push to `main` or rerun
     "Deploy Worker" to apply.
   - chat on Vercel: `node automation/vercel-env.mjs modelearth --config
     chat/scripts/vercel-env.config.json`, which sets them and redeploys
     (see [`vercel-env.mjs`](#vercel-envmjs)).
   - Locally: restart `node chat/server.mjs`, which reads the env file.

## `sync-config.sh`

Copies the Cloudflare Worker's config values from a local env file into a
repo's GitHub Actions config, via the GitHub CLI:

- the 4 deploy values: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- the sign-in values: `BETTER_AUTH_SECRET`, `BROWSER_ENCRYPTION_PRIVATE_KEY`,
  and each social provider's `<PROVIDER>_CLIENT_ID` / `_CLIENT_SECRET`
- the Worker's database: `AUTH_POSTGRES_URL` (written by
  [`setup-neon.mjs`](#setup-neonmjs)), stored as the `POSTGRES_URL` secret.
  With `--database`, the env file's `POSTGRES_URL` is sent instead; that's
  usually chat's database, which the Worker shouldn't share (see
  [worker/README.md](../worker/README.md#database))

GitHub reserves the `GITHUB_` prefix for secret names, so the GitHub OAuth
app's `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are stored as
`GH_CLIENT_ID` / `GH_CLIENT_SECRET`; the deploy workflow maps them back.

The env file path is remembered for you: pass it once as the first
argument, and the script writes it to `paths.yaml` (generated here,
gitignored — it's a per-machine preference, not something to share) so the
next run without an argument reuses it. The first time `paths.yaml` doesn't
exist yet and no path is given, it asks for a path outright — nothing is
assumed or guessed.

If the file you point at doesn't exist yet, the script asks before creating
it from [`automation/.env.example`](.env.example) (the canonical sample env
file committed in this folder) — a typo'd path would otherwise look
identical to a legitimate first-run path, so nothing is written until you
confirm. That template ships real-looking placeholder values for some keys
(e.g. `ANTHROPIC_API_KEY=your-anthropic-key`), so the script stops right
after creating it rather than syncing those placeholders as if they were
real values — edit the file with your actual values, then run the command
again.

It lives here rather than inside any one repo's `worker/` folder because
it's shared, not specific to one worker: without moving it, `CloudRoot/automation`
is usable by agents working in adjacent repos on different local ports
(cloudroot on 3700, webroot on 8887) via a relative path like
`../CloudRoot/automation/sync-config.sh`, instead of each repo needing its
own duplicate copy. See the comment at the top of the script itself for the
same note.

## `setup-neon.mjs`

Sets up the Worker's sign-in database, the steps in
[auth/README.md](../auth/README.md#database):

1. Creates a Neon project named `cloudroot` through the Neon API, or finds
   it if it already exists.
2. Runs `auth/db/0001_create_better_auth_tables.sql` and
   `auth/db/0002_enable_pgcrypto.sql` over the direct connection (safe to
   repeat), then checks that the
   four tables exist and pgcrypto's bcrypt works.
3. Saves the pooled connection string (`-pooler` in the hostname) in your
   env file as `AUTH_POSTGRES_URL`, sets the `POSTGRES_URL` secret on GitHub, and starts
   the "Deploy Worker" workflow.

```bash
node automation/setup-neon.mjs                       # env file from paths.yaml, repo from git remote
node automation/setup-neon.mjs paths.yaml owner/CloudRoot
node automation/setup-neon.mjs --no-github           # database only
node automation/setup-neon.mjs --no-deploy           # set the secret, don't redeploy
```

It needs `NEON_API_KEY` in the env file. Neon only creates API keys in its
dashboard, like Cloudflare's tokens: console.neon.tech → **Settings →
Personal API keys → Create new API key**, then paste it after
`NEON_API_KEY=`. Neon shows the key only once.
An organization API key (switch to the organization, then **Settings →
API keys**; org admins only) works too. It belongs to the organization, so
members can share it and it keeps working when someone leaves. With a
personal key in exactly one organization, the script finds `NEON_ORG_ID`
and saves it; with several, it lists them so you can pick one.
Optional: `NEON_PROJECT_NAME` (default `cloudroot`) and `NEON_REGION_ID`
(default `aws-us-east-1`, Virginia, next to Vercel's default `iad1`
functions and to commons' Neon projects). The region is fixed once the
project exists.

When `AUTH_POSTGRES_URL` is already set, the Neon API isn't called, so the
same command runs the migrations against an existing database (Neon,
Supabase or other Postgres) and syncs it. The connection string is never
printed. It uses postgres.js from `worker/node_modules`, so run
`npm install` in `worker/` first, plus `gh` for the GitHub steps.

`AUTH_POSTGRES_URL` is the user database, shared by the Worker and chat's
sign-in. chat's own data is in a separate database (`setup-neon-chat.mjs`
below), which chat reads as `POSTGRES_URL`.

## `setup-neon-chat.mjs`

Sets up chat's data database, a Neon project apart from the user database:

1. Creates the Neon project `chat` (or finds it).
2. Saves its pooled connection string in the env file as
   `CHAT_POSTGRES_URL`.
3. Runs chat's migrations there (their Neon versions,
   `chat/lib/db/migrate.ts`) over the direct connection, then chat's
   `db:verify`. Safe to repeat.

```bash
node automation/setup-neon-chat.mjs
node automation/setup-neon-chat.mjs --no-migrate   # project and env file only
```

It needs `NEON_API_KEY` (as above) and chat's dependencies
(`cd chat && pnpm install`). Optional: `NEON_CHAT_PROJECT_NAME` (default
`chat`). With the user table in another database, chat's migrations skip the
triggers that check `user_id` against it, so chat accepts any `user_id`.

| Env file | Database | chat reads it as |
|---|---|---|
| `AUTH_POSTGRES_URL` | Neon project `cloudroot`: users, sessions, accounts (also the Worker's `POSTGRES_URL` secret) | `AUTH_POSTGRES_URL` |
| `CHAT_POSTGRES_URL` | Neon project `chat`: chats, messages, documents, settings, logs | `POSTGRES_URL` |

Locally, set `POSTGRES_URL` to the `CHAT_POSTGRES_URL` value. On Vercel,
`vercel-env.mjs` sets both.

## `vercel-env.mjs`

Sets environment variables on chat's Vercel projects from your env file,
through Vercel's REST API, then redeploys production, since Vercel doesn't
rebuild when env vars change. Values are never printed.

By default it sets chat's two databases: `POSTGRES_URL` from
`CHAT_POSTGRES_URL` (chat's data) and `AUTH_POSTGRES_URL` (the user
database it shares with the Worker). `--config` adds other
vars from a JSON file, e.g. the social sign-in keys in
`chat/scripts/vercel-env.config.json`.

```bash
node automation/vercel-env.mjs --list                    # projects the token can see
node automation/vercel-env.mjs vercel-root modelearth    # set both URLs, redeploy, check db-status
node automation/vercel-env.mjs modelearth --config chat/scripts/vercel-env.config.json
node automation/vercel-env.mjs modelearth --no-deploy    # set only; next deployment picks it up
```

- An existing variable keeps its environments and type; only the value
  changes. A new one is added as encrypted, for Production and Preview (or
  the config file's `environment`).
- After the redeploy finishes it checks
  `https://<production domain>/api/auth/db-status`.
- Projects can also come from `VERCEL_PROJECTS=name1,name2` in the env file.

It needs `VERCEL_API_TOKEN` in the env file: create one at
https://vercel.com/account/tokens, scoped to the team that owns chat's
projects. The script finds each project in your personal account or any
team the token reaches; `VERCEL_TEAM_ID` narrows that to one team.

The token can read and change every project in that team, so delete it
(Account Settings → Tokens) when you no longer need it, or straight away if
the env file may have been shared. An expiry date is optional: it retires a
forgotten or leaked token on its own, but the script then stops with a 401
until you make a new one. `set-root-directory.js` at the repo root reads the same token name,
from `.env.local`.

## GitHub Actions config

GitHub stores these values as encrypted config for a repo's Actions
workflows — provided to a workflow run, never sent to a browser. A repo's
Cloudflare Worker deploy workflow reads them to configure Cloudflare (a
service that *can* safely hold runtime config and serve requests), not to
hand keys to frontend code. GitHub's own UI and CLI call this feature
"Secrets" (Settings → Secrets and variables → Actions, `gh secret set`),
so you'll see that word in GitHub's own screens and command output even
though this doc mostly says "config."

Getting the 4 values this needs and adding them to GitHub can be done by
hand — see [manual.md](manual.md) ("Manual Alternative") — or with
`sync-config.sh` below, if you keep them in a local env file.

## Get a Cloudflare API token

This step can't be automated: Cloudflare only creates API tokens from its
dashboard (or from another token that already has permission to create
tokens), so each person creates their own once.

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**, and
   pick the **"Edit Cloudflare Workers"** template. It already includes
   Workers Scripts edit access (which also covers `sync-config.sh`'s
   workers.dev subdomain lookup) and Account Settings read.
   - Under **Account Resources**, select your account.
   - Under **Zone Resources**, select a zone (domain) or choose all zones,
     then create the token.
2. Paste the token after `CLOUDFLARE_API_TOKEN=` in your local env file
   (the one `paths.yaml` points at). Paste it into the file rather than
   into a chat or terminal, so it stays out of history.

## Sync config from a local env file with `sync-config.sh`

If you already keep these values in a local env file, you don't have to
copy them into the GitHub UI by hand. Run the script instead of asking an
AI agent to type out the `gh` commands each time — a fixed script can't
misread the instructions, forget a flag, or accidentally echo a value,
which a freshly-prompted agent could.

Simplest form:

```bash
./sync-config.sh
```

The very first time, with no `paths.yaml` yet, it asks for the path to your
env file (creating it from a template if it doesn't exist yet — see above);
once that file has real values in it and a sync succeeds, the path becomes
the remembered default, so every run after that is just the bare command
above.

With no repo given either, the target repo is read from this checkout's own
git remote — whichever account you forked/cloned `CloudRoot` from, not any
one hardcoded account — so this naturally targets *your* fork. If that
can't be determined (no git remote configured), it prompts:
`GitHub account of your CloudRoot fork:`.

To target a different repo while still using the remembered env file, pass
the literal word `paths.yaml` as the first argument — it's a placeholder
telling the script "don't override the env file, just the repo":

```bash
./sync-config.sh paths.yaml [GitHub Acct]/[Repo]
```

`paths.yaml` there means the script falls through to whatever's saved in
that file, the same as omitting the argument entirely — `./sync-config.sh
""  owner/repo` also works, but `paths.yaml` is clearer to read. To set a
*different* env file (which also becomes the new remembered default), pass
its real path instead:

```bash
./sync-config.sh /path/to/cloud.env ModelEarth/CloudRoot
./sync-config.sh /path/to/cloud.env owner/other-repo   # for another repo
./sync-config.sh paths.yaml ModelEarth/CloudRoot --database   # POSTGRES_URL, not AUTH_POSTGRES_URL
```

It requires the [GitHub CLI](https://cli.github.com/) (`gh`) installed and
authenticated (`gh auth status`). For each of the values above, it
reads it from the env file, pushes it with `gh secret set` (never printing
the value to the terminal or logs), skips any key that's missing from the
file or still a template placeholder instead of guessing, and finishes with
`gh secret list` so you can confirm they landed.

It then saves the Worker's URL back into your env file as
`CLOUDFLARE_WORKER_URL` (`https://[worker].[subdomain].workers.dev`): the
worker name comes from `worker/wrangler.toml`, and your account's
workers.dev subdomain from the Cloudflare API, using the same
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The URL responds once
the "Deploy Worker" workflow has deployed the Worker. The site itself is at
https://cloud.model.earth.

A relative `env_file:` in `paths.yaml` is relative to this `automation/`
folder (the same rule `chat/server.mjs` uses), so `../../safe/[name].env`
works from wherever you run the script.

If you'd rather have an AI coding assistant do this interactively (e.g. to
adapt it to a differently-shaped `.env`), point it at this script and ask
it to run it or explain what it does — that's safer than asking it to
improvise the `gh` commands from scratch.

`ANTHROPIC_API_KEY` is the standard key name across the team's repos — your
env file should use that name (not the retired `CLAUDE_API_KEY`) for
`sync-config.sh` to pick it up. See a given repo's `worker/.dev.vars.example`
for its current set of keys, including `CLAUDE_CODE_OAUTH_TOKEN` as a
subscription-based alternative to `ANTHROPIC_API_KEY` for local dev.

This only touches the values the Cloudflare Worker uses — your local env
file likely holds many more keys for other services (the Rust API, Arts
Engine, Sanity, Supabase, etc.) that this script intentionally leaves
alone.

## Testing from a fork / other repos

Verified end to end on 22 Aug 2026 against a fork and a personal Cloudflare
account.

**The fork's `main` must be current.** GitHub only shows workflows that exist
on the fork's default branch. A fork created before the workflows were added
shows an empty Actions tab and offers workflow templates instead. Push an
up-to-date `main` to the fork first:

```bash
git pull upstream main
git push origin main
```

**`sync-config.sh` needs bash.** It will not run in PowerShell without WSL
installed. On Windows, set the two Cloudflare values directly instead:

```powershell
$token = (Select-String -Path path\to\your.env -Pattern '^CLOUDFLARE_API_TOKEN=' | Select-Object -First 1).Line -replace '^CLOUDFLARE_API_TOKEN=',''
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo> --body $token
```

Repeat for `CLOUDFLARE_ACCOUNT_ID`. Reading from the file rather than typing
the value keeps it out of shell history.

**No path is assumed** — you're asked for one the first time `paths.yaml`
doesn't have `env_file:` set yet, and it's remembered from then on. Point it
at whatever env file you actually use; pass a different path explicitly at
any time to change it.

**`failed to fetch public key: HTTP 403: You must have repository read
permissions or have the repository secrets fine-grained permission.`** The
gh account that's currently active doesn't have config access on the
target repo — the script checks for this upfront, tries your other
logged-in accounts, and switches to the first one that works, printing one
line about the switch. If none work, or if you see the raw error above
instead (e.g. running `gh secret set` directly), the fix is the same: run
`gh auth status` to see your logged-in accounts, then `gh auth switch
--user <account>` to one with read/write access to that repo, and retry.
