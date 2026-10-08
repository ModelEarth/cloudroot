#!/usr/bin/env node
// Sets up chat's own database: a Neon project apart from the sign-in
// database, so chat's data (chats, messages, documents, settings, logs) never
// shares a database with user accounts.
//
//   1. Creates the Neon project "chat" (or finds it), through the Neon API.
//   2. Saves its pooled connection string in the env file as
//      CHAT_POSTGRES_URL.
//   3. Runs chat's migrations there (the Neon versions, chat/lib/db/migrate.ts)
//      over the direct connection, then chat's db:verify. Safe to run again.
//
// The sign-in database is separate: AUTH_POSTGRES_URL, from setup-neon.mjs.
// chat reads POSTGRES_URL for its data and AUTH_POSTGRES_URL for sign-in;
// vercel-env.mjs sets both on Vercel from CHAT_POSTGRES_URL and
// AUTH_POSTGRES_URL. Locally, set POSTGRES_URL to the CHAT_POSTGRES_URL value.
//
// Needs NEON_API_KEY in the env file (see automation/README.md), and chat's
// dependencies installed (cd chat && pnpm install). When CHAT_POSTGRES_URL is
// already set, the Neon API isn't used.
//
// Optional env file values: NEON_CHAT_PROJECT_NAME (default "chat"),
// NEON_REGION_ID (default "aws-us-east-1").
//
// Usage: node automation/setup-neon-chat.mjs [--env <env-file>] [--no-migrate]
// The connection string is never printed.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { AUTOMATION_DIR, fail, resolveEnvFile, readEnv, saveEnv } from "./env-file.mjs";
import { neonClient, directUrl } from "./neon-api.mjs";

const CHAT_DIR = resolve(AUTOMATION_DIR, "..", "chat");

const args = process.argv.slice(2);
const envIndex = args.indexOf("--env");
const ENV_FILE = resolveEnvFile(envIndex >= 0 ? args[envIndex + 1] : "");

// Runs a chat script against the database and prints only its summary lines.
function runChatScript(script, url, pattern) {
  const result = spawnSync("npx", ["tsx", script], {
    cwd: CHAT_DIR,
    env: { ...process.env, POSTGRES_URL: url, MIGRATION_TARGET: "" },
    encoding: "utf8",
  });
  const output = `${result.stdout}\n${result.stderr}`.replaceAll(url, "<url>");
  for (const line of output.split("\n")) if (pattern.test(line)) console.log(`        ${line.trim()}`);
  return result.status === 0;
}

console.log(`Setting up chat's database from ${ENV_FILE} ...\n`);

let url = readEnv(ENV_FILE, "CHAT_POSTGRES_URL");
if (url) {
  console.log("  using CHAT_POSTGRES_URL from the env file (Neon API not needed)");
} else {
  const { apiKey, findOrCreateProject, connectionUri } = neonClient(ENV_FILE);
  if (!apiKey) {
    fail(`NEON_API_KEY isn't set in ${ENV_FILE}. Create one at console.neon.tech → Settings → Personal API keys, paste it after NEON_API_KEY= in the env file, and re-run.`);
  }
  try {
    const projectId = await findOrCreateProject(
      readEnv(ENV_FILE, "NEON_CHAT_PROJECT_NAME") || "chat",
      readEnv(ENV_FILE, "NEON_REGION_ID") || "aws-us-east-1",
    );
    url = await connectionUri(projectId);
  } catch (error) {
    fail(error.status === 401 ? `${error.message} | Check NEON_API_KEY in ${ENV_FILE}.` : error.message);
  }
  saveEnv(ENV_FILE, "CHAT_POSTGRES_URL", url);
  console.log(`  saved CHAT_POSTGRES_URL (host ${new URL(url).hostname}) in ${ENV_FILE}`);
}

if (url === readEnv(ENV_FILE, "AUTH_POSTGRES_URL")) {
  fail("CHAT_POSTGRES_URL is the same as AUTH_POSTGRES_URL. chat's data belongs in its own database.");
}

if (args.includes("--no-migrate")) {
  console.log("\nSkipped chat's migrations (--no-migrate).");
  process.exit(0);
}
if (!existsSync(join(CHAT_DIR, "node_modules"))) fail("chat's dependencies aren't installed. Run: cd chat && pnpm install");

const direct = directUrl(url);
console.log("  run   chat's migrations (lib/db/migrate.ts)");
if (!runChatScript("lib/db/migrate.ts", direct, /Running migrations|All migrations|❌|^Message:/)) fail("chat's migrations failed.");
console.log("  run   chat's db:verify (lib/db/verify-migration.ts)");
if (!runChatScript("lib/db/verify-migration.ts", direct, /PASSED|FAILED|❌/)) fail("chat's db:verify failed.");

console.log("\nNext: node automation/vercel-env.mjs <project> sets POSTGRES_URL and AUTH_POSTGRES_URL on Vercel.");
