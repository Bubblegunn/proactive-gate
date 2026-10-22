import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const chicago = { id: "u_1", phone: "+13125550142", timezone: "America/Chicago" };
const at = (iso) => new Date(iso);

test("allowed inside the window (Chicago, CDT = UTC-5)", () => {
  const r = checkSms(chicago, at("2026-10-23T15:00:00Z")); // 10:00 local
  assert.equal(r.allowed, true);
  assert.equal(r.nextAllowedAt, null);
});

test("09:00 local is allowed, 08:59 is held until 09:00", () => {
  assert.equal(checkSms(chicago, at("2026-10-23T14:00:00Z")).allowed, true); // 09:00 CDT
  const early = checkSms(chicago, at("2026-10-23T13:59:00Z")); // 08:59 CDT
  assert.equal(early.allowed, false);
  assert.equal(early.nextAllowedAt.toISOString(), "2026-10-23T14:00:00.000Z");
});

test("20:00 local is held (window end is exclusive), reopens next morning", () => {
  const r = checkSms(chicago, at("2026-10-24T01:00:00Z")); // 20:00 CDT on Oct 23
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-10-24T14:00:00.000Z");
});

test("half-hour zone (Asia/Kolkata, UTC+5:30)", () => {
  const ist = { id: "u_2", phone: "+919876543210", timezone: "Asia/Kolkata" };
  assert.equal(checkSms(ist, at("2026-10-23T03:30:00Z")).allowed, true); // 09:00 IST
  const r = checkSms(ist, at("2026-10-23T03:29:00Z")); // 08:59 IST
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-10-23T03:30:00.000Z");
});

test("nextAllowedAt is correct across a DST change (New York falls back Nov 1 2026)", () => {
  const ny = { id: "u_3", phone: "+12125550100", timezone: "America/New_York" };
  // 2026-11-01T01:00Z = 21:00 EDT on Oct 31. Next 09:00 is EST (UTC-5) on Nov 1 = 14:00Z.
  const r = checkSms(ny, at("2026-11-01T01:00:00Z"));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt.toISOString(), "2026-11-01T14:00:00.000Z");
});

test("missing or invalid time zone is held with no retry time", () => {
  for (const tz of [null, undefined, "", "Mars/Olympus", "not a zone"]) {
    const r = checkSms({ ...chicago, timezone: tz }, at("2026-10-23T15:00:00Z"));
    assert.equal(r.allowed, false, `tz=${tz}`);
    assert.equal(r.nextAllowedAt, null, `tz=${tz}`);
    assert.ok(r.reason.length > 0);
  }
});

test("invalid phone is held with no retry time", () => {
  const r = checkSms({ ...chicago, phone: "312-555-0142" }, at("2026-10-23T15:00:00Z"));
  assert.equal(r.allowed, false);
  assert.equal(r.nextAllowedAt, null);
});

test("invalid now throws", () => {
  assert.throws(() => checkSms(chicago, new Date("nope")), TypeError);
  assert.throws(() => checkSms(chicago, "2026-10-23"), TypeError);
});

test("nextAllowedAt is the earliest allowed instant (never too early)", () => {
  const users = [
    chicago,
    { id: "u_2", phone: "+919876543210", timezone: "Asia/Kolkata" },
    { id: "u_3", phone: "+12125550100", timezone: "America/New_York" },
    { id: "u_4", phone: "+14155550100", timezone: "America/St_Johns" }, // UTC-2:30 / -3:30
  ];
  const start = Date.parse("2026-10-22T00:00:00Z");
  let checked = 0;
  for (const u of users) {
    for (let t = start; t < start + 4 * 86400000; t += 7 * 60000) {
      const r = checkSms(u, new Date(t));
      if (r.allowed) continue;
      assert.ok(r.nextAllowedAt, `${u.timezone} at ${new Date(t).toISOString()}`);
      const next = r.nextAllowedAt.getTime();
      assert.equal(checkSms(u, new Date(next)).allowed, true, `${u.timezone} next not allowed`);
      assert.equal(checkSms(u, new Date(next - 1000)).allowed, false, `${u.timezone} too early`);
      checked++;
    }
  }
  assert.ok(checked > 1000);
});
