#!/usr/bin/env node
// Assembles worker/dist — the static half of cloud.model.earth — from the
// webroot (this repo with its submodules checked out).
//
//   node worker/scripts/build-static.mjs
//
// Copied: every top-level folder and file of the webroot except those in
// LEAVE_OUT, which are servers, tooling or local config rather than pages.
// The auth submodule is a Next.js app, so its static export (auth/out, made
// by `pnpm build` in auth/) is copied to /auth instead of its source.
// Never copied, at any depth: dot-files and dot-folders (.git, .env, ...),
// node_modules, Rust target folders, and private key files.

import { cpSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEBROOT = resolve(WORKER_DIR, "..");
const OUT = join(WORKER_DIR, "dist");

const LEAVE_OUT = new Set([
  "chat",        // Next.js app, deployed to Vercel
  "auth",        // replaced by its static export, below
  "worker",      // this Worker
  "automation",  // local scripts and config
  "support",     // agent setup notes
  "env", "bin", "docker", "safe",
  "package.json", "pnpm-lock.yaml", "vercel.json",
  "check-package-sync.js", "set-root-directory.js", "frontend-example.js",
  "AGENTS.md", "CLAUDE.md", "paths.yaml",
]);

function keep(source) {
  const name = basename(source);
  if (name.startsWith(".")) return false;
  if (name === "node_modules" || name === "target") return false;
  if (/\.(pem|key)$/i.test(name)) return false;
  return true;
}

rmSync(OUT, { recursive: true, force: true });

let copied = 0;
for (const name of readdirSync(WEBROOT)) {
  if (LEAVE_OUT.has(name) || !keep(name)) continue;
  const source = join(WEBROOT, name);
  if (statSync(source).isDirectory() && readdirSync(source).length === 0) {
    console.warn(`  empty  ${name}/ (submodule not checked out?)`);
    continue;
  }
  cpSync(source, join(OUT, name), { recursive: true, filter: keep });
  copied++;
}

const authExport = join(WEBROOT, "auth", "out");
if (existsSync(authExport)) {
  cpSync(authExport, join(OUT, "auth"), { recursive: true, filter: keep });
  console.log("  auth   static export copied to /auth");
} else if (process.argv.includes("--skip-auth")) {
  console.warn("  auth   skipped (--skip-auth)");
} else {
  console.error("auth/out is missing. Build it first: cd auth && pnpm install && pnpm build");
  console.error("(or pass --skip-auth to build without the sign-in pages)");
  process.exit(1);
}

function countFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (n, entry) => n + (entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1),
    0
  );
}
console.log(`Built ${relative(WEBROOT, OUT)}: ${copied} top-level entries, ${countFiles(OUT)} files.`);
