# LLM Proxy Worker

## Cloudflare + LangChain + GitHub Secrets

A Cloudflare Worker that holds your LLM API keys server-side and exposes a
single `/api/chat` endpoint. Your frontend JS calls the Worker — it never
touches an Anthropic or OpenAI key directly. GitHub Actions deploys the
Worker and pushes your keys from **GitHub Secrets** into **Cloudflare
Secrets** on every push to `main`.

```
frontend JS  --->  Cloudflare Worker (/api/chat)  --->  Anthropic / OpenAI
                    (holds API keys as secrets)
```

## GitHub Secrets

GitHub Secrets are provided by GitHub Actions runners during a workflow run — they are never sent to a browser. This repo uses them to configure Cloudflare (a service that *can* safely hold runtime secrets and serve requests), not to hand keys to frontend code.

## 1. Get your API keys

- Anthropic: [console.anthropic.com](https://console.anthropic.com) → **API Keys**
- OpenAI: [platform.openai.com](https://platform.openai.com/api-keys) → **API Keys**

## 2. Get your Cloudflare credentials

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**
   - Use the "Edit Cloudflare Workers" template, scoped to your account.
2. Note your **Account ID** (right sidebar of the Cloudflare dashboard, or
   `Workers & Pages` overview page) — or skip this if you'll use
   `sync-secrets.sh` below: it falls back to reading the Account ID from
   `wrangler whoami` when it's not in your `.env` file (after a one-time
   `npx wrangler login`).

## 3. Add secrets to GitHub

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

Add each of these (name must match exactly):

| Secret name             | Value                                  |
|--------------------------|-----------------------------------------|
| `ANTHROPIC_API_KEY`      | Your Anthropic key                     |
| `OPENAI_API_KEY`         | Your OpenAI key                        |
| `CLOUDFLARE_API_TOKEN`   | The token you created in step 2        |
| `CLOUDFLARE_ACCOUNT_ID`  | Your Cloudflare account ID             |

Since this is a private repo with multiple collaborators: repo secrets are
only visible to workflows, never in logs or to collaborators via the UI —
but anyone with **write access** can modify a workflow file to print or
exfiltrate a secret in a run they trigger. If you want tighter control,
use **Environments** (Settings → Environments → New environment → add the
secrets there instead of at repo level) and require reviewers to approve
deployments that use them.

## 3a. Or: sync secrets from `docker/.env` with `sync-secrets.sh`

If you already keep these values in a shared `docker/.env` file (the local
dev env file used across ModelEarth's repos), you don't have to copy them
into the GitHub UI by hand. Run the script instead of asking an AI agent
to type out the `gh` commands each time — a fixed script can't
misread the instructions, forget a flag, or accidentally echo a secret,
which a freshly-prompted agent could.

```bash
cd worker
./sync-secrets.sh                              # defaults: ../docker/.env, ModelEarth/CloudRoot
./sync-secrets.sh path/to/.env owner/repo       # or override either
```

It requires the [GitHub CLI](https://cli.github.com/) (`gh`) installed and
authenticated (`gh auth status`). For each of the four secrets above, it
reads the value from `docker/.env`, pushes it with `gh secret set` (never
printing the value to the terminal or logs), skips any key that's missing
from the file instead of guessing, and finishes with `gh secret list` so
you can confirm all four landed.

If you'd rather have an AI coding assistant do this interactively (e.g. to
adapt it to a differently-shaped `.env`), point it at this script and ask
it to run it or explain what it does — that's safer than asking it to
improvise the `gh` commands from scratch.

`ANTHROPIC_API_KEY` is the standard key name across the team's repos —
`docker/.env` should use that name (not the retired `CLAUDE_API_KEY`) for
`sync-secrets.sh` to pick it up. See `worker/.dev.vars.example` for the
current set of keys, including `CLAUDE_CODE_OAUTH_TOKEN` as a
subscription-based alternative to `ANTHROPIC_API_KEY` for local dev.

This only touches the four secrets this worker needs — `docker/.env` holds
many more keys for other services (the Rust API, Arts Engine, Sanity,
Better Auth, Supabase, etc.) that this prompt intentionally leaves alone.

## 3b. Testing from a fork

Verified end to end on 22 Aug 2026 against a fork and a personal Cloudflare
account. Three things differ from the main-repo path above.

**The fork's `main` must be current.** GitHub only shows workflows that exist
on the fork's default branch. A fork created before the workflows were added
shows an empty Actions tab and offers workflow templates instead. Push an
up-to-date `main` to the fork first:

```bash
git pull upstream main
git push origin main
```

**`sync-secrets.sh` needs bash.** It will not run in PowerShell without WSL
installed. On Windows, set the two secrets directly instead:

```powershell
$token = (Select-String -Path path\to\docker\.env -Pattern '^CLOUDFLARE_API_TOKEN=' | Select-Object -First 1).Line -replace '^CLOUDFLARE_API_TOKEN=',''
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/CloudRoot --body $token
```

Repeat for `CLOUDFLARE_ACCOUNT_ID`. Reading from the file rather than typing
the value keeps it out of shell history.

**The script's defaults do not resolve from CloudRoot.** `../docker/.env`
assumes a `docker` directory beside `worker`, which CloudRoot does not have —
`docker` lives in the `webroot` checkout. Pass both arguments explicitly.

### Deploying without LLM keys

The Cloudflare credentials alone are enough to deploy. `ANTHROPIC_API_KEY`
and `OPENAI_API_KEY` can be left unset while verifying the pipeline; the
workflow pushes empty strings, and the Worker returns
`{"error":"ANTHROPIC_API_KEY not configured"}` on request rather than
failing. Useful for confirming the GitHub Secrets to Cloudflare chain works
before spending on API credit.

Verify with:

```bash
curl -X POST https://llm-proxy-worker.<subdomain>.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

A `Method not allowed` response to a plain GET also confirms the Worker is
live, since it only handles `POST /api/chat`.


## 4. Deploy

Push to `main` with changes under `worker/`, or trigger manually from the
**Actions** tab (`workflow_dispatch`). The workflow:

1. Installs dependencies in `worker/`
2. Pushes `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` into Cloudflare as Worker
   secrets via `wrangler secret put`
3. Runs `wrangler deploy`

After the first deploy, note the Worker URL Cloudflare prints
(`https://llm-proxy-worker.<your-subdomain>.workers.dev`) and update it in
your frontend code.

## 5. Local development (optional)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars   # fill in real keys locally, not committed
npm run dev
```

`.dev.vars` is git-ignored — it's only for local `wrangler dev` testing and
is never used in production (production uses the secrets pushed by the
Actions workflow).

## 6. Call it from the frontend

See `frontend-example.js`. No keys anywhere in the frontend bundle — just a
`fetch()` to your Worker's `/api/chat` endpoint, with `provider` set to
`"anthropic"` or `"openai"` per request.

## Files

```
.github/workflows/deploy-worker.yml   # CI: deploy + sync secrets
worker/src/index.js                   # Worker: LangChain LLM proxy
worker/wrangler.toml                  # Worker config
worker/package.json                   # Worker deps (@langchain/anthropic, @langchain/openai)
worker/.dev.vars.example              # local dev secrets template
worker/sync-secrets.sh                # syncs secrets from docker/.env into GitHub via gh CLI
frontend-example.js                   # example fetch() call from frontend
```

## Adding more providers / models

Edit `getModel()` in `worker/src/index.js` — add a new `case` for the
provider, wire up its LangChain chat class, and add the matching key as
both a GitHub secret and a `wrangler secret put` line in the workflow.

```
CloudRoot/  
├── .github/workflows/  
│   ├── deploy-worker.yml           ← commit as-is  
│   └── deploy-chat-worker.yml      ← commit as-is  
├── worker/  
│   ├── src/index.js  
│   ├── package.json  
│   ├── wrangler.toml  
│   ├── .dev.vars.example  
│   └── .gitignore                  ← already updated  
├── frontend-example.js  
├── README.md  
├── PLAN.md  
└── chat/ — edit submodule in modelearth/chat directly, then bump CloudRoot pointer  
    ├── open-next.config.ts         ← commit as-is  
    ├── wrangler.jsonc               ← commit as-is  
    ├── .gitignore                   ← merge chat-gitignore-additions.txt into this  
    └── package.json                 ← PLAN.md is merging package.json.additions.md into this  
```