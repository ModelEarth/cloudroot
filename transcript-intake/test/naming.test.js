import { test } from "node:test";
import assert from "node:assert/strict";
import { getDateAndHHMM } from "../src/naming.js";

test("converts a UTC timestamp to America/Los_Angeles date and HHMM (PDT, no day rollover)", () => {
  // 17:00 UTC on 2026-10-01 is PDT (UTC-7) -> 10:00 same day.
  const { date, hhmm } = getDateAndHHMM("2026-10-01T17:00:00.000Z");
  assert.equal(date, "2026-10-01");
  assert.equal(hhmm, "1000");
});

test("rolls the date back a day when Pacific time is still the previous day", () => {
  // 03:00 UTC on 2026-10-02 is PDT (UTC-7) -> 20:00 on 2026-10-01.
  const { date, hhmm } = getDateAndHHMM("2026-10-02T03:00:00.000Z");
  assert.equal(date, "2026-10-01");
  assert.equal(hhmm, "2000");
});

test("handles standard time (PST, UTC-8) in winter", () => {
  // 17:00 UTC on 2026-01-15 is PST (UTC-8) -> 09:00 same day.
  const { date, hhmm } = getDateAndHHMM("2026-01-15T17:00:00.000Z");
  assert.equal(date, "2026-01-15");
  assert.equal(hhmm, "0900");
});

test("pads single-digit hour and minute to two digits", () => {
  // 09:05 UTC on 2026-10-01 is PDT (UTC-7) -> 02:05 same day.
  const { date, hhmm } = getDateAndHHMM("2026-10-01T09:05:00.000Z");
  assert.equal(date, "2026-10-01");
  assert.equal(hhmm, "0205");
});
