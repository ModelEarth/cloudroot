import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validatePayload, summarizeShape } from "../src/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures/sample-meeting.json"), "utf8"));

test("accepts the real TranscripTonic advanced-body shape", () => {
  const result = validatePayload(fixture, JSON.stringify(fixture).length);
  assert.equal(result.ok, true);
});

test("rejects a non-Meet payload", () => {
  const result = validatePayload({ ...fixture, meetingSoftware: "zoom" }, 10);
  assert.equal(result.ok, false);
});

test("rejects the simple (non-advanced) body type", () => {
  const result = validatePayload({ ...fixture, webhookBodyType: "simple" }, 10);
  assert.equal(result.ok, false);
});

test("rejects an empty transcript", () => {
  const result = validatePayload({ ...fixture, transcript: [] }, 10);
  assert.equal(result.ok, false);
});

test("rejects a transcript entry missing transcriptText", () => {
  const bad = { ...fixture, transcript: [{ personName: "Alex", timestamp: fixture.transcript[0].timestamp }] };
  const result = validatePayload(bad, 10);
  assert.equal(result.ok, false);
});

test("rejects an unparseable meetingStartTimestamp", () => {
  const result = validatePayload({ ...fixture, meetingStartTimestamp: "not-a-date" }, 10);
  assert.equal(result.ok, false);
});

test("rejects a payload over the size limit", () => {
  const result = validatePayload(fixture, 6 * 1024 * 1024);
  assert.equal(result.ok, false);
});

test("summarizeShape carries entry counts, never transcript text", () => {
  const shape = summarizeShape(fixture);
  assert.equal(shape.transcriptEntries, fixture.transcript.length);
  assert.equal(shape.chatMessageEntries, fixture.chatMessages.length);
  assert.ok(!("transcript" in shape));
  assert.ok(!("chatMessages" in shape));
});
