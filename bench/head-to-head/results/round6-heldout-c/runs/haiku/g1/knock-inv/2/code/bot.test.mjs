import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const chicago = { id: "u_1", phone: "+13125550142", timezone: "America/Chicago" };
const at = (iso) => new Date(iso);

test("allowed inside the window, nextAllowedAt is null", () => {
  const r = checkSms(chicago, at("2026-10-23T15:15:00Z")); // 10:15 CDT
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
  assert.equal(typeof r.reason, "string");
});

test("08:00 local is allowed, 07:59:59 is held until 08:00 the same day", () => {
  assert.equal(checkSms(chicago, at("2026-10-23T13:00:00Z")).allowed, true); // 08:00 CDT
  const early = checkSms(chicago, at("2026-10-23T12:59:59Z")); // 07:59:59 CDT
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), "2026-10-23T13:00:00.000Z");
});

test("19:59:59 is allowed, 20:00 is held until 08:00 the next day", () => {
  assert.equal(checkSms(chicago, at("2026-10-24T00:59:59Z")).allowed, true); // 19:59:59 CDT
  const late = checkSms(chicago, at("2026-10-24T01:00:00Z")); // 20:00 CDT
  assert.equal(late.allowed, false);
  assert.equal(late.nextAllowedAt.toISOString(), "2026-10-24T13:00:00.000Z");
});

test("half-hour zone: Asia/Kolkata (+05:30)", () => {
  const kolkata = { id: "u_2", phone: "+919876543210", timezone: "Asia/Kolkata" };
  assert.equal(checkSms(kolkata, at("2026-10-23T12:30:00Z")).allowed, true); // 18:00 IST
  const r = checkSms(kolkata, at("2026-10-22T23:00:00Z")); // 04:30 IST on Oct 23
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-10-23T02:30:00.000Z"); // 08:00 IST
});

test("DST spring forward (America/Chicago, 2026-03-08): next 08:00 is CDT", () => {
  const r = checkSms(chicago, at("2026-03-08T02:30:00Z")); // Mar 7 20:30 CST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-03-08T13:00:00.000Z"); // 08:00 CDT
});

test("DST fall back (America/Chicago, 2026-11-01): next 08:00 is CST", () => {
  const r = checkSms(chicago, at("2026-11-01T01:30:00Z")); // Oct 31 20:30 CDT
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-11-01T14:00:00.000Z"); // 08:00 CST
});

test("far-west zone: Pacific/Honolulu (-10:00) evening hold", () => {
  const honolulu = { id: "u_3", phone: "+18085550100", timezone: "Pacific/Honolulu" };
  const r = checkSms(honolulu, at("2026-10-23T06:00:00Z")); // Oct 22 20:00 HST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-10-23T18:00:00.000Z"); // Oct 23 08:00 HST
});

test("null, empty, or unrecognised time zone is held with no retry time", () => {
  for (const timezone of [null, undefined, "", "Mars/Olympus_Mons", "not a zone", 42]) {
    const r = checkSms({ ...chicago, timezone }, at("2026-10-23T15:15:00Z"));
    assert.equal(r.allowed, false, `timezone ${String(timezone)}`);
    assert.equal(r.nextAllowedAt, null, `timezone ${String(timezone)}`);
    assert.ok(r.reason.length > 0);
  }
});

test("missing phone is held with no retry time", () => {
  const r = checkSms({ id: "u_4", phone: "", timezone: "America/Chicago" }, at("2026-10-23T15:15:00Z"));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt, null);
});

test("reason never contains the phone number", () => {
  const r = checkSms(chicago, at("2026-10-23T02:00:00Z"));
  assert.ok(!r.reason.includes("3125550142"));
});

test("invalid now throws", () => {
  assert.throws(() => checkSms(chicago, new Date("nope")), TypeError);
  assert.throws(() => checkSms(chicago, "2026-10-23"), TypeError);
});

test("nextAllowedAt is exact: held just before it, allowed at it, over two months", () => {
  const zones = [
    "America/Chicago",
    "America/New_York",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
    "Asia/Kolkata",
    "Asia/Kathmandu",
    "Australia/Adelaide",
  ];
  const start = Date.UTC(2026, 2, 1);
  const stepMs = 37 * 60 * 1000; // 37 minutes, so every part of the day gets sampled
  for (const timezone of zones) {
    const user = { id: "p", phone: "+10000000000", timezone };
    for (let t = start; t < start + 62 * 24 * 3600 * 1000; t += stepMs) {
      const now = new Date(t);
      const r = checkSms(user, now);
      if (r.allowed) {
        assert.equal(r.nextAllowedAt, null);
        continue;
      }
      const next = r.nextAllowedAt;
      assert.ok(next instanceof Date, `${timezone} at ${now.toISOString()}`);
      assert.ok(next > now, `${timezone} next must be in the future`);
      assert.equal(checkSms(user, new Date(next.getTime() - 1000)).allowed, false, `${timezone} too early at ${now.toISOString()}`);
      assert.equal(checkSms(user, next).allowed, true, `${timezone} not allowed at retry time from ${now.toISOString()}`);
    }
  }
});
