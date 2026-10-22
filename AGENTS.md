On initial agent usage, invoke a sandbox using steps in support/python/PYTHON.md

Do not execute code external to this CloudRepos webroot.
Do not modify files external to this CloudRepos webroot.
Request permission when accessing externally residing config files.

## Start

"Start", "Start Website" and "Start CloudRoot" all begin here. Ask the user which way to run the site, with these two choices, then follow only the section for their choice:

1. CloudRoot for Cloudflare (recommended) - Port 3701
2. Vercel with older chat repo - Port 3700

If the request already names one (e.g. "Start CloudRoot 3701", "start cloudflare", "start vercel", "start chat"), skip the question and run that one.

Run all commands below from the ../CloudRoot folder.

Once the site responds (e.g. `curl -s -o /dev/null -w "%{http_code}" http://localhost:3701/`), open it in a browser tab at the chosen port. Use Brave when it's installed, otherwise the default browser:

open -a "Brave Browser" http://localhost:3701

When started from ../desktop/AGENTS.md, follow its browser guidance instead (a kiosk window by default for CloudRoot).

### 1. CloudRoot for Cloudflare (recommended) - Port 3701

This matches the cloud.model.earth deployment: one Cloudflare Worker serves the static site and the /api routes on the same origin. It doesn't use the chat submodule, which is too big for free Cloudflare.

cd worker && npm run build && npm run dev

Site comes up at http://localhost:3701

- `npm run build` copies the webroot into worker/dist (leaving out chat), and `npm run dev` serves only that copy. Run the build again after a pull or after editing pages, or the site shows the old files.
- The build copies the sign-in pages from auth/out and stops if they're missing. Build them first with `cd auth && pnpm install && pnpm build`, or use `npm run build -- --skip-auth` to build without them.
- If worker/node_modules is missing, run `npm install` in worker first.
- `npm run dev` reads secrets from the env file named in automation/paths.yaml (`env_file:`). A worker/.dev.vars file, if present, is used instead.
- As on Cloudflare, /api/save-file (the Markdown editor's save) returns 404.
- More details are in worker/README.md.

### 2. Vercel with older chat repo - Port 3700

This runs the site through the chat submodule's Next.js server, as deployed on Vercel. If chat is empty, run `git submodule update --init chat` and then `cd chat && pnpm install`.

NODE_OPTIONS=--max-old-space-size=8192 PORT=3700 node chat/server.mjs

Site comes up at http://localhost:3700

The Next.js dev server inside grows with each recompile, and with Node's default heap limit (about 4 GB) a long editing session ends in "JavaScript heap out of memory". The larger limit avoids that; restarting the server after a long session also frees the memory.

For sign-in, also run the CloudRoot Worker locally, which serves the sign-in API at http://localhost:3701/api:

cd worker && npm run dev

This is the same Worker as choice 1, so if choice 1 is already running, sign-in already works and the Worker doesn't need starting again.

## Deploy

Deploying to Cloudflare and to Vercel is simply pushing to `main` on GitHub. GitHub Actions deploys cloud.model.earth (.github/workflows/deploy-worker.yml), and Vercel builds the chat submodule.

Before pushing, show the user what will be committed and confirm, since a push publishes the live site. Don't run `npx wrangler deploy` locally: it skips the secrets the workflow pushes from GitHub. More details are in README.md.

## Git Commits

Never add Claude Code attribution or co-authored-by lines to commits.
