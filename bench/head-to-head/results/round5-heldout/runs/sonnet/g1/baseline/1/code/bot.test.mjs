import test from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const to = (o = {}) => ({
  phone: "+13125550142",
  timeZone: "America/Chicago",
  marketingConsent: true,
  optedOutAt: null,
  ...o,
});
const mk = (o = {}, t = {}) => ({
  kind: "marketing",
  body: "20% off today. Reply STOP to opt out.",
  to: to(t),
  ...o,
});
const at = (s) => new Date(s);
const reason = (m, d) => checkSms(m, at(d)).reason;

test("marketing allowed midday", () => {
  assert.deepEqual(checkSms(mk(), at("2026-10-22T18:00:00Z")), { allowed: true, reason: null });
});

test("quiet hours, Chicago CDT (UTC-5)", () => {
  assert.equal(reason(mk(), "2026-10-22T12:59:59Z"), "quiet_hours"); // 07:59:59
  assert.equal(reason(mk(), "2026-10-22T13:00:00Z"), null); // 08:00:00
  assert.equal(reason(mk(), "2026-10-23T01:59:59Z"), null); // 20:59:59
  assert.equal(reason(mk(), "2026-10-23T02:00:00Z"), "quiet_hours"); // 21:00:00
});

test("quiet hours, Chicago CST (UTC-6) and other zones", () => {
  assert.equal(reason(mk(), "2026-01-15T13:59:59Z"), "quiet_hours");
  assert.equal(reason(mk(), "2026-01-15T14:00:00Z"), null);
  const la = { timeZone: "America/Los_Angeles" };
  assert.equal(reason(mk({}, la), "2026-10-22T14:59:59Z"), "quiet_hours"); // 07:59 PDT
  assert.equal(reason(mk({}, la), "2026-10-22T15:00:00Z"), null);
  const ny = { timeZone: "America/New_York" };
  assert.equal(reason(mk({}, ny), "2026-10-23T01:00:00Z"), "quiet_hours"); // 21:00 EDT
});

test("DST change days", () => {
  // 2026-03-08 spring forward in Chicago: 08:00 CDT = 13:00Z
  assert.equal(reason(mk(), "2026-03-08T12:59:59Z"), "quiet_hours");
  assert.equal(reason(mk(), "2026-03-08T13:00:00Z"), null);
});

test("opt-out", () => {
  const o = { optedOutAt: "2026-10-01T10:00:00Z" };
  assert.equal(reason(mk({}, o), "2026-10-22T18:00:00Z"), "opted_out");
  assert.equal(reason(mk({}, { optedOutAt: "2026-10-22T18:00:00Z" }), "2026-10-22T18:00:00Z"), "opted_out");
  assert.equal(reason(mk({}, { optedOutAt: "2026-11-01T00:00:00Z" }), "2026-10-22T18:00:00Z"), null);
  assert.equal(reason(mk({}, { optedOutAt: "garbage" }), "2026-10-22T18:00:00Z"), "invalid_opt_out_date");
});

test("consent", () => {
  for (const v of [false, undefined, "true", 1, null]) {
    assert.equal(reason(mk({}, { marketingConsent: v }), "2026-10-22T18:00:00Z"), "no_marketing_consent");
  }
});

test("opt-out wording", () => {
  assert.equal(reason(mk({ body: "Sale today!" }), "2026-10-22T18:00:00Z"), "missing_opt_out_instructions");
  assert.equal(reason(mk({ body: "Sale! reply stop to end" }), "2026-10-22T18:00:00Z"), null);
  assert.equal(reason(mk({ body: "Bus stopping soon" }), "2026-10-22T18:00:00Z"), "missing_opt_out_instructions");
});

test("transactional ignores consent, quiet hours, opt-out, wording", () => {
  const m = { kind: "transactional", body: "Code 123456", to: to({ marketingConsent: false, optedOutAt: "2026-01-01T00:00:00Z" }) };
  assert.deepEqual(checkSms(m, at("2026-10-22T08:00:00Z")), { allowed: true, reason: null });
});

test("bad input fails closed with distinct codes", () => {
  const d = "2026-10-22T18:00:00Z";
  assert.equal(reason(mk({ kind: "x" }), d), "invalid_kind");
  assert.equal(reason(mk({ body: " " }), d), "empty_body");
  assert.equal(reason(mk({}, { phone: "3125550142" }), d), "invalid_phone");
  assert.equal(reason(mk({}, { phone: "+442071838750" }), d), "invalid_phone");
  assert.equal(reason(mk({}, { timeZone: "Nope/Zone" }), d), "invalid_time_zone");
  assert.equal(reason(mk({ to: null }), d), "invalid_recipient");
  assert.equal(reason(null, d), "invalid_message");
  assert.equal(checkSms(mk(), new Date("x")).reason, "invalid_now");
});
