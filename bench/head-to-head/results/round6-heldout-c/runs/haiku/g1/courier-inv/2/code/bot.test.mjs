import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const MIN = 60 * 1000;
const chicago = { id: "u_1", phone: "+13125550142", timezone: "America/Chicago" };
const nullZone = { id: "u_2", phone: "+13125550143", timezone: null };
const badZone = { id: "u_3", phone: "+13125550144", timezone: "Mars/Olympus" };

test("Chicago: 08:00 CST (14:00Z) opens, 07:59 is held until 08:00", () => {
  const open = checkSms(chicago, new Date("2026-01-15T14:00:00Z"));
  assert.equal(open.allowed, true);
  assert.equal(open.nextAllowedAt, null);

  const held = checkSms(chicago, new Date("2026-01-15T13:59:00Z"));
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), "2026-01-15T14:00:00.000Z");
});

test("Chicago: 20:59:59 local is allowed, 21:00 local is held until next 08:00", () => {
  assert.equal(checkSms(chicago, new Date("2026-01-16T02:59:59Z")).allowed, true);
  const held = checkSms(chicago, new Date("2026-01-16T03:00:00Z"));
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), "2026-01-16T14:00:00.000Z");
});

test("sub-minute now: 13:59:30.500Z is held, next time is the exact 14:00:00Z", () => {
  const held = checkSms(chicago, new Date("2026-01-15T13:59:30.500Z"));
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), "2026-01-15T14:00:00.000Z");
});

test("half-hour zone: Asia/Kolkata 08:00 IST is 02:30Z", () => {
  const kolkata = { id: "u_4", phone: "+919876543210", timezone: "Asia/Kolkata" };
  const held = checkSms(kolkata, new Date("2026-01-15T02:29:00Z"));
  assert.equal(held.allowed, false);
  assert.equal(held.nextAllowedAt.toISOString(), "2026-01-15T02:30:00.000Z");
  assert.equal(checkSms(kolkata, new Date("2026-01-15T02:30:00Z")).allowed, true);
});

test("DST: New York in July, 08:00 EDT is 12:00Z", () => {
  const ny = { id: "u_5", phone: "+12125550100", timezone: "America/New_York" };
  const held = checkSms(ny, new Date("2026-07-15T11:59:00Z"));
  assert.equal(held.nextAllowedAt.toISOString(), "2026-07-15T12:00:00.000Z");
  assert.equal(checkSms(ny, new Date("2026-07-15T12:00:00Z")).allowed, true);
});

test("Honolulu: 08:00 HST is 18:00Z", () => {
  const hi = { id: "u_6", phone: "+18085550100", timezone: "Pacific/Honolulu" };
  const held = checkSms(hi, new Date("2026-01-15T17:00:00Z"));
  assert.equal(held.nextAllowedAt.toISOString(), "2026-01-15T18:00:00.000Z");
});

test("null and unknown zones use the every-US-zone window, and nextAllowedAt is exact", () => {
  for (const user of [nullZone, badZone]) {
    const start = new Date("2026-01-15T13:00:00Z");
    const held = checkSms(user, start);
    assert.equal(held.allowed, false);
    assert.ok(held.reason.includes("every US time zone"));
    const next = held.nextAllowedAt;
    assert.ok(next > start);
    assert.equal(checkSms(user, next).allowed, true);
    // One minute earlier must still be held, so the retry is never too early.
    assert.equal(checkSms(user, new Date(next.getTime() - MIN)).allowed, false);
  }
});

test("null zone: an instant that is fine in Chicago but not in Honolulu is held", () => {
  // 15:00Z is 09:00 Chicago but 05:00 Honolulu.
  const r = checkSms(nullZone, new Date("2026-01-15T15:00:00Z"));
  assert.equal(r.allowed, false);
});

test("reason strings are non-empty and never null when held", () => {
  const r = checkSms(chicago, new Date("2026-01-15T03:00:00Z"));
  assert.equal(typeof r.reason, "string");
  assert.ok(r.reason.length > 0);
});

test("invalid now throws", () => {
  assert.throws(() => checkSms(chicago, new Date("nope")), TypeError);
  assert.throws(() => checkSms(chicago, "2026-01-15"), TypeError);
});
