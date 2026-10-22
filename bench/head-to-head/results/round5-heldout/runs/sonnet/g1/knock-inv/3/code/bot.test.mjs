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
  body: "Sale today! Reply STOP to opt out.",
  to: to(t),
  ...o,
});
// 2026-07-01 CDT = UTC-5. 17:00Z = 12:00 Chicago.
const noon = new Date("2026-07-01T17:00:00Z");
const r = (m, d = noon) => checkSms(m, d).reason;

test("marketing allowed midday", () => assert.deepEqual(checkSms(mk(), noon), { allowed: true, reason: null }));
test("opt-out", () => assert.equal(r(mk({}, { optedOutAt: "2026-06-01T00:00:00Z" })), "opted_out"));
test("no consent", () => assert.equal(r(mk({}, { marketingConsent: false })), "no_marketing_consent"));
test("consent must be true", () => assert.equal(r(mk({}, { marketingConsent: "yes" })), "no_marketing_consent"));
test("no STOP text", () => assert.equal(r(mk({ body: "Sale today!" })), "missing_opt_out_instructions"));
test("bad zone", () => assert.equal(r(mk({}, { timeZone: "Nope/Zone" })), "invalid_time_zone"));
test("bad phone", () => assert.equal(r(mk({}, { phone: "+442071838750" })), "invalid_phone"));
test("bad kind", () => assert.equal(r(mk({ kind: "x" })), "invalid_kind"));
test("bad now", () => assert.equal(r(mk(), new Date("x")), "invalid_now"));

test("quiet hours boundaries in local time (Chicago CDT)", () => {
  const at = (z) => r(mk(), new Date(z));
  assert.equal(at("2026-07-02T12:59:59Z"), "quiet_hours"); // 07:59:59
  assert.equal(at("2026-07-02T13:00:00Z"), null); // 08:00:00
  assert.equal(at("2026-07-02T01:59:59Z"), null); // 20:59:59
  assert.equal(at("2026-07-02T02:00:00Z"), "quiet_hours"); // 21:00:00
  assert.equal(at("2026-07-02T08:00:00Z"), "quiet_hours"); // 03:00
  assert.equal(at("2026-07-02T05:00:00Z"), "quiet_hours"); // 00:00 (h23, not 24)
});

test("zone matters: same instant, different customers", () => {
  const d = new Date("2026-07-02T03:00:00Z"); // 22:00 Chicago, 20:00 Los Angeles
  assert.equal(r(mk(), d), "quiet_hours");
  assert.equal(r(mk({}, { timeZone: "America/Los_Angeles" }), d), null);
});

test("DST: winter offset is used (CST = UTC-6)", () => {
  assert.equal(r(mk(), new Date("2026-01-15T14:00:00Z")), null); // 08:00 CST
  assert.equal(r(mk(), new Date("2026-01-15T13:59:00Z")), "quiet_hours"); // 07:59 CST
});

test("transactional ignores quiet hours, consent, opt-out", () => {
  const m = {
    kind: "transactional",
    body: "Your code is 123456",
    to: to({ marketingConsent: false, optedOutAt: "2026-06-01T00:00:00Z" }),
  };
  assert.deepEqual(checkSms(m, new Date("2026-07-02T08:00:00Z")), { allowed: true, reason: null });
});

test("transactional still needs valid phone and body", () => {
  assert.equal(r({ kind: "transactional", body: "x", to: to({ phone: "123" }) }), "invalid_phone");
  assert.equal(r({ kind: "transactional", body: " ", to: to() }), "empty_body");
});

test("server TZ does not matter", () => {
  const prev = process.env.TZ;
  process.env.TZ = "Pacific/Kiritimati";
  assert.equal(r(mk()), null);
  process.env.TZ = prev;
});
