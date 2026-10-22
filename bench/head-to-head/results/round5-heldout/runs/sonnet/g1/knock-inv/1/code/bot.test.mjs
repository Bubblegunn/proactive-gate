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
const mk = (o = {}, body = "Sale today! Reply STOP to opt out") => ({ kind: "marketing", body, to: to(o) });
const tx = (o = {}) => ({ kind: "transactional", body: "Your code is 123456", to: to(o) });
// Chicago is UTC-5 in summer (CDT), UTC-6 in winter (CST).
const utc = (s) => new Date(s);

const cases = [
  ["marketing ok midday", mk(), "2026-07-01T17:00:00Z", true, null],
  ["marketing 08:00 local allowed", mk(), "2026-07-01T13:00:00Z", true, null],
  ["marketing 07:59:59 local blocked", mk(), "2026-07-01T12:59:59Z", false, "quiet_hours"],
  ["marketing 20:59:59 local allowed", mk(), "2026-07-02T01:59:59Z", true, null],
  ["marketing 21:00 local blocked", mk(), "2026-07-02T02:00:00Z", false, "quiet_hours"],
  ["winter offset (CST)", mk(), "2026-01-15T14:00:00Z", true, null],
  ["winter 07:30 local blocked", mk(), "2026-01-15T13:30:00Z", false, "quiet_hours"],
  ["Honolulu: 19:00 UTC is 09:00 local", mk({ timeZone: "Pacific/Honolulu" }), "2026-07-01T19:00:00Z", true, null],
  ["Honolulu: 17:00 UTC is 07:00 local", mk({ timeZone: "Pacific/Honolulu" }), "2026-07-01T17:00:00Z", false, "quiet_hours"],
  ["no consent", mk({ marketingConsent: false }), "2026-07-01T17:00:00Z", false, "no_marketing_consent"],
  ["consent as string not true", mk({ marketingConsent: "true" }), "2026-07-01T17:00:00Z", false, "no_marketing_consent"],
  ["opted out", mk({ optedOutAt: "2026-06-01T00:00:00Z" }), "2026-07-01T17:00:00Z", false, "opted_out"],
  ["opt-out in the future not yet in effect", mk({ optedOutAt: "2026-08-01T00:00:00Z" }), "2026-07-01T17:00:00Z", true, null],
  ["garbage optedOutAt blocks", mk({ optedOutAt: "STOP" }), "2026-07-01T17:00:00Z", false, "opted_out"],
  ["bad time zone", mk({ timeZone: "Mars/Base" }), "2026-07-01T17:00:00Z", false, "invalid_time_zone"],
  ["missing time zone", mk({ timeZone: undefined }), "2026-07-01T17:00:00Z", false, "invalid_time_zone"],
  ["no opt-out wording", mk({}, "Sale today!"), "2026-07-01T17:00:00Z", false, "missing_opt_out_notice"],
  ["bad phone", mk({ phone: "3125550142" }), "2026-07-01T17:00:00Z", false, "invalid_phone"],
  ["empty body", mk({}, "  "), "2026-07-01T17:00:00Z", false, "empty_body"],
  ["unknown kind", { ...mk(), kind: "promo" }, "2026-07-01T17:00:00Z", false, "invalid_kind"],
  ["transactional at 3am local ok", tx(), "2026-07-01T08:00:00Z", true, null],
  ["transactional without consent ok", tx({ marketingConsent: false }), "2026-07-01T17:00:00Z", true, null],
  ["transactional after STOP ok", tx({ optedOutAt: "2026-06-01T00:00:00Z" }), "2026-07-01T17:00:00Z", true, null],
  ["transactional bad time zone ok", tx({ timeZone: "nope" }), "2026-07-01T17:00:00Z", true, null],
  ["transactional bad phone blocked", tx({ phone: "+4420" }), "2026-07-01T17:00:00Z", false, "invalid_phone"],
];

for (const [name, msg, at, allowed, reason] of cases) {
  test(name, () => assert.deepEqual(checkSms(msg, utc(at)), { allowed, reason }));
}

test("server time zone does not matter", () => {
  const msg = mk();
  const at = utc("2026-07-02T02:00:00Z");
  const saved = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Tokyo", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      assert.deepEqual(checkSms(msg, at), { allowed: false, reason: "quiet_hours" });
    }
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

test("invalid now throws", () => assert.throws(() => checkSms(mk(), new Date("x")), TypeError));
