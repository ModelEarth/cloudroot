# Cloud Automation

[manual.md](manual.md)

## `sync-secrets.sh`

Syncs the 4 Cloudflare Worker secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) from a local env file into a
repo's GitHub Actions secrets, via the GitHub CLI.

The env file path is remembered for you: pass it once as the first
argument, and the script writes it to `paths.yaml` (generated here,
gitignored — it's a per-machine preference, not something to share) so the
next run without an argument reuses it. The first time `paths.yaml` doesn't
exist yet and no path is given, it asks before assuming the fallback
(`../../safe/cloudroot.env` — a folder outside any git repo, so nothing here
depends on a particular sibling repo like `docker` being checked out)
rather than silently guessing.

If that fallback file doesn't exist yet either, it's created for you from
[ModelEarth/docker's `.env.example`](https://raw.githubusercontent.com/ModelEarth/docker/refs/heads/main/.env.example)
template. That template ships real-looking placeholder values for some keys
(e.g. `ANTHROPIC_API_KEY=your-anthropic-key`), so the script stops right
after creating it rather than syncing those placeholders as if they were
real secrets — edit the file with your actual values, then run the command
again.

It lives here rather than inside any one repo's `worker/` folder because
it's shared, not specific to one worker: without moving it, `CloudRoot/automation`
is usable by agents working in adjacent repos on different local ports
(cloudflare on 8888, webroot on 8887, etc.) via a relative path like
`../CloudRoot/automation/sync-secrets.sh`, instead of each repo needing its
own duplicate copy. See the comment at the top of the script itself for the
same note.

## GitHub Secrets

GitHub Secrets are provided by GitHub Actions runners during a workflow run — they are never sent to a browser. A repo's Cloudflare Worker deploy workflow uses them to configure Cloudflare (a service that *can* safely hold runtime secrets and serve requests), not to hand keys to frontend code.

Getting the 4 keys/credentials this needs and adding them to GitHub can be
done by hand — see [manual.md](manual.md) ("Manual Alternative") — or with
`sync-secrets.sh` below, if you keep them in a local env file.

## Sync secrets from a local env file with `sync-secrets.sh`

If you already keep these values in a shared `docker/.env` file (the local
dev env file used across ModelEarth's repos), you don't have to copy them
into the GitHub UI by hand. Run the script instead of asking an AI agent to
type out the `gh` commands each time — a fixed script can't misread the
instructions, forget a flag, or accidentally echo a secret, which a
freshly-prompted agent could.

Simplest form:

```bash
./sync-secrets.sh
```

The very first time, with no `paths.yaml` yet, it asks whether to use
`../../safe/cloudroot.env` (creating it from a template if it doesn't exist
yet — see above) or lets you type a different path; either way, once that
file has real values in it and a sync succeeds, the path becomes the
remembered default, so every run after that is just the bare command above.

With no repo given either, the target repo is read from this checkout's own
git remote — whichever account you forked/cloned `CloudRoot` from, not any
one hardcoded account — so this naturally targets *your* fork. If that
can't be determined (no git remote configured), it prompts:
`GitHub account of your CloudRoot fork:`.

To target a different repo while still using the remembered env file, pass
the literal word `paths.yaml` as the first argument — it's a placeholder
telling the script "don't override the env file, just the repo":

```bash
./sync-secrets.sh paths.yaml [GitHub Acct]/[Repo]
```

`paths.yaml` there means the script falls through to whatever's saved in
that file, the same as omitting the argument entirely — `./sync-secrets.sh
""  owner/repo` also works, but `paths.yaml` is clearer to read. To set a
*different* env file (which also becomes the new remembered default), pass
its real path instead:

```bash
./sync-secrets.sh /path/to/cloud.env ModelEarth/CloudRoot
./sync-secrets.sh /path/to/cloud.env owner/other-repo   # for another repo
```

It requires the [GitHub CLI](https://cli.github.com/) (`gh`) installed and
authenticated (`gh auth status`). For each of the four secrets above, it
reads the value from the env file, pushes it with `gh secret set` (never
printing the value to the terminal or logs), skips any key that's missing
from the file instead of guessing, and finishes with `gh secret list` so
you can confirm all four landed.

If you'd rather have an AI coding assistant do this interactively (e.g. to
adapt it to a differently-shaped `.env`), point it at this script and ask
it to run it or explain what it does — that's safer than asking it to
improvise the `gh` commands from scratch.

`ANTHROPIC_API_KEY` is the standard key name across the team's repos — your
env file should use that name (not the retired `CLAUDE_API_KEY`) for
`sync-secrets.sh` to pick it up. See a given repo's `worker/.dev.vars.example`
for its current set of keys, including `CLAUDE_CODE_OAUTH_TOKEN` as a
subscription-based alternative to `ANTHROPIC_API_KEY` for local dev.

This only touches the four secrets a Cloudflare Worker deploy needs —
`docker/.env` holds many more keys for other services (the Rust API, Arts
Engine, Sanity, Better Auth, Supabase, etc.) that this script intentionally
leaves alone.

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

**`sync-secrets.sh` needs bash.** It will not run in PowerShell without WSL
installed. On Windows, set the two secrets directly instead:

```powershell
$token = (Select-String -Path path\to\docker\.env -Pattern '^CLOUDFLARE_API_TOKEN=' | Select-Object -First 1).Line -replace '^CLOUDFLARE_API_TOKEN=',''
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/<repo> --body $token
```

Repeat for `CLOUDFLARE_ACCOUNT_ID`. Reading from the file rather than typing
the value keeps it out of shell history.

**The fallback default (`../../safe/cloudroot.env`) works the same from any
repo**, since it's outside any git checkout rather than depending on a
sibling `docker` folder existing. If you'd rather point at an existing
shared file instead (e.g. `webroot/docker/.env`), pass its path explicitly
the first time, as shown above.

**`failed to fetch public key: HTTP 403: You must have repository read
permissions or have the repository secrets fine-grained permission.`** The
gh account that's currently active doesn't have access to manage secrets on
the target repo — the script checks for this upfront and reports it more
plainly, running `gh auth status` for you and printing its output so you
can see all your logged-in accounts right there. If you see the raw error
above instead (e.g. running `gh secret set` directly), the fix is the same:
run `gh auth status` yourself, then `gh auth switch --user <account>` to
one with read/write
access to that repo, and retry.
