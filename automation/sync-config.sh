#!/usr/bin/env bash
# Sync the 4 Cloudflare Worker secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY,
# CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID) from a local env file into a
# repo's GitHub Actions secrets, via the GitHub CLI.
#
# Lives here in CloudRoot/automation/, not inside any one repo's worker/
# folder: without moving it, CloudRoot/automation is usable by agents working
# in adjacent repos on different local ports (cloudflare on 8888, webroot on
# 8887, etc.) via a relative path like ../CloudRoot/automation/sync-secrets.sh,
# instead of each repo needing its own duplicate copy.
#
# Usage: ./sync-secrets.sh [path-to-env-file] [github-owner/repo]
# Default env file path (when no path is passed, or "paths.yaml" is passed
# literally as a placeholder meaning "use the remembered default") comes
# from paths.yaml's env_file: key, next to this script. paths.yaml is
# generated/updated by this script itself, not hand-maintained: the first
# time it doesn't exist yet, this prompts before assuming the fallback
# (../../safe/cloudroot.env, a folder outside any git repo); after that (or
# if you pass a real path as the first argument), the choice is remembered
# as the new default for next time. It's machine-local (gitignored), so
# each person's own choice stays their own.
#
# If the fallback path specifically doesn't exist yet, it's created from
# ModelEarth/docker's .env.example template (fetched via curl/wget) rather
# than erroring - see the placeholder-values warning further down for why
# the script then stops instead of syncing straight from that fresh file.
#
# Passing "paths.yaml" as the first argument (rather than a real path) is
# how to override just the second argument (the target repo) while still
# using the remembered env file - the alternative, ./sync-secrets.sh ""
# owner/repo, works too but is easy to mistype or misread.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATHS_YAML="$SCRIPT_DIR/paths.yaml"
FALLBACK_ENV_FILE="../../safe/cloudroot.env"
TEMPLATE_URL="https://raw.githubusercontent.com/ModelEarth/docker/refs/heads/main/.env.example"

if [[ -n "${1:-}" && "$1" != "paths.yaml" ]]; then
  ENV_FILE="$1"
elif [[ -f "$PATHS_YAML" ]]; then
  yaml_value=$(grep -E '^env_file:' "$PATHS_YAML" | tail -n1 | cut -d ':' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')
  ENV_FILE="${yaml_value:-$FALLBACK_ENV_FILE}"
else
  # First run: no paths.yaml yet, and no path given. Ask rather than silently
  # assuming the fallback - paths.yaml gets created below once ENV_FILE is
  # confirmed to actually exist.
  read -rp "No paths.yaml found yet - use $FALLBACK_ENV_FILE as your env file? [Y/n] " use_fallback
  if [[ -z "$use_fallback" || "$use_fallback" =~ ^[Yy] ]]; then
    ENV_FILE="$FALLBACK_ENV_FILE"
  else
    read -rp "Path to your env file: " ENV_FILE
  fi
fi

# Target repo: an explicit second argument always wins. Otherwise, read the
# owner/repo straight out of this checkout's own git remote (SCRIPT_DIR/..
# is always the CloudRoot checkout, wherever this script was invoked from) -
# that's whichever GitHub account this copy was cloned/forked from, not any
# one hardcoded account. Only if that can't be determined (e.g. no git
# remote configured) do we ask.
detect_repo_from_git_config() {
  local remote_url
  remote_url=$(git -C "$SCRIPT_DIR/.." config --get remote.origin.url 2>/dev/null) || return 1
  [[ -n "$remote_url" ]] || return 1
  echo "$remote_url" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##; s#/$##'
}

if [[ -n "${2:-}" ]]; then
  REPO="$2"
elif detected_repo="$(detect_repo_from_git_config)" && [[ -n "$detected_repo" ]]; then
  REPO="$detected_repo"
  echo "Using repo from git remote: $REPO (pass one as the 2nd argument to override)"
else
  read -rp "GitHub account of your CloudRoot fork: " fork_account
  REPO="$fork_account/CloudRoot"
fi
KEYS=(ANTHROPIC_API_KEY OPENAI_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ "$ENV_FILE" == "$FALLBACK_ENV_FILE" ]]; then
    echo "$ENV_FILE doesn't exist yet - creating it from ModelEarth/docker's .env.example template."
    mkdir -p "$(dirname "$ENV_FILE")"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$TEMPLATE_URL" -o "$ENV_FILE"
    elif command -v wget >/dev/null 2>&1; then
      wget -qO "$ENV_FILE" "$TEMPLATE_URL"
    else
      echo "Error: need curl or wget installed to fetch the template." >&2
      exit 1
    fi
    # The template ships real-looking placeholder values for some keys (e.g.
    # ANTHROPIC_API_KEY=your-anthropic-key), not blank ones - syncing as-is
    # would push those placeholders as if they were real secrets. Stop here
    # rather than continue past a freshly-created, unedited file.
    echo "Created $ENV_FILE with placeholder values from the template."
    echo "Edit it with your real ANTHROPIC_API_KEY / OPENAI_API_KEY / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, then re-run this script."
    exit 0
  else
    echo "Error: $ENV_FILE not found. Pass its path as the first argument." >&2
    exit 1
  fi
fi

# Remember this run's (now-confirmed-valid) path as the new default, so the
# next run without an explicit argument reuses it.
cat > "$PATHS_YAML" <<EOF
# Default paths used by scripts in this folder (e.g. sync-secrets.sh).
# Generated/updated automatically - reflects the env file path last used.
# Not committed to git (see .gitignore); pass a different path as
# sync-secrets.sh's first argument to change it.

env_file: $ENV_FILE
EOF

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) not found. Install from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# Probe secrets access on $REPO before looping through keys, rather than
# letting the first `gh secret set` call die mid-loop with a bare API error
# ("failed to fetch public key: HTTP 403: You must have repository read
# permissions or have the repository secrets fine-grained permission").
# If the active account lacks access, try each other logged-in account and
# switch to the first one that works - only the other logged-in accounts
# on this machine are ever tried, never anything requiring new credentials.
if ! gh secret list --repo "$REPO" >/dev/null 2>&1; then
  original_account=$(gh auth status 2>&1 | awk '/Logged in to github\.com account/{acct=$0} /Active account: true/{print acct}' | sed -E 's/.*account ([A-Za-z0-9_.-]+).*/\1/')
  matched_account=""
  while IFS= read -r candidate; do
    [[ "$candidate" == "$original_account" ]] && continue
    gh auth switch --user "$candidate" >/dev/null 2>&1 || continue
    if gh secret list --repo "$REPO" >/dev/null 2>&1; then
      matched_account="$candidate"
      break
    fi
  done < <(gh auth status 2>&1 | sed -nE 's/.*Logged in to github\.com account ([A-Za-z0-9_.-]+).*/\1/p')

  if [[ -n "$matched_account" ]]; then
    echo "Switched gh account to '$matched_account' (has access to $REPO)."
  else
    gh auth switch --user "$original_account" >/dev/null 2>&1 || true
    echo "Error: none of your logged-in gh accounts can manage Actions secrets on $REPO" >&2
    echo "(no repository read / secrets permission)." >&2
    echo >&2
    echo "Your logged-in gh accounts:" >&2
    gh auth status 2>&1 | sed 's/^/  /' >&2
    echo >&2
    echo "Log in to one with access: gh auth login, then re-run." >&2
    exit 1
  fi
fi

# Fallback for CLOUDFLARE_ACCOUNT_ID when it's not in $ENV_FILE: read it from
# `wrangler whoami`, if Wrangler is installed and already logged in. If not
# logged in, the sync loop below offers to run `npx wrangler login` (an
# interactive browser flow) right there and retry. Account IDs are 32-char
# hex, so grab the first match from the output rather than parsing
# wrangler's table formatting, which differs across versions.
fetch_account_id_from_wrangler() {
  command -v npx >/dev/null 2>&1 || return 1
  npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -n1
}

# Detects unedited template placeholders (e.g. "your-anthropic-key",
# "your-openai-api-key") generically by pattern rather than matching one
# exact hardcoded string per key - the exact wording of ModelEarth/docker's
# .env.example has changed before, and an exact-string check silently stops
# catching a placeholder the moment the wording changes, letting it sync as
# if it were a real secret. Matches "your-...-key"/"your-...-token" (any
# words in between), case-insensitively.
is_placeholder_value() {
  [[ "$1" =~ ^[Yy]our[-_].*(key|token)$ ]]
}

echo "Syncing secrets from $ENV_FILE into $REPO ..."
echo

for key in "${KEYS[@]}"; do
  # Last matching line wins, strip surrounding quotes and any trailing
  # " # comment" (unquoted inline comments, as in the .env.example template).
  # `|| true` matters: if $key isn't in the file at all, grep exits 1 (no
  # match), and under pipefail that would otherwise kill the whole script
  # right here via set -e, before the "skip" handling below ever runs.
  value=$( { grep -E "^${key}=" "$ENV_FILE" || true; } | tail -n1 | cut -d '=' -f2- | sed -E -e 's/^"//' -e 's/"$//' -e 's/[[:space:]]+#.*$//')

  if [[ -n "$value" ]] && is_placeholder_value "$value"; then
    echo "  skip  $key (placeholder, not a real value)"
    if [[ "$key" == "OPENAI_API_KEY" ]]; then
      echo "        Get one: platform.openai.com/api-keys (free to create an account"
      echo "        and a key; API usage itself is pay-as-you-go, not free)."
    fi
    continue
  fi

  if [[ -z "$value" && "$key" == "CLOUDFLARE_ACCOUNT_ID" ]]; then
    value=$(fetch_account_id_from_wrangler || true)
    if [[ -n "$value" ]]; then
      echo "  found $key via 'wrangler whoami' (not in $ENV_FILE)"
    elif command -v npx >/dev/null 2>&1; then
      read -rp "  CLOUDFLARE_ACCOUNT_ID not found. Run 'npx wrangler login' now (opens a browser)? [y/N] " do_login
      if [[ "$do_login" =~ ^[Yy] ]]; then
        npx wrangler login
        value=$(fetch_account_id_from_wrangler || true)
        if [[ -n "$value" ]]; then
          echo "  found $key via 'wrangler whoami' after login"
        fi
      fi
    fi
  fi

  if [[ -z "$value" ]]; then
    if [[ "$key" == "CLOUDFLARE_ACCOUNT_ID" ]]; then
      echo "  skip  $key (not set in $ENV_FILE, and 'wrangler whoami' found nothing)"
      echo "        Get it one of two ways, then either add it to $ENV_FILE or re-run:"
      echo "          1. npx wrangler login   (opens a browser to authorize this machine),"
      echo "             then re-run this script - it'll pick it up via 'wrangler whoami'"
      echo "          2. Cloudflare dashboard -> Workers & Pages overview page (right"
      echo "             sidebar) -> Account ID"
    else
      echo "  skip  $key (not set in $ENV_FILE)"
    fi
    continue
  fi

  printf '%s' "$value" | gh secret set "$key" --repo "$REPO" >/dev/null
  echo "  set   $key"
done

echo
echo "Current secrets on $REPO:"
gh secret list --repo "$REPO"
