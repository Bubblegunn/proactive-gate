import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

// October 2026: America/Chicago is CDT (UTC-5), America/Los_Angeles is PDT (UTC-7).
const at = (iso) => new Date(iso);

const CHICAGO_0759 = at("2026-10-22T12:59:00Z"); // 07:59 CDT
const CHICAGO_0800 = at("2026-10-22T13:00:00Z"); // 08:00 CDT
const CHICAGO_2059 = at("2026-10-23T01:59:00Z"); // 20:59 CDT
const CHICAGO_2100 = at("2026-10-23T02:00:00Z"); // 21:00 CDT

function marketing(overrides = {}) {
  return {
    kind: "marketing",
    body: "Back in stock! Reply STOP to opt out.",
    to: {
      phone: "+13125550142",
      timeZone: "America/Chicago",
      marketingConsent: true,
      optedOutAt: null,
      ...overrides,
    },
  };
}

function transactional(overrides = {}) {
  return {
    kind: "transactional",
    body: "Your login code is 123456.",
    to: {
      phone: "+13125550142",
      timeZone: "America/Chicago",
      marketingConsent: false,
      optedOutAt: null,
      ...overrides,
    },
  };
}

test("marketing allowed inside the window with consent and opt-out language", () => {
  assert.deepEqual(checkSms(marketing(), CHICAGO_0800), { allowed: true, reason: null });
});

test("transactional allowed without marketing consent", () => {
  assert.deepEqual(checkSms(transactional(), CHICAGO_2100), { allowed: true, reason: null });
});

test("marketing blocked without consent", () => {
  const r = checkSms(marketing({ marketingConsent: false }), CHICAGO_0800);
  assert.deepEqual(r, { allowed: false, reason: "marketing_consent_missing" });
});

test("non-boolean consent fails closed", () => {
  const r = checkSms(marketing({ marketingConsent: "yes" }), CHICAGO_0800);
  assert.equal(r.reason, "marketing_consent_missing");
});

test("opted-out customer blocked for marketing", () => {
  const r = checkSms(marketing({ optedOutAt: "2026-10-01T10:00:00Z" }), CHICAGO_0800);
  assert.deepEqual(r, { allowed: false, reason: "opted_out" });
});

test("opted-out customer blocked for transactional too", () => {
  const r = checkSms(transactional({ optedOutAt: "2026-10-01T10:00:00Z" }), CHICAGO_0800);
  assert.deepEqual(r, { allowed: false, reason: "opted_out" });
});

test("malformed opt-out timestamp fails closed", () => {
  const r = checkSms(marketing({ optedOutAt: "not a date" }), CHICAGO_0800);
  assert.equal(r.reason, "invalid_opt_out_timestamp");
  const missing = marketing();
  delete missing.to.optedOutAt;
  assert.equal(checkSms(missing, CHICAGO_0800).reason, "invalid_opt_out_timestamp");
});

test("marketing without STOP language blocked", () => {
  const m = marketing({});
  m.body = "Back in stock!";
  assert.equal(checkSms(m, CHICAGO_0800).reason, "missing_opt_out_language");
});

test("quiet hours: 07:59 blocked, 08:00 allowed", () => {
  assert.equal(checkSms(marketing(), CHICAGO_0759).reason, "quiet_hours");
  assert.equal(checkSms(marketing(), CHICAGO_0800).allowed, true);
});

test("quiet hours: 20:59 allowed, 21:00 blocked", () => {
  assert.equal(checkSms(marketing(), CHICAGO_2059).allowed, true);
  assert.equal(checkSms(marketing(), CHICAGO_2100).reason, "quiet_hours");
});

test("quiet hours use the customer's zone, not the server's", () => {
  // 13:00Z is 08:00 in Chicago but 06:00 in Los Angeles.
  const chicago = marketing({ timeZone: "America/Chicago" });
  const la = marketing({ timeZone: "America/Los_Angeles" });
  assert.equal(checkSms(chicago, CHICAGO_0800).allowed, true);
  assert.equal(checkSms(la, CHICAGO_0800).reason, "quiet_hours");
});

test("quiet hours do not apply to transactional texts", () => {
  assert.equal(checkSms(transactional(), CHICAGO_0759).allowed, true);
});

test("invalid IANA zone blocked for marketing", () => {
  const r = checkSms(marketing({ timeZone: "Mars/Olympus" }), CHICAGO_0800);
  assert.equal(r.reason, "invalid_time_zone");
});

test("missing zone does not fall back to the server zone", () => {
  const m = marketing();
  delete m.to.timeZone;
  assert.equal(checkSms(m, CHICAGO_0800).reason, "invalid_time_zone");
});

test("invalid phone numbers blocked", () => {
  for (const phone of ["3125550142", "+4413125550142", "+12125550142x", "+11125550142", "+1312555014"]) {
    const r = checkSms(transactional({ phone }), CHICAGO_0800);
    assert.equal(r.reason, "invalid_phone_number", phone);
  }
});

test("empty body blocked", () => {
  const t = transactional();
  t.body = "   ";
  assert.equal(checkSms(t, CHICAGO_0800).reason, "empty_body");
});

test("unknown kind blocked", () => {
  const m = marketing();
  m.kind = "promo";
  assert.equal(checkSms(m, CHICAGO_0800).reason, "unknown_message_kind");
});

test("invalid now blocked", () => {
  assert.equal(checkSms(marketing(), new Date("nope")).reason, "invalid_now");
  assert.equal(checkSms(marketing(), "2026-10-22").reason, "invalid_now");
});

test("every block code is distinct", () => {
  const codes = new Set([
    checkSms(transactional({ phone: "bad" }), CHICAGO_0800).reason,
    checkSms(marketing({ marketingConsent: false }), CHICAGO_0800).reason,
    checkSms(marketing({ optedOutAt: "2026-10-01T00:00:00Z" }), CHICAGO_0800).reason,
    checkSms(marketing({ timeZone: "Nope/Nope" }), CHICAGO_0800).reason,
    checkSms(marketing(), CHICAGO_0759).reason,
  ]);
  assert.equal(codes.size, 5);
});
