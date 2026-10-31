#!/usr/bin/env node
// Puts keys into the local env file without showing their values: each one is
// typed at a hidden prompt (nothing echoes), or copied from another env file
// with --from, such as one written by `vercel env pull`. Only key names are
// printed. Then run ./automation/sync-config.sh to store them as GitHub
// secrets for the Worker.
//
// By default it asks for The Veil's keys (veil/code, worker/src/veil.js):
//   GAME_STATE_SECRET NVIDIA_API_KEY NVIDIA_IMAGE_KEY NVIDIACosmos FAL_KEY
//   BLOB_READ_WRITE_TOKEN
//
// Usage: node automation/set-env-keys.mjs [KEY ...] [--from <env-file>] [--env <env-file>]
//   KEY       keys to set instead of The Veil's
//   --from    copy each key from this file instead of asking
//   --env     the env file to write (default: paths.yaml's env_file:)
// At a prompt, Enter alone keeps the current value (or skips a key that has none).

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fail, resolveEnvFile, readEnv, saveEnv } from "./env-file.mjs";

const VEIL_KEYS = ["GAME_STATE_SECRET", "NVIDIA_API_KEY", "NVIDIA_IMAGE_KEY", "NVIDIACosmos", "FAL_KEY", "BLOB_READ_WRITE_TOKEN"];

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return "";
  const value = args[i + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  args.splice(i, 2);
  return value;
};
const ENV_FILE = resolveEnvFile(option("--env"));
const fromArg = option("--from");
const FROM_FILE = fromArg ? resolve(fromArg) : "";
if (FROM_FILE && !existsSync(FROM_FILE)) fail(`${FROM_FILE} doesn't exist.`);
const unknown = args.filter((a) => a.startsWith("--"));
if (unknown.length) fail(`unknown option ${unknown[0]}.`);
const keys = args.length ? args : VEIL_KEYS;
const bad = keys.find((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
if (bad) fail(`"${bad}" isn't a key name.`);
if (!FROM_FILE && !process.stdin.isTTY) fail("the prompts need a terminal. Run this yourself (in Claude Code, start the line with !), or use --from <env-file>.");

// Reads a line without echoing it. Backspace works; Ctrl-C stops.
function askHidden(prompt) {
  return new Promise((done) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          return done(value.trim());
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// The env file's readers (sync-config.sh, worker/scripts/dev.mjs, env-file.mjs) each treat quotes and " #" a little
// differently, so a value with spaces, quotes or # is refused rather than saved in a form one of them would misread.
const unsafe = (value) => /[\s"'#]/.test(value);

console.log(`Writing to ${ENV_FILE}${FROM_FILE ? `, from ${FROM_FILE}` : ""}. Values aren't shown.\n`);
let saved = 0;
for (const key of keys) {
  const current = readEnv(ENV_FILE, key);
  const value = FROM_FILE
    ? readEnv(FROM_FILE, key)
    : await askHidden(`${key}${current ? " (set; Enter keeps it)" : ""}: `);
  if (!value) {
    console.log(`  ${current ? "kept" : "skip"}  ${key}${FROM_FILE && !current ? ` (not in ${FROM_FILE})` : ""}`);
    continue;
  }
  if (unsafe(value)) {
    console.log(`  skip  ${key} (the value has a space, quote or #, which the env file's readers handle differently)`);
    continue;
  }
  if (value === current) { console.log(`  same  ${key}`); continue; }
  saveEnv(ENV_FILE, key, value);
  console.log(`  saved ${key}`);
  saved++;
}
if (saved) console.log(`\nNext: ./automation/sync-config.sh, to store them as GitHub secrets for the Worker's next deploy.`);
