#!/usr/bin/env node
// Sets environment variables on chat's Vercel projects from the local env
// file, through Vercel's REST API, then redeploys production so they take
// effect (Vercel doesn't rebuild when env vars change). Values are never
// printed.
//
// By default it sets chat's two databases:
//   POSTGRES_URL       from CHAT_POSTGRES_URL: chat's data (setup-neon-chat.mjs)
//   AUTH_POSTGRES_URL  from AUTH_POSTGRES_URL: the sign-in database the
//                      CloudRoot Worker uses (setup-neon.mjs), so chat and the
//                      Worker share users
// --config adds the vars listed in a JSON file such as
// chat/scripts/vercel-env.config.json (the social sign-in keys):
//   { "environment": "production", "vars": [{ "source": "X", "target": "X" }] }
//
// Needs VERCEL_API_TOKEN in the env file: https://vercel.com/account/tokens,
// scoped to the team that owns the projects. Projects are found in your
// personal account or any team the token reaches; VERCEL_TEAM_ID in the env
// file narrows that to one team.
//
// Usage: node automation/vercel-env.mjs [project ...] [--config <file>]
//          [--env <env-file>] [--no-deploy] [--no-wait] [--list]
//   project      Vercel project names; default VERCEL_PROJECTS in the env
//                file (comma-separated). With none, lists the projects.
//   --no-deploy  set the vars only; redeploy later from the dashboard
//   --no-wait    start the redeploy without waiting for it to finish
//   --list       list the projects the token can see

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail, resolveEnvFile, readEnv } from "./env-file.mjs";

const VERCEL_API = "https://api.vercel.com";
const NEW_VAR_TARGETS = ["production", "preview"];

// ---- arguments ------------------------------------------------------------

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return "";
  const value = args[i + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  args.splice(i, 2);
  return value;
};
const envArg = option("--env");
const configArg = option("--config");
const flags = new Set(args.filter((a) => a.startsWith("--")));
const ENV_FILE = resolveEnvFile(envArg);

const token = readEnv(ENV_FILE, "VERCEL_API_TOKEN") || readEnv(ENV_FILE, "VERCEL_TOKEN");
if (!token) {
  fail(`VERCEL_API_TOKEN isn't set in ${ENV_FILE}. Create a token at https://vercel.com/account/tokens (scope: the team that owns chat's projects), paste it after VERCEL_API_TOKEN= in the env file, and re-run.`);
}
const fixedTeamId = readEnv(ENV_FILE, "VERCEL_TEAM_ID");

let projectNames = args.filter((a) => !a.startsWith("--"));
if (!projectNames.length) {
  projectNames = readEnv(ENV_FILE, "VERCEL_PROJECTS").split(",").map((p) => p.trim()).filter(Boolean);
}

// target (on Vercel) <- source (in the env file), and the environments a
// new variable gets.
const vars = [
  { source: "CHAT_POSTGRES_URL", target: "POSTGRES_URL", environments: NEW_VAR_TARGETS },
  { source: "AUTH_POSTGRES_URL", target: "AUTH_POSTGRES_URL", environments: NEW_VAR_TARGETS },
];
if (configArg) {
  const config = JSON.parse(readFileSync(resolve(configArg), "utf8"));
  const environments = config.environment ? [config.environment] : NEW_VAR_TARGETS;
  for (const v of config.vars || []) vars.push({ ...v, environments });
}

// ---- Vercel API -----------------------------------------------------------

// Network failures are retried up to RETRIES times. GETs retry on any
// network error; writes only when the connection never opened, so a
// redeploy or env change can't be sent twice.
const RETRIES = 3;
const CONNECT_ERRORS = new Set(["UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const code = error.cause?.code || error.code || "";
      const retryable = init.method === "GET" || CONNECT_ERRORS.has(code);
      if (!retryable || attempt >= RETRIES) {
        fail(`couldn't reach ${url.host} (${code || error.message}) after ${attempt + 1} attempt${attempt ? "s" : ""}.`);
      }
      console.log(`  retry ${url.host} (${code || error.message}), ${attempt + 1} of ${RETRIES}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function vercel(method, path, { teamId, body, query = {} } = {}) {
  const url = new URL(path, VERCEL_API);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (teamId) url.searchParams.set("teamId", teamId);
  const response = await fetchWithRetry(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  // 401 is a bad token. A 403 on one team just means "not here".
  if (response.status === 401) {
    fail(`Vercel rejected VERCEL_API_TOKEN (401 ${data.error?.message || ""}). Check the token, or create a new one.`);
  }
  return { ok: response.ok, status: response.status, data };
}

// Personal account first, then each team the token reaches.
async function scopes() {
  if (fixedTeamId) return [{ id: fixedTeamId, name: fixedTeamId }];
  const { data } = await vercel("GET", "/v2/teams", { query: { limit: "100" } });
  return [{ id: "", name: "personal account" }, ...(data.teams || []).map((t) => ({ id: t.id, name: t.slug || t.name }))];
}

async function findProject(name) {
  for (const scope of await scopes()) {
    const { ok, data } = await vercel("GET", `/v9/projects/${encodeURIComponent(name)}`, { teamId: scope.id });
    if (ok) return { project: data, teamId: scope.id, scopeName: scope.name };
  }
  return null;
}

async function listProjects() {
  console.log("Vercel projects this token can see:\n");
  for (const scope of await scopes()) {
    const { ok, data } = await vercel("GET", "/v9/projects", { teamId: scope.id, query: { limit: "100" } });
    if (!ok || !(data.projects || []).length) continue;
    console.log(`  ${scope.name}${scope.id ? ` (VERCEL_TEAM_ID=${scope.id})` : ""}`);
    for (const p of data.projects) console.log(`    ${p.name}`);
  }
  console.log("\nPass project names as arguments, or set VERCEL_PROJECTS=name1,name2 in the env file.");
}

// Updates every existing entry for the key (keeping its environments and
// type), or creates one for production and preview.
async function setVar(project, teamId, key, { value, environments }) {
  const { data } = await vercel("GET", `/v10/projects/${project.id}/env`, { teamId });
  const existing = (data.envs || []).filter((e) => e.key === key);
  if (!existing.length) {
    const { ok, data: created } = await vercel("POST", `/v10/projects/${project.id}/env`, {
      teamId,
      body: { key, value, type: "encrypted", target: environments },
    });
    if (!ok) fail(`couldn't create ${key} on ${project.name}: ${created.error?.message || "unknown error"}`);
    console.log(`    added   ${key} (${environments.join(", ")})`);
    return;
  }
  for (const env of existing) {
    const { ok, data: updated } = await vercel("PATCH", `/v9/projects/${project.id}/env/${env.id}`, {
      teamId,
      body: { value },
    });
    if (!ok) fail(`couldn't update ${key} on ${project.name}: ${updated.error?.message || "unknown error"}`);
    console.log(`    updated ${key} (${[].concat(env.target || []).join(", ") || "custom"})`);
  }
}

// Rebuilds the latest production deployment with the new values.
async function redeploy(project, teamId) {
  const { data } = await vercel("GET", "/v6/deployments", {
    teamId,
    query: { projectId: project.id, target: "production", state: "READY", limit: "1" },
  });
  const latest = (data.deployments || [])[0];
  if (!latest) {
    console.log("    skip    redeploy (no ready production deployment to rebuild)");
    return null;
  }
  const { ok, data: created } = await vercel("POST", "/v13/deployments", {
    teamId,
    query: { forceNew: "1" },
    body: { name: project.name, deploymentId: latest.uid, target: "production" },
  });
  if (!ok) fail(`couldn't redeploy ${project.name}: ${created.error?.message || "unknown error"}`);
  console.log(`    deploy  started ${created.id} (from ${latest.uid})`);
  return created.id;
}

async function waitFor(deploymentId, teamId) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 30 * 60 * 1000) {
    const { data } = await vercel("GET", `/v13/deployments/${deploymentId}`, { teamId });
    const state = data.readyState || data.status || "UNKNOWN";
    if (state !== last) {
      console.log(`    deploy  ${state}`);
      last = state;
    }
    if (state === "READY") return true;
    if (state === "ERROR" || state === "CANCELED") return false;
    await new Promise((r) => setTimeout(r, 10000));
  }
  console.log("    deploy  still building after 30 minutes; check the Vercel dashboard");
  return false;
}

async function checkDatabase(project) {
  const domain = project.targets?.production?.alias?.find((a) => !a.includes("-git-")) || project.targets?.production?.alias?.[0];
  if (!domain) return;
  try {
    const response = await fetch(`https://${domain}/api/auth/db-status`);
    console.log(`    check   https://${domain}/api/auth/db-status: ${response.status} ${(await response.text()).slice(0, 80)}`);
  } catch (error) {
    console.log(`    check   https://${domain}/api/auth/db-status: ${error.message}`);
  }
}

// ---- main -----------------------------------------------------------------

if (flags.has("--list") || !projectNames.length) {
  await listProjects();
  process.exit(0);
}

const values = new Map();
const missing = [];
for (const { source, target, environments } of vars) {
  const value = readEnv(ENV_FILE, source);
  if (value) values.set(target, { value, environments });
  else missing.push(source);
}
if (!values.size) fail(`nothing to set: ${missing.join(", ")} not set in ${ENV_FILE}.`);

console.log(`Setting ${[...values.keys()].join(", ")} from ${ENV_FILE}`);
if (missing.length) console.log(`Skipping (not set in the env file): ${missing.join(", ")}`);
console.log();

let failed = false;
for (const name of projectNames) {
  const found = await findProject(name);
  if (!found) {
    console.log(`  ${name}: not found with this token (run with --list)`);
    failed = true;
    continue;
  }
  const { project, teamId, scopeName } = found;
  console.log(`  ${project.name} (${scopeName})`);
  for (const [key, entry] of values) await setVar(project, teamId, key, entry);
  if (flags.has("--no-deploy")) {
    console.log("    skip    redeploy (--no-deploy); the new values apply from the next deployment");
    continue;
  }
  const deploymentId = await redeploy(project, teamId);
  if (deploymentId && !flags.has("--no-wait")) {
    if (await waitFor(deploymentId, teamId)) await checkDatabase(project);
    else failed = true;
  }
}

if (failed) process.exit(1);
