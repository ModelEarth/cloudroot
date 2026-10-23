# CloudRoot3

A webroot for Cloudflare, [Netlify](https://www.netlify.com/) and Vercel.  Generates Cloudflare site at [cloud.model.earth](https://cloud.model.earth)

On cloud.model.earth:

- [Project Engine](https://cloud.model.earth/requests/engine/) ([/requests/engine](requests/engine/)): the LLM interface
  in the `requests` submodule. Generating needs its Rust backend running on
  your own computer for now.
- [Account](https://cloud.model.earth/auth/): sign-in, optional.
- [Keys](https://cloud.model.earth/keys/): LLM keys, kept in your browser.

## Contributing from a fork

Contributors work in their own fork and send changes back as pull requests.

1. Fork ModelEarth/CloudRoot on GitHub, then clone your fork with its
   submodules:

       git clone --recurse-submodules https://github.com/[your account]/CloudRoot
       cd CloudRoot
       git remote add upstream https://github.com/ModelEarth/CloudRoot

2. Sync often, before starting new work:

       git pull upstream main
       git submodule update --init --recursive
       git push origin main

3. Run the site locally (below), make your changes, push them to your fork,
   and open a pull request to ModelEarth/CloudRoot. Merging to `main` there
   deploys cloud.model.earth.

Changes inside a submodule (`localsite`, `requests`, ...) belong in that
submodule's own repo, so fork and pull-request it too; the CloudRoot pull
request then moves the submodule to the new commit.

If you turn on Actions in your fork, it runs the same deploy workflow on each
push. Without your own Cloudflare secrets it stops at the deploy step, which
is harmless. To deploy
your fork to your own Cloudflare account, see "Testing from a fork" in
[worker/README.md](worker/README.md#testing-from-a-fork).

## Run locally

The site runs the way cloud.model.earth does on Cloudflare, without the
`chat` submodule:

    cd auth && pnpm install && pnpm build && cd ..   # sign-in pages (auth/out)
    cd worker && npm install
    npm run dev

Site comes up at http://localhost:3701, serving the files in this folder
directly, so edits show up when you reload the page. Restart it after adding
a top-level folder or submodule. The sign-in pages need rebuilding only when
the `auth` submodule changes.

With an agent, say "Start CloudRoot" (see [AGENTS.md](AGENTS.md)). It also
offers the older Vercel setup on port 3700, described under
[Vercel](#vercel) below.

## Orchestration

Instead of maintaining Dockerfiles and a Kubernetes cluster, Cloudflare Workers Builds orchestrates deployment directly from GitHub. Each Worker is connected to the repo and given a root directory, the folder that holds its Wrangler configuration file and where its build command runs. On each push, Cloudflare starts a fresh container from its [managed build image](https://developers.cloudflare.com/pages/configuration/build-image/), clones the repo with its submodules, runs that folder's build command, and deploys with npx wrangler deploy. A build and deploy triggers for each Worker only when a commit touches its watch paths, so the repo's folder and submodule layout does the job a Kubernetes manifest would, and the build image stands in for a Docker base image.

## Submodules

| Submodule | Purpose |
|---|---|
| `chat` | The Next.js application. Deploys to Vercel. |
| `auth` | Standalone sign-in app, shared across frontends |
| `keys` | API key management interface |
| `know` | Trade map and knowledge base pages |
| `requests` | Arts engine and request handling |
| `feed` | Feed player React app |
| `localsite` | Shared navigation and map scripts |
| `trade` | Trade data |

## Cloudflare: cloud.model.earth

The `worker/` folder holds a Cloudflare Worker that serves
[cloud.model.earth](https://cloud.model.earth): the static files of this
webroot and its submodules, uploaded as they are, plus the API under `/api/`:
the LLM proxy, the keys widget endpoints, and sign-in (BetterAuth on Postgres,
with the `auth` submodule's pages at `/auth/`). [.assetsignore](.assetsignore)
lists what's left out, including `chat/`, which is too big for Cloudflare.
GitHub Actions deploys it on every push to `main`, pushing config from GitHub secrets into
the Worker. To redeploy without a new commit, run "Deploy Worker
(cloud.model.earth)" from the repo's Actions tab, or
`gh workflow run deploy-worker.yml`. A deploy takes about a minute;
https://cloud.model.earth/api/health returns 200 once it's live.

See [worker/README.md](worker/README.md) for setup, secrets and deployment,
and [PLAN.md](PLAN.md) for the migration steps.

## Vercel

The chat submodule deploys to Vercel directly; it isn't converted for
Cloudflare (see [PLAN.md](PLAN.md)). NodeJS resides in the "chat" submodule.

First-time / from a fresh clone, run:

    git submodule update --init --recursive   # pull in all submodule content
    cd chat && pnpm install                   # install Node deps (needs pnpm)

Launch site, each time (port can be changed):

    PORT=3700 node chat/server.mjs

Site comes up at http://localhost:3700

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/git/external?repository-url=https://github.com/ModelEarth/CloudRoot)

### Status: Working ✅

The chat submodule deploys successfully on Vercel:  
[studio2.vercel.app](https://vercel-root-git-main-dream-studio2.vercel.app)  
[modelearth.vercel.app](https://modelearth.vercel.app) - chat repo is webroot

Vercel builds on each push to `main` of the repo its project is connected
to. Run `node check-package-sync.js` after moving the chat submodule, since
the build stops if the root `package.json` no longer matches chat's.

### Root cause

> The fix below evolved from an initial duplicate-package.json-only workaround
> into also setting Vercel's Root Directory (see Setup below). The diagnosis
> itself is still accurate.

The repo root had no `package.json`. Vercel's build checks the repo root's
`package.json` (not the one inside `chat/`) to decide whether to activate
Corepack (which controls which pnpm version actually runs) and to detect the
Next.js framework version. Without it, two things silently broke:

1. Corepack never activated, so Vercel fell back to its own old bundled pnpm
   (6.35.1), regardless of what version was requested in `vercel.json`'s
   `installCommand`.
2. That old pnpm couldn't read the lockfile (generated by a much newer pnpm),
   so it was discarded and pnpm fell back to live npm registry resolution for
   every package - which triggered a separate, unrelated bug
   (`ERR_INVALID_THIS`) in that old pnpm version's HTTP client.
3. Framework detection also failed separately, since it couldn't find `next`
   listed as a dependency at the repo root either.

### Setup

This repo uses Vercel's "Root Directory" project setting, pointed at `chat/`,
so Vercel treats `chat/` as the working root for install, build, and output -
no `--prefix chat` paths or `outputDirectory` override needed in
`vercel.json`.

However, Vercel still reads the true repo root's `package.json` (outside
`chat/`) early in the build, before Root Directory is applied, specifically
to decide whether to activate Corepack and to detect the Next.js framework
version. So a minimal root `package.json` is still required, containing:

- a `"packageManager"` field matching `chat/package.json`'s pnpm version
- a `"next"` dependency matching `chat/package.json`'s Next.js version (not
  actually installed/used - only read for framework detection)

#### localsite on Vercel

With Root Directory set to `chat/`, Vercel serves only `chat/public/`, so the
`localsite` submodule beside it isn't part of the site on its own.
`vercel.json`'s `buildCommand` copies `../localsite` into
`chat/public/localsite` before `pnpm build`, and `/localsite/` is then served
from this repo's copy.

Chat deployed by itself (e.g. modelearth.vercel.app, from the chat repo) has
no localsite folder, so `chat/next.config.mjs` proxies `/localsite/` from
https://model.earth/localsite/ instead. The proxy is on only when
`chat/public/localsite` is missing at build time.

Sign-in on localsite pages uses chat's own `/api` there, so the session
cookie stays on the Vercel site. The build also copies
`support/site/config.yaml` and the `auth` submodule's widget
(`auth/public/js` to `/auth/js/`) into `chat/public`. Chat deployed by itself
uses its own `chat/public/support/site/config.yaml`, which loads the widget
from cloud.model.earth and also points it at chat's `/api`.

### Scripts

- `set-root-directory.js` - Sets this project's Root Directory to `"chat"`
  via Vercel's REST API. Requires `VERCEL_API_TOKEN` in `.env.local` (not
  committed). Run: `node set-root-directory.js`
- `check-package-sync.js` - Runs automatically as part of `installCommand`
  before every deploy. Compares the root and `chat/package.json`'s
  `packageManager` and `next` values, and fails the build loudly if they've
  drifted out of sync, rather than silently breaking. Ignores pnpm's
  integrity hash suffix when comparing versions.

### Note on webroot

This same root cause likely affects the full webroot repo, which also has no
root-level `package.json`.
