// The site's source code on GitHub, for the voice widget's Claude on Cloudflare
// (handleClaudeVoice's `tools` option, engine/worker/claude-voice-api.js). Locally
// the bridge's Claude Code CLI reads the webroot's files; here there are none, so
// Claude reads them from GitHub instead, and can propose changes to The Veil as
// pull requests.
//
// Paths are webroot paths, as on the site: veil/code/app.js is DesktopFolders/veil's
// code/app.js, localsite/js/localsite.js is the localsite submodule's repo (from
// CloudRoot's .gitmodules), and anything else is CloudRoot's own repo. Each is read
// from its repo's default branch.
//
// VEIL_REPO_TOKEN (the token deploy-worker.yml clones The Veil with) is sent with
// every GitHub call. Reading DesktopFolders/veil needs it; ModelEarth's repos are
// public, but without a token GitHub allows only 60 calls an hour per IP. Pull
// requests need it to have Contents and Pull requests read and write on
// DesktopFolders/veil. They're opened on a new branch, never pushed to main, so
// nothing changes on the site until someone merges one.

import { pageFile, pagePath } from "../../engine/shared/voice-prompt.js";

const SITE_REPO = "ModelEarth/cloudroot";
const VEIL_REPO = "DesktopFolders/veil";
const VEIL_PATH = "veil";
const GITHUB = "https://api.github.com";

// Never read, as in the local bridge (engine/server/local-bridge.mjs).
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.envrc|\.dev\.vars|[^/]+\.(pem|key))$/i;
const MAX_READ = 60_000; // characters of a file per read_file
const MAX_PR_FILES = 10;
const MAX_PRS = 2; // per reply

// CloudRoot's submodules (path -> "owner/repo"), from its .gitmodules, kept for 10 minutes.
let submodules = null;
let submodulesAt = 0;

function github(env) {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "cloudroot-voice",
    "x-github-api-version": "2022-11-28",
  };
  if (env.VEIL_REPO_TOKEN) headers.authorization = `Bearer ${env.VEIL_REPO_TOKEN}`;
  return async (path, { method = "GET", body, raw = false } = {}) => {
    const res = await fetch(GITHUB + path, {
      method,
      headers: { ...headers, ...(raw && { accept: "application/vnd.github.raw+json" }), ...(body && { "content-type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.json().then((j) => j.message).catch(() => "");
      const why = res.status === 404 ? "Not found."
        : res.status === 403 || res.status === 429 ? `GitHub refused (${res.status}): ${detail || "rate limited"}.`
        : `GitHub ${res.status}: ${detail}`;
      throw new Error(why);
    }
    return raw ? res.text() : res.json();
  };
}

async function loadSubmodules(gh) {
  if (submodules && Date.now() - submodulesAt < 600_000) return submodules;
  const text = await gh(`/repos/${SITE_REPO}/contents/.gitmodules`, { raw: true });
  const found = {};
  for (const block of text.split(/\[submodule /).slice(1)) {
    const path = block.match(/^\s*path\s*=\s*(.+)$/m)?.[1].trim();
    const repo = block.match(/^\s*url\s*=\s*https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(\.git)?\s*$/m)?.[1];
    if (path && repo) found[path] = repo;
  }
  submodules = found;
  submodulesAt = Date.now();
  return found;
}

// A webroot path, cleaned: no leading slash, no "." or ".." parts.
function cleanPath(path) {
  return String(path || "").replace(/[?#].*$/, "").split("/").filter((p) => p && p !== "." && p !== "..").join("/");
}

// { repo, path } in GitHub for a webroot path, and back again.
async function locate(gh, webPath) {
  const path = cleanPath(webPath);
  const at = (prefix, repo) => ({ repo, prefix, path: path === prefix ? "" : path.slice(prefix.length + 1) });
  if (path === VEIL_PATH || path.startsWith(VEIL_PATH + "/")) return at(VEIL_PATH, VEIL_REPO);
  const subs = await loadSubmodules(gh);
  const prefix = Object.keys(subs).filter((p) => path === p || path.startsWith(p + "/")).sort((a, b) => b.length - a.length)[0];
  return prefix ? at(prefix, subs[prefix]) : { repo: SITE_REPO, prefix: "", path };
}
const webPath = (where, path) => [where.prefix, path].filter(Boolean).join("/");
const contentsUrl = (where, path = where.path, ref) =>
  `/repos/${where.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;

const DEFINITIONS = [
  {
    name: "list_files",
    description: "List a folder of this website's source code, by its path on the site (\"\" for the top, \"veil/code\", \"localsite/js\").",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Folder path from the site's root, without a leading slash." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a file of this website's source code, by its path on the site (\"veil/code/app.js\"). Lines come numbered. Long files are cut off; ask for a line range to see the rest.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path from the site's root, without a leading slash." },
        start_line: { type: "integer", description: "First line to return (1-based). Optional." },
        end_line: { type: "integer", description: "Last line to return. Optional." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search_code",
    description: "Search this website's source code for text (plain, case-insensitive, not a regular expression): file names, then the lines of up to 40 text files, under the folder `path`, or the folder of the page the person is on when there's no path. Give a narrow folder for big ones.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words or an identifier to look for." },
        path: { type: "string", description: "Folder path from the site's root to search under, e.g. \"veil/code/api\". Optional." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
];

const PR_DEFINITION = {
  name: "open_pull_request",
  description: "Propose changes to files under veil/ (the DesktopFolders/veil repo) as a GitHub pull request on a new branch, for the team to review. Nothing on the site changes until someone merges it. Returns the pull request's number and link.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Pull request title, under 70 characters." },
      body: { type: "string", description: "What changes and why, in a few sentences of Markdown." },
      changes: {
        type: "array",
        description: "The edits, applied in order. Each changes one file, by its path on the site (\"veil/code/app.js\"): either old_str and new_str (old_str copied exactly from the file, occurring once in it), or content, the whole text of a new file.",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_str: { type: "string" },
            new_str: { type: "string" },
            content: { type: "string" },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "body", "changes"],
    additionalProperties: false,
  },
};

const isText = (v) => typeof v === "string";

async function listFiles(gh, { path }) {
  const where = await locate(gh, path);
  const items = await gh(contentsUrl(where));
  if (!Array.isArray(items)) return `${cleanPath(path)} is a file, not a folder. Read it with read_file.`;
  // Submodules show up as files in a folder listing; at the top, veil isn't one of CloudRoot's files at all.
  const subs = where.repo === SITE_REPO ? await loadSubmodules(gh) : {};
  const lines = items.map((item) => {
    const full = webPath(where, item.path);
    const folder = item.type === "dir" || subs[full];
    return folder ? `${item.name}/` : `${item.name} (${item.size} bytes)`;
  });
  if (where.repo === SITE_REPO && !where.path) lines.push(`${VEIL_PATH}/`);
  return `${cleanPath(path) || "(site root)"} in ${where.repo}:\n${lines.join("\n")}`;
}

async function readFile(gh, { path, start_line, end_line }) {
  const clean = cleanPath(path);
  if (SECRET_FILE.test(clean)) return "That file can hold secrets, so it isn't readable here.";
  const where = await locate(gh, clean);
  if (!where.path) return `${clean || "The site root"} is a folder. List it with list_files.`;
  const text = await gh(contentsUrl(where), { raw: true });
  if (text.includes("\u0000")) return `${clean} is a binary file (${text.length} bytes), so it can't be read as text.`;
  const lines = text.split("\n");
  const first = Math.max(1, Number(start_line) || 1);
  const last = Math.min(lines.length, Number(end_line) || lines.length);
  let out = "";
  let n = first;
  for (; n <= last; n++) {
    const line = `${n}\t${lines[n - 1]}\n`;
    if (out.length + line.length > MAX_READ) break;
    out += line;
  }
  const more = n <= last ? `\n[Cut off at line ${n - 1} of ${lines.length}. Read from start_line ${n} for more.]` : "";
  return `${clean} (${where.repo}, ${lines.length} lines):\n${out}${more}`;
}

// Files search_code skips: binaries, and folders of installed or built code.
const NOT_TEXT = /\.(png|jpe?g|gif|webp|ico|svg|mp3|mp4|webm|wav|ogg|woff2?|ttf|otf|eot|pdf|zip|gz|glb|gltf|bin|wasm|lock)$|(^|\/)(node_modules|dist|build|vendor|\.next)\//i;
const SEARCH_FILES = 40; // files whose text is searched, per search
const SEARCH_LINES = 30;

// GitHub's code search API doesn't find things in these repos, so this lists the folder's files (one call) and
// searches their names, then the text of up to SEARCH_FILES of them.
async function searchCode(gh, { query, path }, page) {
  const folder = cleanPath(path) || cleanPath(page).replace(/\/?[^/]*\.[a-z0-9]+$/i, "");
  const where = await locate(gh, folder);
  const tree = await gh(`/repos/${where.repo}/git/trees/HEAD?recursive=1`);
  const under = where.path ? where.path + "/" : "";
  const files = tree.tree.filter((t) => t.type === "blob" && t.path.startsWith(under) && !SECRET_FILE.test(t.path));
  const needle = String(query).toLowerCase();
  const named = files.filter((f) => f.path.toLowerCase().includes(needle)).map((f) => webPath(where, f.path));
  const texts = files.filter((f) => !NOT_TEXT.test(f.path) && f.size <= 1_000_000);
  const searched = texts.slice(0, SEARCH_FILES);
  const lines = [];
  for (let i = 0; i < searched.length && lines.length < SEARCH_LINES; i += 10) {
    const batch = await Promise.all(searched.slice(i, i + 10).map((f) =>
      gh(contentsUrl(where, f.path), { raw: true }).then((text) => [f, text], () => [f, ""])));
    for (const [f, text] of batch) {
      text.split("\n").forEach((line, n) => {
        if (lines.length < SEARCH_LINES && line.toLowerCase().includes(needle)) lines.push(`${webPath(where, f.path)}:${n + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  }
  const scope = `${folder || "the site root"} (${where.repo})`;
  const out = [];
  if (named.length) out.push(`File names with "${query}":\n${named.slice(0, 20).join("\n")}`);
  out.push(lines.length ? `Lines with "${query}":\n${lines.join("\n")}` : `No lines with "${query}" in the files searched.`);
  if (texts.length > searched.length) out.push(`[Searched the text of ${searched.length} of ${texts.length} files under ${scope}. Give a narrower folder as path to search the rest.]`);
  if (tree.truncated) out.push("[The repo is too big to list in full, so some files weren't searched.]");
  return `Search of ${scope}:\n${out.join("\n")}`;
}

async function openPullRequest(gh, input, { origin, page, prs }) {
  const { title, body, changes } = input;
  if (!isText(title) || !title.trim() || !isText(body) || !Array.isArray(changes) || !changes.length) {
    return "Give a title, a body, and at least one change.";
  }
  if (changes.length > MAX_PR_FILES * 3) return "That's too many changes for one pull request.";
  if (prs.count >= MAX_PRS) return `This reply has already opened ${MAX_PRS} pull requests.`;

  const repoInfo = await gh(`/repos/${VEIL_REPO}`);
  const base = repoInfo.default_branch;
  const head = (await gh(`/repos/${VEIL_REPO}/git/ref/heads/${encodeURIComponent(base)}`)).object.sha;

  // Each file's new text, starting from what's on the default branch now.
  const files = new Map();
  for (const change of changes) {
    const clean = cleanPath(change?.path);
    const where = await locate(gh, clean);
    if (where.repo !== VEIL_REPO || !where.path) return `${clean || "That path"} isn't a file under ${VEIL_PATH}/, so it can't be changed here.`;
    if (SECRET_FILE.test(clean)) return `${clean} can hold secrets, so it can't be changed here.`;
    if (isText(change.content) && change.old_str === undefined) {
      files.set(where.path, change.content);
      continue;
    }
    if (!isText(change.old_str) || !change.old_str || !isText(change.new_str)) {
      return `The change to ${clean} needs old_str and new_str, or content.`;
    }
    if (!files.has(where.path)) {
      try { files.set(where.path, await gh(contentsUrl(where, where.path, head), { raw: true })); }
      catch { return `${clean} doesn't exist on ${base}. To add it, give its whole text as content.`; }
    }
    const text = files.get(where.path);
    const at = text.indexOf(change.old_str);
    if (at < 0) return `old_str wasn't found in ${clean}. Read the file again and copy it exactly.`;
    if (text.indexOf(change.old_str, at + 1) >= 0) return `old_str occurs more than once in ${clean}. Include more of the lines around it.`;
    files.set(where.path, text.slice(0, at) + change.new_str + text.slice(at + change.old_str.length));
  }
  if (files.size > MAX_PR_FILES) return `A pull request here can change at most ${MAX_PR_FILES} files.`;

  // One commit on a new branch, then the pull request.
  const baseTree = (await gh(`/repos/${VEIL_REPO}/git/commits/${head}`)).tree.sha;
  const tree = await gh(`/repos/${VEIL_REPO}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTree, tree: [...files].map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
  });
  const commit = await gh(`/repos/${VEIL_REPO}/git/commits`, {
    method: "POST",
    body: { message: title.trim(), tree: tree.sha, parents: [head] },
  });
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
  const branch = `voice/${slug}-${Date.now().toString(36)}`;
  await gh(`/repos/${VEIL_REPO}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  const from = page ? `${origin}${page}` : origin;
  const pr = await gh(`/repos/${VEIL_REPO}/pulls`, {
    method: "POST",
    body: { title: title.trim(), head: branch, base, body: `${body.trim()}\n\n---\nOpened from the voice widget at ${from}` },
  });
  prs.count++;
  return `Opened pull request #${pr.number} (${pr.html_url}) from branch ${branch} into ${base}, changing ${[...files.keys()].join(", ")}.`;
}

// The voice widget's tools, for one request. page: the path (and hash) of the page the person is on.
export function siteCodeTools(env, { origin, page }) {
  const gh = github(env);
  const canPr = !!env.VEIL_REPO_TOKEN;
  const prs = { count: 0 };
  return {
    // For the settings panel's Agent section.
    label: canPr ? "Site code on GitHub, and pull requests to DesktopFolders/veil" : "Site code on GitHub (read-only)",
    definitions: canPr ? [...DEFINITIONS, PR_DEFINITION] : DEFINITIONS,
    prompt: prompt(canPr, page),
    // What the page shows while a tool runs.
    target: (name, input) => cleanPath(input?.path) || (name === "search_code" ? String(input?.query || "") : ""),
    async run(name, input) {
      const args = input && typeof input === "object" ? input : {};
      if (name !== "open_pull_request" && args.path !== undefined && !isText(args.path)) return "path must be text.";
      if (name === "list_files") return listFiles(gh, args);
      if (name === "read_file") return readFile(gh, args);
      if (name === "search_code") return isText(args.query) && args.query.trim() ? searchCode(gh, args, page) : "Give a query.";
      if (name === "open_pull_request" && canPr) return openPullRequest(gh, args, { origin, page, prs });
      return `There's no ${name} tool.`;
    },
  };
}

const prompt = (canPr, page) => `

Files: this website's source code is on GitHub, and you can look at it with list_files, read_file and search_code, by each file's path on the site (veil/code/app.js, localsite/js/localsite.js). Most top-level folders are their own ModelEarth repos; veil is the DesktopFolders/veil repo.
When a question is about this site, its pages, code, data or documentation, look at its files, then answer from what you found.
- Never read or repeat secrets: env files, keys, tokens or passwords.
- Everything you write is one spoken reply: the mood header only once, at the very start, and the summary only once, at the very end.
- Tell what you found as you would in conversation: name files and folders plainly, without spelling out paths or reading code aloud.${pagePath(page) ? `
- A question about the page they're on starts with that page's own files: read ${pageFile(page)}, then the README.md in its folder if there is one, and answer from those. Look further only when they don't answer it.` : ""}${canPr ? `
- Changes: when the person asks you to change, fix or add something under veil, read the file first, then use open_pull_request to propose it, copying old_str exactly from what you read. It opens a pull request for the team to review, so nothing on the site changes until someone merges it. Tell them its number when it's open. Open one only when they ask for a change, and don't make changes they didn't ask for.
- Files outside veil can't be changed from here, so say so if they ask.` : `
- You can only read. Files can't be changed from here.`}`;
