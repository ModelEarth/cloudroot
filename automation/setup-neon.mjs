#!/usr/bin/env node
// Sets up the sign-in database for the CloudRoot Worker, doing the steps in
// auth/README.md ("Database") end to end:
//
//   1. Creates a Neon project (or finds it by name), through the Neon API.
//   2. Runs auth/db/0001_create_better_auth_tables.sql, then
//      auth/db/0002_enable_pgcrypto.sql. Both are safe to run again.
//   3. Saves the connection string in the env file as AUTH_POSTGRES_URL,
//      pushes it to GitHub as the POSTGRES_URL secret, and starts the
//      "Deploy Worker" workflow so the Worker picks it up.
//
// Needs NEON_API_KEY in the env file: console.neon.tech → Settings → Personal
// API keys. Like the Cloudflare token, Neon only creates it in its dashboard.
// When AUTH_POSTGRES_URL is already set, the Neon API isn't used, so this
// also works for an existing database (Neon, Supabase or other Postgres).
//
// The Worker's URL is kept apart from the env file's POSTGRES_URL, which chat
// reads, until chat's matching bcrypt hashing is deployed (see
// worker/README.md, "Database"). After that both can hold the same URL.
//
// Optional env file values: NEON_PROJECT_NAME (default "cloudroot"),
// NEON_REGION_ID (default "aws-us-east-1", Virginia: next to Vercel's default
// iad1 functions and commons' Neon projects), NEON_ORG_ID (found and saved
// automatically when the API key reaches exactly one organization).
//
// Usage: node automation/setup-neon.mjs [env-file|paths.yaml] [owner/repo]
//          [--no-github] [--no-deploy]
// The env file defaults to paths.yaml's env_file: (written by sync-config.sh).
// The repo defaults to this checkout's git remote. The connection string is
// never printed.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const NEON_API = "https://console.neon.tech/api/v2";
const MIGRATIONS = ["0001_create_better_auth_tables.sql", "0002_enable_pgcrypto.sql"];

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// ---- env file -------------------------------------------------------------

function resolveEnvFile() {
  const arg = positional[0];
  if (arg && arg !== "paths.yaml") return resolve(arg);
  const pathsYaml = join(SCRIPT_DIR, "paths.yaml");
  if (!existsSync(pathsYaml)) {
    fail("no env file given and no automation/paths.yaml yet. Pass the env file path, or run sync-config.sh once.");
  }
  // Same parsing as sync-config.sh's read_env_file_setting.
  const line = readFileSync(pathsYaml, "utf8").split("\n").filter((l) => l.startsWith("env_file:")).pop();
  const value = (line || "")
    .slice("env_file:".length)
    .replace(/\s#.*$/, "")
    .trim()
    .replace(/^"|"$/g, "");
  if (!value) fail(`no env_file: set in ${pathsYaml}.`);
  return isAbsolute(value) ? value : resolve(SCRIPT_DIR, value);
}

const ENV_FILE = resolveEnvFile();
if (!existsSync(ENV_FILE)) fail(`${ENV_FILE} doesn't exist.`);

// Last matching line wins; strips surrounding quotes and a trailing
// " # comment", like sync-config.sh.
function readEnv(key) {
  const lines = readFileSync(ENV_FILE, "utf8").split("\n").filter((l) => l.startsWith(`${key}=`));
  if (!lines.length) return "";
  const value = lines.pop().slice(key.length + 1).replace(/^"/, "").replace(/"$/, "").replace(/\s+#.*$/, "").trim();
  return isPlaceholder(value) ? "" : value;
}

function isPlaceholder(value) {
  return /^[Yy]our[-_]/.test(value) || /^(CHANGE_ME|changeme)/.test(value);
}

// Replaces key= in place or appends it. Writes into the existing file, so it
// keeps its permissions.
function saveEnv(key, value) {
  const text = readFileSync(ENV_FILE, "utf8");
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
    writeFileSync(ENV_FILE, lines.join("\n"));
  } else {
    writeFileSync(ENV_FILE, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${key}=${value}\n`);
  }
}

// ---- Neon API -------------------------------------------------------------

const apiKey = readEnv("NEON_API_KEY");
let orgId = readEnv("NEON_ORG_ID");

async function neon(method, path, body) {
  const response = await fetch(`${NEON_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`Neon API ${method} ${path}: ${response.status} ${data.message || ""}`.trim());
    error.status = response.status;
    error.neonMessage = data.message || "";
    throw error;
  }
  return data;
}

// Personal API keys must name the organization when the account has one.
// Retries once with the key's only organization, and saves it.
async function withOrg(call) {
  try {
    return await call();
  } catch (error) {
    if (orgId || !/org_id/i.test(error.neonMessage || "")) throw error;
    const { organizations = [] } = await neon("GET", "/users/me/organizations");
    if (organizations.length !== 1) {
      const list = organizations.map((o) => `  ${o.id}  ${o.name}`).join("\n");
      fail(`this Neon API key reaches ${organizations.length} organizations. Set NEON_ORG_ID in ${ENV_FILE} to one of:\n${list}`);
    }
    orgId = organizations[0].id;
    saveEnv("NEON_ORG_ID", orgId);
    console.log(`  found NEON_ORG_ID (${organizations[0].name}), saved in ${ENV_FILE}`);
    return call();
  }
}

const orgQuery = () => (orgId ? `&org_id=${encodeURIComponent(orgId)}` : "");

async function findOrCreateProject(name, regionId) {
  const { projects = [] } = await withOrg(() =>
    neon("GET", `/projects?limit=400&search=${encodeURIComponent(name)}${orgQuery()}`),
  );
  const existing = projects.find((p) => p.name === name);
  if (existing) {
    console.log(`  found Neon project "${name}" (${existing.id}, ${existing.region_id})`);
    return existing.id;
  }
  const { project } = await withOrg(() =>
    neon("POST", "/projects", {
      project: { name, region_id: regionId, pg_version: 17, ...(orgId ? { org_id: orgId } : {}) },
    }),
  );
  console.log(`  created Neon project "${name}" (${project.id}, ${regionId})`);
  return project.id;
}

// Pooled connection string for the default branch's first database.
async function connectionUri(projectId) {
  const { branches = [] } = await neon("GET", `/projects/${projectId}/branches`);
  const branch = branches.find((b) => b.default) || branches[0];
  if (!branch) fail(`Neon project ${projectId} has no branches.`);
  const { databases = [] } = await neon("GET", `/projects/${projectId}/branches/${branch.id}/databases`);
  const database = databases.find((d) => d.name === "neondb") || databases[0];
  if (!database) fail(`Neon branch ${branch.name} has no databases.`);
  const params = new URLSearchParams({
    branch_id: branch.id,
    database_name: database.name,
    role_name: database.owner_name,
    pooled: "true",
  });
  const { uri } = await neon("GET", `/projects/${projectId}/connection_uri?${params}`);
  return uri;
}

// ---- migrations -----------------------------------------------------------

// postgres.js comes from the Worker's own dependencies.
async function loadPostgres() {
  const require = createRequire(join(ROOT, "worker", "package.json"));
  let entry;
  try {
    entry = require.resolve("postgres");
  } catch {
    fail("postgres.js isn't installed. Run: cd worker && npm install");
  }
  return (await import(pathToFileURL(entry).href)).default;
}

// Neon's pooled host is the direct host with -pooler after the endpoint id
// (as in commons/support/cal/vercel-env.sh). Migrations use the direct one.
function directUrl(url) {
  const connection = new URL(url);
  if (connection.hostname.endsWith(".neon.tech")) {
    connection.hostname = connection.hostname.replace(/^(ep-[a-z0-9-]+?)-pooler\./, "$1.");
  }
  // postgres.js would send channel_binding to the server as a setting.
  connection.searchParams.delete("channel_binding");
  return connection;
}

async function runMigrations(url) {
  const postgres = await loadPostgres();
  const connection = directUrl(url);
  const sql = postgres(connection.href, { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
  try {
    // A new Neon compute can take a few seconds to accept connections.
    for (let attempt = 1; ; attempt++) {
      try {
        await sql`select 1`;
        break;
      } catch (error) {
        if (attempt >= 6) throw error;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    for (const file of MIGRATIONS) {
      await sql.unsafe(readFileSync(join(ROOT, "auth", "db", file), "utf8"));
      console.log(`  ran   auth/db/${file}`);
    }
    const [{ tables }] = await sql`
      select count(*)::int as tables from information_schema.tables
      where table_schema = current_schema() and table_name in ('user', 'session', 'account', 'verification')`;
    const [{ bcrypt }] = await sql`select crypt('test', gen_salt('bf', 4)) like '$2a$04$%' as bcrypt`;
    if (tables !== 4 || !bcrypt) fail(`check failed: ${tables} of 4 tables, bcrypt ${bcrypt ? "ok" : "missing"}.`);
    console.log("  check 4 sign-in tables present, pgcrypto bcrypt works");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ---- GitHub ---------------------------------------------------------------

function gh(args, input) {
  return spawnSync("gh", args, { input, encoding: "utf8" });
}

function detectRepo() {
  if (positional[1]) return positional[1];
  const remote = spawnSync("git", ["-C", ROOT, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).stdout.trim();
  const repo = remote.replace(/^(https:\/\/github\.com\/|git@github\.com:)/, "").replace(/\.git$/, "").replace(/\/$/, "");
  if (!repo) fail("couldn't read the GitHub repo from git remote. Pass it as the 2nd argument (owner/repo).");
  return repo;
}

function pushToGitHub(url) {
  const repo = detectRepo();
  if (gh(["auth", "status"]).status !== 0) fail("gh isn't installed or authenticated. Run 'gh auth login', or pass --no-github.");
  const set = gh(["secret", "set", "POSTGRES_URL", "--repo", repo], url);
  if (set.status !== 0) {
    fail(`gh secret set failed on ${repo}: ${set.stderr.trim()} | Try 'gh auth switch' to an account with access, or run ./automation/sync-config.sh.`);
  }
  console.log(`  set   POSTGRES_URL secret on ${repo}`);
  if (flags.has("--no-deploy")) {
    console.log(`        Redeploy to apply: gh workflow run deploy-worker.yml --repo ${repo}`);
    return;
  }
  const run = gh(["workflow", "run", "deploy-worker.yml", "--repo", repo, "--ref", "main"]);
  if (run.status !== 0) fail(`couldn't start the deploy: ${run.stderr.trim()}`);
  console.log(`  start Deploy Worker on ${repo} (watch: gh run watch --repo ${repo})`);
  console.log("        Once it finishes, https://cloud.model.earth/api/auth/db-status shows \"ok\".");
}

// ---- main -----------------------------------------------------------------

console.log(`Setting up the sign-in database from ${ENV_FILE} ...\n`);

let url = readEnv("AUTH_POSTGRES_URL");
if (url) {
  console.log("  using AUTH_POSTGRES_URL from the env file (Neon API not needed)");
} else {
  if (!apiKey) {
    fail(`NEON_API_KEY isn't set in ${ENV_FILE}. Create one at console.neon.tech → Settings → Personal API keys, paste it after NEON_API_KEY= in the env file, and re-run.`);
  }
  try {
    const projectId = await findOrCreateProject(readEnv("NEON_PROJECT_NAME") || "cloudroot", readEnv("NEON_REGION_ID") || "aws-us-east-1");
    url = await connectionUri(projectId);
  } catch (error) {
    fail(error.status === 401 ? `${error.message} | Check NEON_API_KEY in ${ENV_FILE}.` : error.message);
  }
  saveEnv("AUTH_POSTGRES_URL", url);
  console.log(`  saved AUTH_POSTGRES_URL (host ${new URL(url).hostname}) in ${ENV_FILE}`);
}

try {
  await runMigrations(url);
} catch (error) {
  fail(`couldn't run the migrations: ${error.code || ""} ${error.message} | A paused free-tier database wakes from its dashboard.`.replace(/\s+/g, " "));
}

if (flags.has("--no-github")) {
  console.log("\nSkipped GitHub (--no-github). Push it later with ./automation/sync-config.sh.");
} else {
  pushToGitHub(url);
}
