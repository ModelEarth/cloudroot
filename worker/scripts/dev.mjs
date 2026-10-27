// `npm run dev`: runs this Worker locally (wrangler dev, http://localhost:3701)
// with config from the same env file chat/server.mjs and
// automation/sync-config.sh use (automation/paths.yaml `env_file:`), so local
// sign-in works without copying secrets into a .dev.vars file.
//
// Values go to wrangler through the process environment, not a file. As in
// sync-config.sh, the env file's AUTH_POSTGRES_URL is the Worker's
// POSTGRES_URL. A worker/.dev.vars file, if present, is used instead.
//
// The site's static files are the webroot itself (wrangler.toml [assets]),
// but wrangler dev watches its whole assets directory for changes, ignoring
// .assetsignore. Watching the webroot would include chat/ and worker/
// (node_modules, and wrangler's own .wrangler/ output, which reloads it
// endlessly). So locally it's given worker/.wrangler/webroot instead: links to
// the webroot's top-level entries, minus those .assetsignore leaves out whole
// and any Python virtual environments inside them. Edits show up on reload,
// with no build step.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEBROOT = resolve(WORKER_DIR, "..");
const AUTOMATION_DIR = resolve(WEBROOT, "automation");

// The Worker's secrets, as deploy-worker.yml passes them (minus the deploy's
// own Cloudflare credentials).
const KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "BETTER_AUTH_SECRET", "BROWSER_ENCRYPTION_PRIVATE_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
  "MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET",
  "DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "FACEBOOK_CLIENT_ID", "FACEBOOK_CLIENT_SECRET",
  "GEMINI_API_KEY", "ARTS_ENGINE_PASSPHRASE", "WEBHOOK_SECRET", "ARCHIVIST_TOKEN",
  "CMS_GITHUB_CLIENT_ID", "CMS_GITHUB_CLIENT_SECRET",
];

function envFilePath() {
  const pathsYaml = join(AUTOMATION_DIR, "paths.yaml");
  if (!existsSync(pathsYaml)) return null;
  const match = readFileSync(pathsYaml, "utf8").match(/^env_file:\s*["']?([^"'#\n]+?)["']?\s*(#.*)?$/m);
  return match ? resolve(AUTOMATION_DIR, match[1].trim()) : null;
}

function readEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (/^["']/.test(value)) value = value.slice(1, value.indexOf(value[0], 1));
    else value = value.replace(/\s+#.*$/, "");
    values[match[1]] = value;
  }
  return values;
}

// Top-level entries .assetsignore leaves out whole ("/chat", not "/auth/*").
function leftOutEntries() {
  const ignore = readFileSync(join(WEBROOT, ".assetsignore"), "utf8");
  return new Set([...ignore.matchAll(/^\/([^/*!\s]+)\s*$/gm)].map((match) => match[1]));
}

// Python virtual environments, e.g. data-pipeline's per-node env folders.
// .assetsignore keeps them off the site, but wrangler would still watch their
// thousands of files, which stops it from starting (spawn EBADF).
const VENV_DIRS = new Set(["env", "venv", ".venv"]);

function hasVenv(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".git") continue;
    if (VENV_DIRS.has(entry.name) || hasVenv(join(dir, entry.name))) return true;
  }
  return false;
}

// Links src at dest. A folder holding a virtual environment is recreated with
// links to its other entries instead, so files added later directly inside
// that folder need a restart to show up.
function linkWithoutVenvs(src, dest) {
  if (!statSync(src).isDirectory() || !hasVenv(src)) {
    symlinkSync(src, dest);
    return;
  }
  mkdirSync(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.isDirectory() && VENV_DIRS.has(entry.name)) continue;
    linkWithoutVenvs(join(src, entry.name), join(dest, entry.name));
  }
}

function linkWebroot() {
  const dir = join(WORKER_DIR, ".wrangler", "webroot");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const leftOut = leftOutEntries();
  for (const name of readdirSync(WEBROOT)) {
    if (leftOut.has(name) || name === "node_modules" || (name.startsWith(".") && name !== ".assetsignore")) continue;
    if (name === "auth") {
      // Only auth/out is published, so auth/node_modules isn't watched.
      mkdirSync(join(dir, "auth"));
      if (existsSync(join(WEBROOT, "auth", "out"))) symlinkSync(join(WEBROOT, "auth", "out"), join(dir, "auth", "out"));
      else console.log("[dev] auth/out is missing, so /auth/ is empty. Build it: cd auth && pnpm install && pnpm build");
      continue;
    }
    linkWithoutVenvs(join(WEBROOT, name), join(dir, name));
  }
  return dir;
}

let env = { ...process.env };
const args = ["dev", "--assets", linkWebroot(), ...process.argv.slice(2)];

if (existsSync(join(WORKER_DIR, ".dev.vars"))) {
  console.log("[dev] Using worker/.dev.vars");
} else {
  const path = envFilePath();
  if (path && existsSync(path)) {
    const values = readEnvFile(path);
    // wrangler hands every process variable to the Worker, so start from only
    // what it needs to run rather than the whole shell environment.
    env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "TERM"].includes(key) || key.startsWith("WRANGLER_")));
    let count = 0;
    for (const key of KEYS) {
      if (values[key]) { env[key] = values[key]; count++; }
    }
    if (values.AUTH_POSTGRES_URL) { env.POSTGRES_URL = values.AUTH_POSTGRES_URL; count++; }
    // Lets wrangler read these from the process environment.
    env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
    console.log(`[dev] ${count} values from ${path}`);
  } else {
    console.log("[dev] No env file found (automation/paths.yaml env_file:) and no worker/.dev.vars; sign-in runs without a database.");
  }
}

const wrangler = join(WORKER_DIR, "node_modules", ".bin", "wrangler");
const child = spawn(wrangler, args, { cwd: WORKER_DIR, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
