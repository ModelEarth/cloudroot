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
// This is the user database, shared with chat's sign-in, which reads it as
// AUTH_POSTGRES_URL too. chat's own data is a separate database:
// setup-neon-chat.mjs.
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

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { AUTOMATION_DIR, fail, resolveEnvFile, readEnv as readEnvFrom, saveEnv as saveEnvIn } from "./env-file.mjs";
import { neonClient, directUrl } from "./neon-api.mjs";

const ROOT = resolve(AUTOMATION_DIR, "..");
const MIGRATIONS = ["0001_create_better_auth_tables.sql", "0002_enable_pgcrypto.sql"];

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const ENV_FILE = resolveEnvFile(positional[0]);
const readEnv = (key) => readEnvFrom(ENV_FILE, key);
const saveEnv = (key, value) => saveEnvIn(ENV_FILE, key, value);

// ---- Neon API -------------------------------------------------------------

const { apiKey, findOrCreateProject, connectionUri } = neonClient(ENV_FILE);

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

async function runMigrations(url) {
  const postgres = await loadPostgres();
  const sql = postgres(directUrl(url), { max: 1, prepare: false, connect_timeout: 15, onnotice: () => {} });
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
