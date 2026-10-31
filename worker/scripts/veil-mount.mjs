// Run by wrangler before each dev start and deploy ([build] in wrangler.toml).
// The Veil (veil/code) is its own repo, not a submodule, so it's only in some
// webroots. When it is, src/veil-mount.js passes on src/veil.js, which mounts
// its API at /veil/code/api/*, and its packages are installed if missing.
// When it isn't, src/veil-mount.js matches no paths and veil.js isn't bundled.
//
// veil is a submodule of the commons webroot beside this one, so when it's
// there (../commons/veil) and not here, veil/ is made a link to it. The
// webroot's .gitignore leaves veil/ out, link or folder. The deploy workflow
// clones it into veil/ instead.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VEIL_CODE = resolve(WORKER_DIR, "..", "veil", "code");
const MOUNT = join(WORKER_DIR, "src", "veil-mount.js");

const VEIL = resolve(WORKER_DIR, "..", "veil");
const COMMONS_VEIL = resolve(WORKER_DIR, "..", "..", "commons", "veil");
const linked = (() => { try { return lstatSync(VEIL).isSymbolicLink(); } catch { return false; } })();
if (!existsSync(VEIL) && !linked && existsSync(join(COMMONS_VEIL, "code", "package.json"))) {
  symlinkSync("../commons/veil", VEIL);
  console.log("[veil] Linked veil/ to ../commons/veil");
}

const present = existsSync(join(VEIL_CODE, "package.json"));
if (present && !existsSync(join(VEIL_CODE, "node_modules"))) {
  console.log("[veil] Installing veil/code's packages");
  execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: VEIL_CODE, stdio: "inherit" });
}

const source = present
  ? `// Written by scripts/veil-mount.mjs: veil/code is in the webroot.\nexport { handleVeil, isVeilPath } from "./veil.js";\n`
  : `// Written by scripts/veil-mount.mjs: veil/code isn't in the webroot.\nexport const isVeilPath = () => false;\nexport const handleVeil = null;\n`;

// Written only when it changes, since wrangler dev reruns this on edits in src/.
if (!existsSync(MOUNT) || readFileSync(MOUNT, "utf8") !== source) writeFileSync(MOUNT, source);
