/**
 * Payload checks for the advanced-mode TranscripTonic webhook body, run
 * before any GitHub call (added in phase 2). meetingSoftware is the
 * human-readable "Google Meet" - confirmed against a real meeting's
 * payload (the extension's doc examples in meetings.html show the same).
 * "google_meet" (lowercase, underscored) is a different, internal id used
 * elsewhere in the extension for permission tracking, not what's sent here.
 */

export const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5 MB, per the plan's Worker spec

export function validatePayload(body, rawByteLength) {
  if (rawByteLength > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
  }
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "body is not a JSON object" };
  }
  if (body.webhookBodyType !== "advanced") {
    return {
      ok: false,
      reason: `webhookBodyType must be "advanced", got ${JSON.stringify(body.webhookBodyType)}`,
    };
  }
  if (body.meetingSoftware !== "Google Meet") {
    return {
      ok: false,
      reason: `meetingSoftware must be "Google Meet", got ${JSON.stringify(body.meetingSoftware)}`,
    };
  }
  if (!Array.isArray(body.transcript) || body.transcript.length === 0) {
    return { ok: false, reason: "transcript must be a non-empty array" };
  }
  for (const entry of body.transcript) {
    if (
      typeof entry?.personName !== "string" ||
      typeof entry?.timestamp !== "string" ||
      typeof entry?.transcriptText !== "string"
    ) {
      return { ok: false, reason: "every transcript entry needs personName, timestamp and transcriptText" };
    }
  }
  if (typeof body.meetingStartTimestamp !== "string" || Number.isNaN(Date.parse(body.meetingStartTimestamp))) {
    return { ok: false, reason: "meetingStartTimestamp must be a parseable date string" };
  }
  return { ok: true };
}

// What phase 1 logs instead of the raw body - entry counts and metadata
// only, never transcriptText/chatMessageText content.
export function summarizeShape(body) {
  return {
    webhookBodyType: body.webhookBodyType,
    meetingSoftware: body.meetingSoftware,
    meetingTitle: body.meetingTitle,
    meetingStartTimestamp: body.meetingStartTimestamp,
    meetingEndTimestamp: body.meetingEndTimestamp,
    transcriptEntries: Array.isArray(body.transcript) ? body.transcript.length : 0,
    chatMessageEntries: Array.isArray(body.chatMessages) ? body.chatMessages.length : 0,
  };
}
