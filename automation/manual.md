# Manual Alternative

Steps for getting the 4 Cloudflare Worker config values (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and adding
them to GitHub by hand. See [README.md](README.md) in this folder instead if
you'd rather run `sync-config.sh` to do this from your local env file (the
one `paths.yaml` in this folder points at).

## GitHub Actions config

These values are provided to GitHub Actions runners during a workflow run — they are never sent to a browser. A repo's Cloudflare Worker deploy workflow uses them to configure Cloudflare (a service that *can* safely hold runtime config and serve requests), not to hand keys to frontend code. GitHub's own UI calls this "Secrets" — that's the setting name you'll see below.

## 1. Get your API keys

- Anthropic: [console.anthropic.com](https://console.anthropic.com) → **API Keys**
- OpenAI: [platform.openai.com](https://platform.openai.com/api-keys) → **API Keys**

## 2. Get your Cloudflare credentials

1. Create an API token: see
   [Get a Cloudflare API token](README.md#get-a-cloudflare-api-token).
2. Save your **Account ID** to `CLOUDFLARE_ACCOUNT_ID` in your local env
   file, copying it from the right sidebar of the Cloudflare dashboard (or
   the `Workers & Pages` overview page). Or leave it blank and run
   `sync-config.sh`, which looks up the Account ID with your
   `CLOUDFLARE_API_TOKEN` and saves it there for you.

## 3. Add these to GitHub

In the target repo: **Settings → Secrets and variables → Actions → New repository secret**

Add each of these (name must match exactly):

| Name                     | Value                                  |
|--------------------------|-----------------------------------------|
| `ANTHROPIC_API_KEY`      | Your Anthropic key                     |
| `OPENAI_API_KEY`         | Your OpenAI key                        |
| `CLOUDFLARE_API_TOKEN`   | The token you created in step 2        |
| `CLOUDFLARE_ACCOUNT_ID`  | Your Cloudflare account ID              |

Since these are often private repos with multiple collaborators: this repo
config is only visible to workflows, never in logs or to collaborators via
the UI — but anyone with **write access** can modify a workflow file to
print or exfiltrate a value in a run they trigger. If you want tighter
control, use **Environments** (Settings → Environments → New environment →
add the config there instead of at repo level) and require reviewers to
approve deployments that use them.
