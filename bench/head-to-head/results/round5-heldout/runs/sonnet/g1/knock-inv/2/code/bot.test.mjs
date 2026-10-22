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
  body: "Shop Acme: 20% off today. Reply STOP to opt out.",
  to: to(t),
  ...o,
});
const tx = (t = {}) => mk({ kind: "transactional", body: "Your code is 445892" }, t);
const at = (iso) => new Date(iso);
// 2026-07-15 is CDT (UTC-5): 17:00Z = 12:00 local
const NOON = at("2026-07-15T17:00:00Z");

const cases = [
  ["marketing ok midday", mk(), NOON, true, null],
  ["marketing 07:59:59 local blocked", mk(), at("2026-07-15T12:59:59Z"), false, "quiet_hours"],
  ["marketing 08:00:00 local ok", mk(), at("2026-07-15T13:00:00Z"), true, null],
  ["marketing 20:59:59 local ok", mk(), at("2026-07-16T01:59:59Z"), true, null],
  ["marketing 21:00:00 local blocked", mk(), at("2026-07-16T02:00:00Z"), false, "quiet_hours"],
  ["winter CST (UTC-6): 14:00Z = 08:00 ok", mk(), at("2026-01-15T14:00:00Z"), true, null],
  ["winter CST: 13:59Z = 07:59 blocked", mk(), at("2026-01-15T13:59:00Z"), false, "quiet_hours"],
  ["midnight local blocked", mk(), at("2026-07-15T05:00:00Z"), false, "quiet_hours"],
  ["Honolulu uses its own zone", mk({}, { timeZone: "Pacific/Honolulu" }), at("2026-07-15T17:00:00Z"), false, "quiet_hours"],
  ["opted out", mk({}, { optedOutAt: "2026-07-01T10:00:00Z" }), NOON, false, "opted_out"],
  ["opted out garbage string still blocks", mk({}, { optedOutAt: "garbage" }), NOON, false, "opted_out"],
  ["opted out beats no consent", mk({}, { optedOutAt: "2026-07-01T10:00:00Z", marketingConsent: false }), NOON, false, "opted_out"],
  ["no consent", mk({}, { marketingConsent: false }), NOON, false, "no_marketing_consent"],
  ["consent truthy-not-true blocked", mk({}, { marketingConsent: "yes" }), NOON, false, "no_marketing_consent"],
  ["bad zone fails closed", mk({}, { timeZone: "Mars/Base" }), NOON, false, "invalid_time_zone"],
  ["missing STOP text", mk({ body: "20% off today!" }), NOON, false, "missing_opt_out_instructions"],
  ["transactional at 3am ok", tx(), at("2026-07-15T08:00:00Z"), true, null],
  ["transactional ok after STOP", tx({ optedOutAt: "2026-07-01T10:00:00Z" }), NOON, true, null],
  ["transactional ok without consent", tx({ marketingConsent: false }), NOON, true, null],
  ["transactional bad zone ok", tx({ timeZone: "nope" }), NOON, true, null],
  ["bad kind", mk({ kind: "promo" }), NOON, false, "invalid_kind"],
  ["bad phone", mk({}, { phone: "3125550142" }), NOON, false, "invalid_phone"],
  ["non-US phone", tx({ phone: "+442071838750" }), NOON, false, "invalid_phone"],
  ["empty body", tx() && mk({ kind: "transactional", body: " " }), NOON, false, "empty_body"],
  ["invalid date", mk(), new Date("x"), false, "invalid_input"],
  ["null message", null, NOON, false, "invalid_input"],
];

for (const [name, msg, now, allowed, reason] of cases) {
  test(name, () => assert.deepEqual(checkSms(msg, now), { allowed, reason }));
}

test("server TZ does not matter", () => {
  const r = checkSms(mk(), at("2026-07-15T13:00:00Z"));
  assert.equal(r.allowed, true);
});
