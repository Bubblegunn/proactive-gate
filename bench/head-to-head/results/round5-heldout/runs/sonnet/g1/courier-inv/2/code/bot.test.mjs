import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const to = (o = {}) => ({
  phone: "+13125550142",
  timeZone: "America/Chicago",
  marketingConsent: true,
  optedOutAt: null,
  ...o,
});
const m = (kind, o = {}, body = "Acme: 20% off today. Reply STOP to opt out.") => ({ kind, body, to: to(o) });
const r = (allowed, reason) => ({ allowed, reason });

// 17:00Z Jan = 11:00 CST (UTC-6); 17:00Z Jul = 12:00 CDT (UTC-5)
const noon = new Date("2026-01-15T17:00:00Z");
assert.deepEqual(checkSms(m("marketing"), noon), r(true, null));
assert.deepEqual(checkSms(m("marketing", { marketingConsent: false }), noon), r(false, "marketing_consent_missing"));
assert.deepEqual(checkSms(m("marketing", { marketingConsent: undefined }), noon), r(false, "marketing_consent_missing"));
assert.deepEqual(checkSms(m("marketing", { optedOutAt: "2026-01-01T00:00:00Z" }), noon), r(false, "marketing_opted_out"));
assert.deepEqual(checkSms(m("marketing", {}, "Acme: sale now!"), noon), r(false, "marketing_missing_opt_out"));

// Quiet-hour edges in Chicago (CST): 08:00 local = 14:00Z, 21:00 local = 03:00Z next day
assert.equal(checkSms(m("marketing"), new Date("2026-01-15T13:59:00Z")).reason, "marketing_quiet_hours");
assert.equal(checkSms(m("marketing"), new Date("2026-01-15T14:00:00Z")).allowed, true);
assert.equal(checkSms(m("marketing"), new Date("2026-01-16T02:59:00Z")).allowed, true);
assert.equal(checkSms(m("marketing"), new Date("2026-01-16T03:00:00Z")).reason, "marketing_quiet_hours");
// DST: 13:30Z in July = 08:30 CDT allowed; same instant in January = 07:30 CST blocked
assert.equal(checkSms(m("marketing"), new Date("2026-07-15T13:30:00Z")).allowed, true);
assert.equal(checkSms(m("marketing"), new Date("2026-01-15T13:30:00Z")).allowed, false);
// Other zones: same instant, 17:00Z is 09:00 in Los Angeles, 02:00 in Tokyo
assert.equal(checkSms(m("marketing", { timeZone: "America/Los_Angeles" }), noon).allowed, true);
assert.equal(checkSms(m("marketing", { timeZone: "Asia/Tokyo" }), noon).reason, "marketing_quiet_hours");
assert.equal(checkSms(m("marketing", { timeZone: "Nope/Zone" }), noon).reason, "invalid_time_zone");

// Transactional: no consent, no quiet hours, no marketing opt-out, no STOP text needed
const night = new Date("2026-01-16T08:00:00Z"); // 02:00 Chicago
const tx = { kind: "transactional", body: "Acme: your code is 123456", to: to({ marketingConsent: false, optedOutAt: "2026-01-01T00:00:00Z" }) };
assert.deepEqual(checkSms(tx, night), r(true, null));

// Validation
assert.equal(checkSms({ ...tx, kind: "promo" }, noon).reason, "invalid_kind");
assert.equal(checkSms({ ...tx, body: "  " }, noon).reason, "empty_body");
assert.equal(checkSms({ ...tx, to: to({ phone: "3125550142" }) }, noon).reason, "invalid_phone");
assert.equal(checkSms(tx, new Date("x")).reason, "invalid_now");
assert.equal(checkSms(null, noon).reason, "invalid_message");

console.log("all checks passed");
