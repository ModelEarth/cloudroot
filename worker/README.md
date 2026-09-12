# LLM Proxy Worker

## Cloudflare Worker + GitHub Secrets

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

Getting the 4 keys/credentials this needs (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and adding
them to GitHub by hand is covered in
[automation/manual.md](../automation/manual.md) ("Manual Alternative") — or
use `sync-secrets.sh` below if you keep them in a local env file.

## Sync secrets from a local env file with `sync-secrets.sh`

The script lives in `CloudRoot/automation/`, not in this `worker/` folder —
it's shared across repos, not specific to this one worker (see the comment
at the top of the script for why). Full usage, what it does, and its
default env-file lookup order are documented in
[automation/README.md](../automation/README.md); quick example:

```bash
./automation/sync-secrets.sh /path/to/cloud.env ModelEarth/CloudRoot
./automation/sync-secrets.sh /path/to/cloud.env owner/other-repo   # for another repo
```

See `worker/.dev.vars.example` for this worker's current set of keys.

This only touches the four secrets this worker needs — a shared env file holds
many more keys for other services (the Rust API, Arts Engine, Sanity,
Better Auth, Supabase, etc.) that this prompt intentionally leaves alone.

## Testing from a fork

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

**The script's defaults do not resolve from CloudRoot.** Its built-in default
path assumes a `docker` directory beside wherever it's run from, which
CloudRoot does not have — `docker` lives in the `webroot` checkout. Pass both
arguments explicitly, as shown above.

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
automation/sync-secrets.sh            # syncs secrets from a local env file into GitHub via gh CLI (shared, not worker-specific)
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
├── automation/  
│   ├── sync-secrets.sh             ← shared, not worker-specific — see its header comment  
│   ├── README.md  
│   └── manual.md  
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