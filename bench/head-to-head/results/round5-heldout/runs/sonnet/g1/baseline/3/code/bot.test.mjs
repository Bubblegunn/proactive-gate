import test from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const msg = (kind, to = {}) => ({
  kind,
  body: "Hello",
  to: {
    phone: "+13125550142",
    timeZone: "America/Chicago",
    marketingConsent: true,
    optedOutAt: null,
    ...to,
  },
});
const at = (iso) => new Date(iso);
const r = (reason) => ({ allowed: false, reason });

test("marketing allowed midday Chicago (CDT = UTC-5)", () => {
  assert.deepEqual(checkSms(msg("marketing"), at("2026-07-01T17:00:00Z")), { allowed: true, reason: null });
});
test("quiet hours use customer zone, not UTC", () => {
  // 02:00Z = 21:00 CDT previous day -> blocked, though 02:00 UTC is also blocked; use a split case:
  assert.deepEqual(checkSms(msg("marketing"), at("2026-07-01T13:00:00Z")), { allowed: true, reason: null }); // 08:00 CDT
  assert.deepEqual(checkSms(msg("marketing"), at("2026-07-01T12:59:59Z")), r("quiet_hours")); // 07:59 CDT
  assert.deepEqual(checkSms(msg("marketing"), at("2026-07-02T01:59:59Z")), { allowed: true, reason: null }); // 20:59 CDT
  assert.deepEqual(checkSms(msg("marketing"), at("2026-07-02T02:00:00Z")), r("quiet_hours")); // 21:00 CDT
  // 15:00Z is daytime UTC but 05:00 in Honolulu
  assert.deepEqual(checkSms(msg("marketing", { timeZone: "Pacific/Honolulu" }), at("2026-07-01T15:00:00Z")), r("quiet_hours"));
});
test("DST: winter Chicago is UTC-6", () => {
  assert.deepEqual(checkSms(msg("marketing"), at("2026-01-15T13:00:00Z")), r("quiet_hours")); // 07:00 CST
  assert.deepEqual(checkSms(msg("marketing"), at("2026-01-15T14:00:00Z")), { allowed: true, reason: null });
});
test("opt-out and consent", () => {
  assert.deepEqual(checkSms(msg("marketing", { optedOutAt: "2026-06-01T10:00:00Z" }), at("2026-07-01T17:00:00Z")), r("opted_out"));
  assert.deepEqual(checkSms(msg("marketing", { marketingConsent: false }), at("2026-07-01T17:00:00Z")), r("no_marketing_consent"));
  assert.deepEqual(checkSms(msg("marketing", { optedOutAt: "garbage" }), at("2026-07-01T17:00:00Z")), r("invalid_opt_out_date"));
  assert.deepEqual(checkSms(msg("marketing", { timeZone: "Nope/Zone" }), at("2026-07-01T17:00:00Z")), r("invalid_time_zone"));
});
test("transactional ignores consent, quiet hours, opt-out", () => {
  const t = msg("transactional", { marketingConsent: false, optedOutAt: "2026-06-01T10:00:00Z" });
  assert.deepEqual(checkSms(t, at("2026-07-01T08:00:00Z")), { allowed: true, reason: null });
});
test("validation", () => {
  assert.deepEqual(checkSms(msg("transactional", { phone: "3125550142" }), new Date()), r("invalid_phone"));
  assert.deepEqual(checkSms({ ...msg("marketing"), kind: "x" }, new Date()), r("invalid_kind"));
  assert.deepEqual(checkSms({ ...msg("transactional"), body: " " }, new Date()), r("empty_body"));
  assert.deepEqual(checkSms(msg("transactional"), new Date("x")), r("invalid_now"));
});
