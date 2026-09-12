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
# Default env file path (when none is passed) comes from paths.yaml's
# env_file: key, next to this script. paths.yaml is generated/updated by
# this script itself, not hand-maintained: pass a path once as the first
# argument and it's remembered as the new default for next time. It's
# machine-local (gitignored), so each person's own choice stays their own.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATHS_YAML="$SCRIPT_DIR/paths.yaml"
FALLBACK_ENV_FILE="../docker/.env"

if [[ -n "${1:-}" ]]; then
  ENV_FILE="$1"
elif [[ -f "$PATHS_YAML" ]]; then
  yaml_value=$(grep -E '^env_file:' "$PATHS_YAML" | tail -n1 | cut -d ':' -f2- | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//')
  ENV_FILE="${yaml_value:-$FALLBACK_ENV_FILE}"
else
  ENV_FILE="$FALLBACK_ENV_FILE"
fi

REPO="${2:-ModelEarth/CloudRoot}"
KEYS=(ANTHROPIC_API_KEY OPENAI_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID)

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Pass its path as the first argument." >&2
  exit 1
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

# Fallback for CLOUDFLARE_ACCOUNT_ID when it's not in $ENV_FILE: read it from
# `wrangler whoami`, if Wrangler is installed and already logged in (run
# `npx wrangler login` first — that part is an interactive browser flow this
# script can't do for you). Account IDs are 32-char hex, so grab the first
# match from the output rather than parsing wrangler's table formatting,
# which differs across versions.
fetch_account_id_from_wrangler() {
  command -v npx >/dev/null 2>&1 || return 1
  npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -n1
}

echo "Syncing secrets from $ENV_FILE into $REPO ..."
echo

for key in "${KEYS[@]}"; do
  # last matching line wins, strip surrounding quotes, ignore commented-out lines
  value=$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 | cut -d '=' -f2- | sed -e 's/^"//' -e 's/"$//')

  if [[ -z "$value" && "$key" == "CLOUDFLARE_ACCOUNT_ID" ]]; then
    value=$(fetch_account_id_from_wrangler || true)
    if [[ -n "$value" ]]; then
      echo "  found $key via 'wrangler whoami' (not in $ENV_FILE)"
    fi
  fi

  if [[ -z "$value" ]]; then
    echo "  skip  $key (not set in $ENV_FILE)"
    continue
  fi

  printf '%s' "$value" | gh secret set "$key" --repo "$REPO" >/dev/null
  echo "  set   $key"
done

echo
echo "Current secrets on $REPO:"
gh secret list --repo "$REPO"
