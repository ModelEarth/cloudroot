import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriptBranch, DuplicateError, GithubAuthError, GithubApiError, PullRequestError } from "../src/github.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(status, body = "") {
  return new Response(body, { status });
}

function envWithFetch(fetchImpl) {
  globalThis.fetch = fetchImpl;
  return { ARCHIVIST_REPO: "ravi-p-k-1/archivist1", ARCHIVIST_TOKEN: "fake-token" };
}

function withGitDataHandlers(extra) {
  return async (url, options) => {
    const path = new URL(url).pathname;
    const method = options?.method || "GET";
    if (path.endsWith("/git/ref/heads/main")) return jsonResponse(200, { object: { sha: "main-sha" } });
    if (path.endsWith("/git/commits/main-sha")) return jsonResponse(200, { tree: { sha: "tree-sha" } });
    if (path.includes("/contents/transcripts/")) return textResponse(404);
    if (path.includes("/contents/archived/")) return textResponse(404);
    if (path.includes("/git/matching-refs/")) return jsonResponse(200, []);
    if (path.endsWith("/git/trees") && method === "POST") return jsonResponse(201, { sha: "new-tree-sha" });
    if (path.endsWith("/git/commits") && method === "POST") return jsonResponse(201, { sha: "new-commit-sha" });
    if (path.endsWith("/git/refs") && method === "POST") return jsonResponse(201, { ref: "refs/heads/cloudflare/2026-10-01-1000" });
    return extra(path, method, url, options);
  };
}

test("creates the branch and opens the PR when nothing is a duplicate", async () => {
  const pullRequests = [];
  const env = envWithFetch(
    withGitDataHandlers((path, method) => {
      if (path.endsWith("/pulls") && method === "POST") {
        pullRequests.push(path);
        return jsonResponse(201, { number: 7 });
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    })
  );

  const branch = await createTranscriptBranch(env, {
    date: "2026-10-01",
    hhmm: "1000",
    meetingJson: "{}",
    meetingTitle: "Weekly sync",
  });
  assert.equal(branch, "cloudflare/2026-10-01-1000");
  assert.equal(pullRequests.length, 1);
});

test("sends head, base and a readable title when opening the PR", async () => {
  let prBody;
  const env = envWithFetch(
    withGitDataHandlers((path, method, url, options) => {
      if (path.endsWith("/pulls") && method === "POST") {
        prBody = JSON.parse(options.body);
        return jsonResponse(201, { number: 7 });
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    })
  );

  await createTranscriptBranch(env, {
    date: "2026-10-01",
    hhmm: "1800",
    meetingJson: "{}",
    meetingTitle: "Weekly sync",
  });

  assert.equal(prBody.head, "cloudflare/2026-10-01-1800"); // built from date/hhmm, not from the mocked /git/refs response
  assert.equal(prBody.base, "main");
  assert.equal(prBody.title, "Transcript: 2026-10-01 18:00 — Weekly sync");
});

test("falls back to a generic title when meetingTitle is missing", async () => {
  let prBody;
  const env = envWithFetch(
    withGitDataHandlers((path, method, url, options) => {
      if (path.endsWith("/pulls") && method === "POST") {
        prBody = JSON.parse(options.body);
        return jsonResponse(201, { number: 7 });
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    })
  );

  await createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1800", meetingJson: "{}" });
  assert.match(prBody.title, /— Meeting$/);
});

test("throws PullRequestError (not GithubAuthError) when the PR call is rejected after the branch exists", async () => {
  const env = envWithFetch(
    withGitDataHandlers((path, method) => {
      if (path.endsWith("/pulls") && method === "POST") return textResponse(403);
      throw new Error(`unexpected request: ${method} ${path}`);
    })
  );

  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    PullRequestError
  );
});

test("throws PullRequestError on a network failure opening the PR", async () => {
  const env = envWithFetch(
    withGitDataHandlers((path, method) => {
      if (path.endsWith("/pulls") && method === "POST") throw new Error("boom");
      throw new Error(`unexpected request: ${method} ${path}`);
    })
  );

  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    PullRequestError
  );
});

test("throws DuplicateError when transcripts/<date> already exists on main", async () => {
  const env = envWithFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/git/ref/heads/main")) return jsonResponse(200, { object: { sha: "main-sha" } });
    if (path.endsWith("/git/commits/main-sha")) return jsonResponse(200, { tree: { sha: "tree-sha" } });
    if (path.includes("/contents/transcripts/")) return jsonResponse(200, { name: "transcript.json" });
    if (path.includes("/contents/archived/")) return textResponse(404);
    if (path.includes("/git/matching-refs/")) return jsonResponse(200, []);
    throw new Error(`unexpected request past the duplicate check: ${path}`);
  });

  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    DuplicateError
  );
});

test("throws DuplicateError when a cloudflare/<date>* branch already exists", async () => {
  const env = envWithFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/git/ref/heads/main")) return jsonResponse(200, { object: { sha: "main-sha" } });
    if (path.endsWith("/git/commits/main-sha")) return jsonResponse(200, { tree: { sha: "tree-sha" } });
    if (path.includes("/contents/transcripts/")) return textResponse(404);
    if (path.includes("/contents/archived/")) return textResponse(404);
    if (path.includes("/git/matching-refs/")) return jsonResponse(200, [{ ref: "refs/heads/cloudflare/2026-10-01-0900" }]);
    throw new Error(`unexpected request past the duplicate check: ${path}`);
  });

  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    DuplicateError
  );
});

test("throws GithubAuthError on a 401 from GitHub", async () => {
  const env = envWithFetch(async () => textResponse(401));
  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    GithubAuthError
  );
});

test("throws GithubApiError on an unexpected GitHub status", async () => {
  const env = envWithFetch(async (url) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/git/ref/heads/main")) return textResponse(500);
    throw new Error(`unexpected request: ${path}`);
  });
  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    GithubApiError
  );
});

test("throws DuplicateError when creating the ref races into a 422", async () => {
  const env = envWithFetch(async (url, options) => {
    const path = new URL(url).pathname;
    const method = options?.method || "GET";
    if (path.endsWith("/git/ref/heads/main")) return jsonResponse(200, { object: { sha: "main-sha" } });
    if (path.endsWith("/git/commits/main-sha")) return jsonResponse(200, { tree: { sha: "tree-sha" } });
    if (path.includes("/contents/transcripts/")) return textResponse(404);
    if (path.includes("/contents/archived/")) return textResponse(404);
    if (path.includes("/git/matching-refs/")) return jsonResponse(200, []);
    if (path.endsWith("/git/trees") && method === "POST") return jsonResponse(201, { sha: "new-tree-sha" });
    if (path.endsWith("/git/commits") && method === "POST") return jsonResponse(201, { sha: "new-commit-sha" });
    if (path.endsWith("/git/refs") && method === "POST") return textResponse(422);
    throw new Error(`unexpected request: ${method} ${path}`);
  });

  await assert.rejects(
    createTranscriptBranch(env, { date: "2026-10-01", hhmm: "1000", meetingJson: "{}" }),
    DuplicateError
  );
});
