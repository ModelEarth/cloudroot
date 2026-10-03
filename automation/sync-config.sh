#!/usr/bin/env bash
# Copies the Cloudflare Worker's config values from a local env file into a
# repo's GitHub Actions config, via the GitHub CLI: the 4 deploy values
# (ANTHROPIC_API_KEY, OPENAI_API_KEY, CLOUDFLARE_API_TOKEN,
# CLOUDFLARE_ACCOUNT_ID) plus the sign-in values (BETTER_AUTH_SECRET,
# BROWSER_ENCRYPTION_PRIVATE_KEY and each social provider's
# <PROVIDER>_CLIENT_ID / _SECRET). Values missing from the env file, or still
# template placeholders, are skipped.
#
# GitHub reserves the GITHUB_ prefix for secret names, so GITHUB_CLIENT_ID /
# GITHUB_CLIENT_SECRET are stored as GH_CLIENT_ID / GH_CLIENT_SECRET;
# .github/workflows/deploy-worker.yml maps them back.
#
# POSTGRES_URL is synced only with --database, since the env file's
# POSTGRES_URL may be a database shared with chat (see worker/README.md,
# "Database"). Pass --database once it holds the Worker's own database.
#
# Lives here in CloudRoot/automation/, not inside any one repo's worker/
# folder: without moving it, CloudRoot/automation is usable by agents working
# in adjacent repos on different local ports (cloudflare on 8888, webroot on
# 8887, etc.) via a relative path like ../CloudRoot/automation/sync-config.sh,
# instead of each repo needing its own duplicate copy.
#
# Usage: ./sync-config.sh [path-to-env-file] [github-owner/repo] [--database]
# Default env file path (when no path is passed, or "paths.yaml" is passed
# literally as a placeholder meaning "use the remembered default") comes
# from paths.yaml's env_file: key, next to this script. paths.yaml is
# generated/updated by this script itself, not hand-maintained: the first
# time it doesn't exist yet, this asks for a path outright — no path is
# assumed. After that (or if you pass a real path as the first argument),
# the choice is remembered as the new default for next time. It's
# machine-local (gitignored), so each person's own choice stays their own.
#
# If the file you point at doesn't exist yet, this asks before creating it
# from automation/.env.example (the canonical sample env file committed in
# this folder) rather than silently bootstrapping whatever path was typed -
# see the placeholder-values warning further down for why the script then
# stops instead of syncing straight from that fresh file.
#
# Passing "paths.yaml" as the first argument (rather than a real path) is
# how to override just the second argument (the target repo) while still
# using the remembered env file - the alternative, ./sync-config.sh ""
# owner/repo, works too but is easy to mistype or misread.

set -euo pipefail

# Pull the --database flag out of the positional arguments.
SYNC_DATABASE=""
positional=()
for arg in "$@"; do
  if [[ "$arg" == "--database" ]]; then SYNC_DATABASE=1; else positional+=("$arg"); fi
done
set -- "${positional[@]+"${positional[@]}"}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATHS_YAML="$SCRIPT_DIR/paths.yaml"
ENV_EXAMPLE="$SCRIPT_DIR/.env.example"

# Reads paths.yaml's env_file: key, stripping a trailing whitespace-preceded
# inline comment (e.g. "../foo.env  # laptop") before trimming/unquoting -
# same parsing as chat/lib/parse-env-file-setting.mjs, so a hand-edited
# paths.yaml line can't silently resolve to a bogus path. The `|| true` on
# the grep matters: with no env_file: line at all (e.g. a hand-edited or
# corrupted paths.yaml), grep exits 1, and under `pipefail` that would
# otherwise abort the whole script right here instead of falling into the
# empty-value prompt below.
read_env_file_setting() {
  { grep -E '^env_file:' "$PATHS_YAML" || true; } \
    | tail -n1 \
    | cut -d ':' -f2- \
    | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//'
}

# A relative env_file: in paths.yaml is relative to this automation folder -
# the same rule chat/server.mjs uses - not to wherever the script was run
# from, so the saved path never needs to spell out the folders above the
# webroot (e.g. ../../safe/[name].env rather than an absolute path).
# Paths typed or passed as an argument are relative to the current folder,
# like any other shell path.
if [[ -n "${1:-}" && "$1" != "paths.yaml" ]]; then
  ENV_FILE="$1"
elif [[ -f "$PATHS_YAML" ]]; then
  yaml_value=$(read_env_file_setting)
  if [[ -z "$yaml_value" ]]; then
    read -rp "No env_file: set in $PATHS_YAML yet. Path to your env file: " ENV_FILE
  elif [[ "$yaml_value" == /* ]]; then
    ENV_FILE="$yaml_value"
  else
    ENV_FILE="$SCRIPT_DIR/$yaml_value"
  fi
else
  # First run: no paths.yaml yet, and no path given.
  read -rp "No paths.yaml found yet. Path to your env file: " ENV_FILE
fi

if [[ -z "$ENV_FILE" ]]; then
  echo "Error: no env file path given." >&2
  exit 1
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
KEYS=(ANTHROPIC_API_KEY OPENAI_API_KEY CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  BETTER_AUTH_SECRET BROWSER_ENCRYPTION_PRIVATE_KEY
  GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
  MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET
  DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET FACEBOOK_CLIENT_ID FACEBOOK_CLIENT_SECRET)
if [[ -n "$SYNC_DATABASE" ]]; then KEYS+=(POSTGRES_URL); fi

CREATED_FROM_TEMPLATE=""
if [[ ! -f "$ENV_FILE" ]]; then
  # No path is assumed anymore (see header comment), so a typo'd path looks
  # identical to a legitimate first-run path at this point - ask before
  # writing anything, rather than silently bootstrapping whatever was typed.
  echo "$ENV_FILE doesn't exist yet."
  read -rp "Create it from automation/.env.example? [y/N] " confirm_create
  if [[ ! "$confirm_create" =~ ^[Yy] ]]; then
    echo "Nothing created. Re-run with the correct path (or answer y to bootstrap this one)." >&2
    exit 1
  fi
  if [[ ! -f "$ENV_EXAMPLE" ]]; then
    echo "Error: template not found at $ENV_EXAMPLE." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$ENV_FILE")"
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  CREATED_FROM_TEMPLATE=1
fi

# Remember this run's (now-confirmed-valid) path as the new default, so the
# next run without an explicit argument reuses it. Written for a
# freshly-created file too (not just a pre-existing one), so a first-run
# bootstrap is actually remembered instead of re-prompting next time.
# Saved relative to this folder (see above) so it stays machine-neutral;
# falls back to the absolute path if perl isn't available.
ENV_FILE="$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")"
saved_env_file=$(perl -MFile::Spec -e 'print File::Spec->abs2rel(@ARGV)' "$ENV_FILE" "$SCRIPT_DIR" 2>/dev/null || true)
cat > "$PATHS_YAML" <<EOF
# Default paths used by scripts in this folder (e.g. sync-config.sh).
# Generated/updated automatically - reflects the env file path last used.
# A relative env_file: is relative to this automation folder.
# Not committed to git (see .gitignore); pass a different path as
# sync-config.sh's first argument to change it.

env_file: ${saved_env_file:-$ENV_FILE}
EOF

if [[ -n "$CREATED_FROM_TEMPLATE" ]]; then
  # The template ships real-looking placeholder values for some keys (e.g.
  # ANTHROPIC_API_KEY=your-anthropic-key), not blank ones - syncing as-is
  # would push those placeholders as if they were real secrets. Stop here
  # rather than continue past a freshly-created, unedited file.
  echo "Created $ENV_FILE with placeholder values from automation/.env.example."
  echo "Edit it with your real ANTHROPIC_API_KEY / OPENAI_API_KEY / CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID, then re-run this script."
  exit 0
fi

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

# Fallback for CLOUDFLARE_ACCOUNT_ID when it's blank in $ENV_FILE: ask the
# Cloudflare API which accounts CLOUDFLARE_API_TOKEN can reach (synced just
# before it - see KEYS order).
# Only used when that's exactly one account, as it is for a token made from
# the "Edit Cloudflare Workers" template with one account selected; with
# several, there's no safe way to pick. Account IDs are 32-char hex, which
# avoids needing a JSON parser like jq.
fetch_account_id_from_api() {
  local ids
  [[ -n "${CF_API_TOKEN:-}" ]] || return 1
  ids=$(curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts" 2>/dev/null \
    | grep -oE '"id"[[:space:]]*:[[:space:]]*"[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | sort -u) || return 1
  [[ $(printf '%s\n' "$ids" | grep -c .) -eq 1 ]] || return 1
  echo "$ids"
}

# Writes key=value into $ENV_FILE, replacing an existing key= line in place
# or appending one.
save_env_value() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    [[ -z "$(tail -c1 "$ENV_FILE")" ]] || echo >> "$tmp"
    echo "${key}=${value}" >> "$tmp"
  fi
  # cat rather than mv, so the env file keeps its own permissions.
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

# Detects unedited template placeholders (e.g. "your-anthropic-key",
# "your-openai-api-key") generically by pattern rather than matching one
# exact hardcoded string per key - the exact wording of ModelEarth/docker's
# .env.example has changed before, and an exact-string check silently stops
# catching a placeholder the moment the wording changes, letting it sync as
# if it were a real secret. Matches anything starting "your-"/"your_" (e.g.
# "your-github-client-id"), plus the CHANGE_ME... style used for
# BETTER_AUTH_SECRET.
is_placeholder_value() {
  [[ "$1" =~ ^[Yy]our[-_] || "$1" =~ ^(CHANGE_ME|changeme) ]]
}

echo "Syncing config from $ENV_FILE into $REPO ..."
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
    value=$(fetch_account_id_from_api || true)
    if [[ -n "$value" ]]; then
      save_env_value "$key" "$value"
      echo "  found $key via CLOUDFLARE_API_TOKEN, saved in $ENV_FILE"
    fi
  fi

  if [[ -z "$value" ]]; then
    if [[ "$key" == "CLOUDFLARE_ACCOUNT_ID" ]]; then
      if [[ -z "${CF_API_TOKEN:-}" ]]; then
        echo "  skip  $key (not set in $ENV_FILE, and no CLOUDFLARE_API_TOKEN to look it up with)"
      else
        echo "  skip  $key (not set in $ENV_FILE, and CLOUDFLARE_API_TOKEN doesn't reach"
        echo "        exactly one Cloudflare account)"
      fi
      echo "        Copy it from the right sidebar of the Cloudflare dashboard (or the"
      echo "        Workers & Pages overview page) into $ENV_FILE, then re-run."
    else
      echo "  skip  $key (not set in $ENV_FILE)"
    fi
    continue
  fi

  secret_name="$key"
  if [[ "$key" == GITHUB_* ]]; then secret_name="GH_${key#GITHUB_}"; fi
  printf '%s' "$value" | gh secret set "$secret_name" --repo "$REPO" >/dev/null
  echo "  set   $secret_name"

  # Kept for the Worker URL lookup below.
  case "$key" in
    CLOUDFLARE_API_TOKEN) CF_API_TOKEN="$value" ;;
    CLOUDFLARE_ACCOUNT_ID) CF_ACCOUNT_ID="$value" ;;
  esac
done

echo
echo "Current config on $REPO:"
gh secret list --repo "$REPO"

# Save the deployed Worker's URL back into $ENV_FILE as CLOUDFLARE_WORKER_URL,
# so local frontends can find it. The URL is https://[worker].[subdomain].workers.dev:
# the worker name comes from worker/wrangler.toml, and the account's
# workers.dev subdomain from the Cloudflare API, using the same token and
# account ID synced above. It resolves once the "Deploy Worker" workflow has
# deployed the Worker. (The site itself is at https://cloud.model.earth.)

echo
WORKER_NAME=$(sed -nE 's/^name[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$SCRIPT_DIR/../worker/wrangler.toml" 2>/dev/null | head -n1)
if [[ -z "${CF_API_TOKEN:-}" || -z "${CF_ACCOUNT_ID:-}" ]]; then
  echo "  skip  CLOUDFLARE_WORKER_URL (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)"
elif [[ -z "$WORKER_NAME" ]]; then
  echo "  skip  CLOUDFLARE_WORKER_URL (no name found in worker/wrangler.toml)"
else
  cf_subdomain=$(curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers/subdomain" 2>/dev/null \
    | sed -nE 's/.*"subdomain"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' || true)
  if [[ -z "$cf_subdomain" ]]; then
    echo "  skip  CLOUDFLARE_WORKER_URL (couldn't read the workers.dev subdomain - the"
    echo "        token needs Workers Scripts read access, and the account needs a"
    echo "        workers.dev subdomain: Cloudflare dashboard -> Workers & Pages)"
  else
    worker_url="https://$WORKER_NAME.$cf_subdomain.workers.dev"
    save_env_value CLOUDFLARE_WORKER_URL "$worker_url"
    echo "  saved CLOUDFLARE_WORKER_URL=$worker_url in $ENV_FILE"
  fi
fi
