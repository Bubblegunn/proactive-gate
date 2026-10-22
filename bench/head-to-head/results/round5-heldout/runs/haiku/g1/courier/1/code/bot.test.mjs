import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const OK_BODY = "Sale today! Reply STOP to opt out.";
const base = (over = {}) => ({
  kind: "marketing",
  body: OK_BODY,
  to: {
    phone: "+13125550142",
    timeZone: "America/Chicago",
    marketingConsent: true,
    optedOutAt: null,
    ...over.to,
  },
  ...over.top,
});

// 2025-01-15 is in winter: Chicago = UTC-6, New York = UTC-5, LA = UTC-8.
// Build instants from a UTC hour so the test does not depend on the host zone.
const utc = (h) => new Date(Date.UTC(2025, 0, 15, h, 30, 0));

test("marketing allowed at 10:00 Chicago", () => {
  assert.deepEqual(checkSms(base(), utc(16)), { allowed: true, reason: null }); // 16:30Z = 10:30 CST
});

test("quiet hours: 7:59 local blocked, 8:00 local allowed", () => {
  // 13:59Z = 07:59 CST
  assert.equal(checkSms(base(), new Date(Date.UTC(2025, 0, 15, 13, 59))).reason, "telemarketing_quiet_hours");
  // 14:00Z = 08:00 CST
  assert.equal(checkSms(base(), new Date(Date.UTC(2025, 0, 15, 14, 0))).allowed, true);
});

test("quiet hours: 20:59 local allowed, 21:00 local blocked", () => {
  // 02:59Z next day = 20:59 CST
  assert.equal(checkSms(base(), new Date(Date.UTC(2025, 0, 16, 2, 59))).allowed, true);
  // 03:00Z = 21:00 CST
  assert.equal(checkSms(base(), new Date(Date.UTC(2025, 0, 16, 3, 0))).reason, "telemarketing_quiet_hours");
});

test("quiet hours follow the customer zone, not UTC or the server zone", () => {
  // 03:00Z = 22:00 EST (previous day) -> blocked for New York
  assert.equal(
    checkSms(base({ to: { timeZone: "America/New_York" } }), new Date(Date.UTC(2025, 0, 16, 3, 0))).reason,
    "telemarketing_quiet_hours",
  );
  // 03:00Z = 19:00 PST previous day -> allowed for LA
  assert.equal(
    checkSms(base({ to: { timeZone: "America/Los_Angeles" } }), new Date(Date.UTC(2025, 0, 16, 3, 0))).allowed,
    true,
  );
});

test("DST: quiet hours use the zone's offset on that date", () => {
  // 2025-07-15 Chicago is CDT (UTC-5). 13:00Z = 08:00 CDT -> allowed.
  const summer = new Date(Date.UTC(2025, 6, 15, 13, 0));
  assert.equal(checkSms(base(), summer).allowed, true);
  // 12:59Z = 07:59 CDT -> blocked
  assert.equal(checkSms(base(), new Date(Date.UTC(2025, 6, 15, 12, 59))).reason, "telemarketing_quiet_hours");
});

test("marketing without written consent blocked", () => {
  assert.equal(checkSms(base({ to: { marketingConsent: false } }), utc(16)).reason, "marketing_consent_missing");
  assert.equal(checkSms(base({ to: { marketingConsent: undefined } }), utc(16)).reason, "marketing_consent_missing");
});

test("marketing without opt-out instructions blocked", () => {
  const m = base({ top: { body: "Sale today!" } });
  assert.equal(checkSms(m, utc(16)).reason, "marketing_missing_opt_out_instructions");
});

test("opt-out blocks marketing and transactional alike", () => {
  const opted = { optedOutAt: "2025-01-10T12:00:00Z" };
  assert.equal(checkSms(base({ to: opted }), utc(16)).reason, "opted_out");
  assert.equal(checkSms(base({ top: { kind: "transactional" }, to: opted }), utc(16)).reason, "opted_out");
});

test("invalid opt-out timestamp blocked (fail closed)", () => {
  assert.equal(checkSms(base({ to: { optedOutAt: "not a date" } }), utc(16)).reason, "invalid_opt_out_timestamp");
});

test("transactional allowed without consent and outside quiet hours", () => {
  const t = base({ top: { kind: "transactional", body: "Your code is 123456" }, to: { marketingConsent: false } });
  assert.deepEqual(checkSms(t, new Date(Date.UTC(2025, 0, 16, 5, 0))), { allowed: true, reason: null }); // 23:00 CST
});

test("each rule has a distinct code", () => {
  const codes = [
    checkSms({ kind: "x", body: "a", to: {} }, utc(16)).reason,
    checkSms(base({ top: { body: "" } }), utc(16)).reason,
    checkSms(base({ to: { phone: "+4415550142" } }), utc(16)).reason,
    checkSms(base({ to: { optedOutAt: "2025-01-10T12:00:00Z" } }), utc(16)).reason,
    checkSms(base({ to: { marketingConsent: false } }), utc(16)).reason,
    checkSms(base({ top: { body: "Sale" } }), utc(16)).reason,
    checkSms(base({ to: { timeZone: "Mars/Olympus" } }), utc(16)).reason,
    checkSms(base(), new Date(Date.UTC(2025, 0, 15, 13, 0))).reason,
    checkSms(base(), new Date("nope")).reason,
  ];
  assert.equal(new Set(codes).size, codes.length, codes.join(","));
});

test("invalid inputs fail closed", () => {
  assert.equal(checkSms(base({ top: { kind: "promo" } }), utc(16)).reason, "invalid_kind");
  assert.equal(checkSms(base({ to: { phone: "3125550142" } }), utc(16)).reason, "invalid_phone");
  assert.equal(checkSms(base({ to: { timeZone: "Mars/Olympus" } }), utc(16)).reason, "invalid_time_zone");
  assert.equal(checkSms(base(), new Date("nope")).reason, "invalid_now");
});

test("server time zone does not change the result", () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      assert.equal(checkSms(base(), utc(16)).allowed, true, tz);
      assert.equal(checkSms(base(), new Date(Date.UTC(2025, 0, 15, 13, 0))).reason, "telemarketing_quiet_hours", tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});
