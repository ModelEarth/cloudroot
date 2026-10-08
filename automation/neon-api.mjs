// Neon API helpers for scripts in this folder (setup-neon.mjs,
// setup-neon-chat.mjs). Reads NEON_API_KEY and NEON_ORG_ID from the env file.

import { fail, readEnv, saveEnv } from "./env-file.mjs";

const NEON_API = "https://console.neon.tech/api/v2";

export function neonClient(envFile) {
  const apiKey = readEnv(envFile, "NEON_API_KEY");
  let orgId = readEnv(envFile, "NEON_ORG_ID");

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
        fail(`this Neon API key reaches ${organizations.length} organizations. Set NEON_ORG_ID in ${envFile} to one of:\n${list}`);
      }
      orgId = organizations[0].id;
      saveEnv(envFile, "NEON_ORG_ID", orgId);
      console.log(`  found NEON_ORG_ID (${organizations[0].name}), saved in ${envFile}`);
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

  return { apiKey, findOrCreateProject, connectionUri };
}

// Neon's pooled host is the direct host with -pooler after the endpoint id
// (as in commons/support/cal/vercel-env.sh). Migrations use the direct one.
export function directUrl(url) {
  const connection = new URL(url);
  if (connection.hostname.endsWith(".neon.tech")) {
    connection.hostname = connection.hostname.replace(/^(ep-[a-z0-9-]+?)-pooler\./, "$1.");
  }
  return connection.href;
}
