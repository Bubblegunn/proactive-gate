import test from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const to = (o = {}) => ({ phone: "+13125550142", timeZone: "America/Chicago", marketingConsent: true, optedOutAt: null, ...o });
const mk = (o = {}, kind = "marketing") => ({ kind, body: "Sale today", to: to(o) });
const at = (s) => new Date(s);
const r = (m, d) => checkSms(m, at(d)).reason;

test("marketing window, Chicago DST (CDT = UTC-5)", () => {
  assert.equal(r(mk(), "2026-10-22T12:59:59Z"), "outside_permitted_hours"); // 07:59:59
  assert.equal(r(mk(), "2026-10-22T13:00:00Z"), null);                      // 08:00
  assert.equal(r(mk(), "2026-10-23T01:59:59Z"), null);                      // 20:59:59
  assert.equal(r(mk(), "2026-10-23T02:00:00Z"), "outside_permitted_hours"); // 21:00
});
test("marketing window, Chicago standard time (CST = UTC-6)", () => {
  assert.equal(r(mk(), "2026-12-15T13:59:59Z"), "outside_permitted_hours");
  assert.equal(r(mk(), "2026-12-15T14:00:00Z"), null);
});
test("other zones", () => {
  assert.equal(r(mk({ timeZone: "America/Los_Angeles" }), "2026-10-22T15:00:00Z"), null); // 08:00 PDT
  assert.equal(r(mk({ timeZone: "America/Los_Angeles" }), "2026-10-22T14:00:00Z"), "outside_permitted_hours");
  assert.equal(r(mk({ timeZone: "America/New_York" }), "2026-10-22T12:00:00Z"), null);   // 08:00 EDT
  assert.equal(r(mk({ timeZone: "Pacific/Honolulu" }), "2026-10-22T18:00:00Z"), null);   // 08:00 HST
});
test("opt-out and consent", () => {
  const d = "2026-10-22T18:00:00Z";
  assert.equal(r(mk({ optedOutAt: "2026-10-01T10:00:00Z" }), d), "opted_out");
  assert.equal(r(mk({ optedOutAt: "2026-12-01T10:00:00Z" }), d), "opted_out");
  assert.equal(r(mk({ optedOutAt: "garbage" }), d), "opted_out");
  assert.equal(r(mk({ marketingConsent: false }), d), "no_marketing_consent");
  assert.equal(r(mk({ marketingConsent: "true" }), d), "no_marketing_consent");
  assert.equal(r(mk({ marketingConsent: false, optedOutAt: "2026-10-01T00:00:00Z" }), d), "opted_out");
  assert.equal(r(mk({ timeZone: "Mars/Base" }), d), "invalid_time_zone");
});
test("transactional ignores consent, opt-out, hours", () => {
  const m = mk({ marketingConsent: false, optedOutAt: "2026-10-01T00:00:00Z", timeZone: "bogus" }, "transactional");
  assert.deepEqual(checkSms(m, at("2026-10-22T08:00:00Z")), { allowed: true, reason: null });
});
test("input validation", () => {
  const d = "2026-10-22T18:00:00Z";
  assert.equal(r(mk({ phone: "3125550142" }), d), "invalid_phone_number");
  assert.equal(r(mk({ phone: "+11125550142" }), d), "invalid_phone_number");
  assert.equal(r({ ...mk(), kind: "promo" }, d), "invalid_kind");
  assert.equal(r({ ...mk(), body: "  " }, d), "empty_body");
  assert.equal(r(null, d), "invalid_input");
  assert.equal(checkSms(mk(), new Date("x")).reason, "invalid_input");
});
