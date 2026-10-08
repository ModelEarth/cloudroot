/**
 * Cloudflare Worker: transcript intake
 * --------------------------------------
 * Webhook endpoint for the TranscripTonic Chrome extension (advanced body
 * mode). Checks the secret and payload shape, derives the date/HHMM from
 * meetingStartTimestamp, then creates cloudflare/<date>-<hhmm> on
 * archivist1 holding transcripts/<date>/meet/transcript.json, and opens a
 * PR into main (archivist1's claude-code-action workflow reacts to that).
 *
 * Route: POST /ingest/<WEBHOOK_SECRET>
 */

import { validatePayload, summarizeShape, MAX_PAYLOAD_BYTES } from "./validate.js";
import { getDateAndHHMM } from "./naming.js";
import { createTranscriptBranch, DuplicateError, GithubAuthError, PullRequestError } from "./github.js";

// Constant-time string compare: pads both sides to equal length first so
// that a length mismatch doesn't short-circuit and leak the secret's
// length via response timing.
function timingSafeEqual(a, b) {
  const length = Math.max(a.length, b.length, 1);
  const bufA = new TextEncoder().encode(a.padEnd(length, "\0"));
  const bufB = new TextEncoder().encode(b.padEnd(length, "\0"));
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/ingest\/([^/]+)$/);

    if (!match || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    if (!env.WEBHOOK_SECRET || !timingSafeEqual(match[1], env.WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const raw = await request.text();
    if (raw.length > MAX_PAYLOAD_BYTES) {
      return new Response("Payload too large", { status: 400 });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const result = validatePayload(body, raw.length);
    if (!result.ok) {
      console.log("rejected:", result.reason);
      return new Response(result.reason, { status: 400 });
    }

    const shape = summarizeShape(body);
    const { date, hhmm } = getDateAndHHMM(body.meetingStartTimestamp);

    try {
      const branch = await createTranscriptBranch(env, {
        date,
        hhmm,
        meetingJson: JSON.stringify(body, null, 2),
        meetingTitle: body.meetingTitle,
      });
      console.log("created:", JSON.stringify({ ...shape, date, branch }));
      return new Response("OK", { status: 200 });
    } catch (err) {
      if (err instanceof DuplicateError) {
        console.log("duplicate:", JSON.stringify({ ...shape, date }));
        return new Response(err.message, { status: 409 });
      }
      if (err instanceof PullRequestError) {
        console.log("pr-error:", JSON.stringify({ ...shape, date, error: err.message }));
        return new Response(err.message, { status: 502 });
      }
      if (err instanceof GithubAuthError) {
        console.log("github-auth-error:", JSON.stringify({ ...shape, date }));
        return new Response("GitHub token rejected", { status: 500 });
      }
      // GithubApiError, or anything else unexpected from the GitHub calls.
      console.log("github-error:", JSON.stringify({ ...shape, date, error: err.message }));
      return new Response("GitHub or network error", { status: 502 });
    }
  },
};
