// Reading and writing the local env file for scripts in this folder, with
// the same rules as sync-config.sh: the file defaults to paths.yaml's
// env_file: (relative to this folder), the last KEY= line wins, quotes and a
// trailing " # comment" are stripped, and template placeholders
// ("your-...", "CHANGE_ME...") count as unset.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));

export function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// An explicit path wins; "paths.yaml" (or nothing) means the remembered one.
export function resolveEnvFile(path) {
  let file = path && path !== "paths.yaml" ? resolve(path) : "";
  if (!file) {
    const pathsYaml = join(AUTOMATION_DIR, "paths.yaml");
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
    file = isAbsolute(value) ? value : resolve(AUTOMATION_DIR, value);
  }
  if (!existsSync(file)) fail(`${file} doesn't exist.`);
  return file;
}

export function isPlaceholder(value) {
  return /^[Yy]our[-_]/.test(value) || /^(CHANGE_ME|changeme|REPLACE_ME)/.test(value);
}

export function readEnv(file, key) {
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith(`${key}=`));
  if (!lines.length) return "";
  const value = lines.pop().slice(key.length + 1).replace(/^"/, "").replace(/"$/, "").replace(/\s+#.*$/, "").trim();
  return isPlaceholder(value) ? "" : value;
}

// Replaces key= in place or appends it. Writes into the existing file, so it
// keeps its permissions.
export function saveEnv(file, key, value) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const index = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
    writeFileSync(file, lines.join("\n"));
  } else {
    writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${key}=${value}\n`);
  }
}
