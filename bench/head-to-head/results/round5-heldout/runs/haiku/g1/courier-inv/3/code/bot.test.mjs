import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const CHICAGO_10AM = new Date("2026-10-22T15:00:00Z"); // 10:00 CDT
const CHICAGO_9PM = new Date("2026-10-23T02:00:00Z"); // 21:00 CDT, quiet starts
const CHICAGO_8AM = new Date("2026-10-22T13:00:00Z"); // 08:00 CDT, quiet ends
const CHICAGO_759AM = new Date("2026-10-22T12:59:00Z"); // 07:59 CDT, still quiet

const MARKETING_BODY = "Back in stock! Reply STOP to opt out.";

function msg(overrides = {}) {
  const base = {
    kind: "marketing",
    body: MARKETING_BODY,
    to: {
      phone: "+13125550142",
      timeZone: "America/Chicago",
      marketingConsent: true,
      optedOutAt: null,
    },
  };
  return {
    ...base,
    ...overrides,
    to: { ...base.to, ...(overrides.to ?? {}) },
  };
}

test("marketing text inside the window with consent is allowed", () => {
  assert.deepEqual(checkSms(msg(), CHICAGO_10AM), { allowed: true, reason: null });
});

test("transactional text is allowed at night without marketing consent", () => {
  const m = msg({
    kind: "transactional",
    body: "Your login code is 123456",
    to: { marketingConsent: false },
  });
  assert.deepEqual(checkSms(m, CHICAGO_9PM), { allowed: true, reason: null });
});

test("quiet hours: 21:00 local blocks marketing, 08:00 local allows", () => {
  assert.equal(checkSms(msg(), CHICAGO_9PM).reason, "quiet_hours");
  assert.equal(checkSms(msg(), CHICAGO_759AM).reason, "quiet_hours");
  assert.deepEqual(checkSms(msg(), CHICAGO_8AM), { allowed: true, reason: null });
});

test("quiet hours use the customer's zone, not the server's", () => {
  // 09:00Z is 04:00 in Chicago (CDT, quiet) but 10:00 in London (BST, daytime).
  const at = new Date("2026-10-22T09:00:00Z");
  assert.equal(checkSms(msg(), at).reason, "quiet_hours");
  assert.deepEqual(
    checkSms(msg({ to: { timeZone: "Europe/London" } }), at),
    { allowed: true, reason: null },
  );
});

test("marketing without consent is blocked", () => {
  assert.equal(
    checkSms(msg({ to: { marketingConsent: false } }), CHICAGO_10AM).reason,
    "no_marketing_consent",
  );
});

test("STOP blocks both kinds, with reason opted_out", () => {
  const stopped = { optedOutAt: "2026-10-01T12:00:00Z" };
  assert.equal(checkSms(msg({ to: stopped }), CHICAGO_10AM).reason, "opted_out");
  const otp = msg({ kind: "transactional", body: "Code 1", to: stopped });
  assert.equal(checkSms(otp, CHICAGO_10AM).reason, "opted_out");
});

test("marketing without STOP instruction is blocked", () => {
  assert.equal(
    checkSms(msg({ body: "Sale today only!" }), CHICAGO_10AM).reason,
    "missing_opt_out_language",
  );
});

test("bad phone, zone, time, and timestamp each fail closed with their own code", () => {
  assert.equal(checkSms(msg({ to: { phone: "3125550142" } }), CHICAGO_10AM).reason, "invalid_phone");
  assert.equal(checkSms(msg({ to: { phone: "+13120550142" } }), CHICAGO_10AM).reason, "invalid_phone"); // exchange starts with 0
  assert.equal(checkSms(msg({ to: { phone: "+11125550142" } }), CHICAGO_10AM).reason, "invalid_phone"); // area code starts with 1
  assert.equal(checkSms(msg({ to: { timeZone: "Mars/Olympus" } }), CHICAGO_10AM).reason, "invalid_time_zone");
  assert.equal(checkSms(msg(), new Date("nope")).reason, "invalid_now");
  assert.equal(
    checkSms(msg({ to: { optedOutAt: "not a date" } }), CHICAGO_10AM).reason,
    "invalid_opt_out_timestamp",
  );
});

test("every block returns allowed:false with a non-null reason; allowed returns null", () => {
  const cases = [
    [msg({ to: { marketingConsent: false } }), CHICAGO_10AM],
    [msg(), CHICAGO_9PM],
    [msg({ body: "no stop here" }), CHICAGO_10AM],
    [msg({ to: { optedOutAt: "2026-10-01T00:00:00Z" } }), CHICAGO_10AM],
  ];
  for (const [m, t] of cases) {
    const r = checkSms(m, t);
    assert.equal(r.allowed, false);
    assert.equal(typeof r.reason, "string");
  }
  assert.equal(checkSms(msg(), CHICAGO_10AM).reason, null);
});

test("malformed message fails closed", () => {
  assert.equal(checkSms(null, CHICAGO_10AM).reason, "invalid_message");
  assert.equal(checkSms({ kind: "promo" }, CHICAGO_10AM).reason, "invalid_message");
});
