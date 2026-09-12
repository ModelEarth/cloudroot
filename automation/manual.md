# Manual Alternative

Steps for getting the 4 Cloudflare Worker secrets (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and adding
them to GitHub by hand. See [README.md](README.md) in this folder instead if
you'd rather run `sync-secrets.sh` to do this from a `docker/.env` file.

## GitHub Secrets

GitHub Secrets are provided by GitHub Actions runners during a workflow run — they are never sent to a browser. A repo's Cloudflare Worker deploy workflow uses them to configure Cloudflare (a service that *can* safely hold runtime secrets and serve requests), not to hand keys to frontend code.

## 1. Get your API keys

- Anthropic: [console.anthropic.com](https://console.anthropic.com) → **API Keys**
- OpenAI: [platform.openai.com](https://platform.openai.com/api-keys) → **API Keys**

## 2. Get your Cloudflare credentials

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**
   - Use the "Edit Cloudflare Workers" template, scoped to your account.
2. Note your **Account ID** (right sidebar of the Cloudflare dashboard, or
   `Workers & Pages` overview page) — or skip this if you'll use
   `sync-secrets.sh` instead: it falls back to reading the Account ID from
   `wrangler whoami` when it's not in your `.env` file (after a one-time
   `npx wrangler login`).

## 3. Add secrets to GitHub

In the target repo: **Settings → Secrets and variables → Actions → New repository secret**

Add each of these (name must match exactly):

| Secret name             | Value                                  |
|--------------------------|-----------------------------------------|
| `ANTHROPIC_API_KEY`      | Your Anthropic key                     |
| `OPENAI_API_KEY`         | Your OpenAI key                        |
| `CLOUDFLARE_API_TOKEN`   | The token you created in step 2        |
| `CLOUDFLARE_ACCOUNT_ID`  | Your Cloudflare account ID             |

Since these are often private repos with multiple collaborators: repo
secrets are only visible to workflows, never in logs or to collaborators via
the UI — but anyone with **write access** can modify a workflow file to
print or exfiltrate a secret in a run they trigger. If you want tighter
control, use **Environments** (Settings → Environments → New environment →
add the secrets there instead of at repo level) and require reviewers to
approve deployments that use them.
