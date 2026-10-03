# Python Sandbox

If the local machine does not have python installed, ignore the instruction here in PYTHON.md

Otherwise, if any step fails, explain the failure in plain language and suggest the manual fallback

## Sandbox Environment Setup (Python venv + direnv)

Before doing any Python-related work in this repo, check whether the local
sandbox environment is already configured. If it is not, set it up
automatically rather than asking the user to run commands themselves.

### Detection steps (run in order)

1. Check if `.envrc` exists in the webroot. If missing, create it (see
   template below).
2. Check if `direnv` is installed:
   - macOS/Linux: `command -v direnv`
   - Windows (PowerShell): `Get-Command direnv -ErrorAction SilentlyContinue`
3. Check if a Python venv already exists at `./env`. If missing, it will be
   created by `.envrc` on first load (macOS/Linux) or must be created
   directly (Windows, see below).

### If direnv is missing, detect OS and install it

**macOS:**
```bash
brew install direnv
```
Then add to `~/.zshrc` (create if missing):
```bash
eval "$(direnv hook zsh)"
```

**Linux:**
```bash
sudo apt install -y direnv
```
Then add to `~/.bashrc`:
```bash
eval "$(direnv hook bash)"
```

**Windows:**
direnv support is unreliable in PowerShell/cmd. On Windows, skip direnv
entirely and instead create/activate the venv directly per session:
```powershell
if (!(Test-Path "env")) {
    python -m venv env
}
.\env\Scripts\Activate.ps1
```
Add this as a `setup.ps1` script in the webroot so users (or Claude) can
run `.\setup.ps1` once per session instead of relying on auto-activation.

### `.envrc` template (macOS/Linux only)

If `.envrc` does not exist, create it with this content:

```bash
if [ ! -d "env" ]; then
  echo "Creating virtual environment..."
  python3 -m venv env
fi
source env/bin/activate
dotenv_if_exists .env
PATH_add bin
export PYTHONPATH="$PWD:$PYTHONPATH"
echo "✅ Python venv active: $(python3 --version)"
```

After creating or editing `.envrc`, always run:
```bash
direnv allow
```
This is required — direnv blocks unapproved `.envrc` files for security,
and Claude should run this automatically rather than surfacing the error
to the user.

### Summary of what Claude should do automatically

1. Detect OS (`uname` on macOS/Linux, or check `$OS`/`PSVersionTable` on
   Windows via PowerShell).
2. If `.envrc` is missing (macOS/Linux) → create it, then run
   `direnv allow`.
3. If `direnv` itself is missing → install it per the OS-specific steps
   above, then re-run `direnv allow`.
4. If on Windows → create/run `setup.ps1` instead, since direnv is not a
   reliable option there.
5. Never ask the user to manually paste and run these setup commands —
   perform them directly as part of the task.