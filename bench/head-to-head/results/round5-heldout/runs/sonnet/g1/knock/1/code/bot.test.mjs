import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const mk = (kind, to = {}, body) => ({
  kind,
  body: body ?? (kind === "marketing" ? "20% off today. Reply STOP to opt out." : "Your code is 123456"),
  to: { phone: "+13125550142", timeZone: "America/Chicago", marketingConsent: true, optedOutAt: null, ...to },
});
const t = (iso) => new Date(iso);
// 2026-07-01 is CDT (UTC-5): 15:00Z = 10:00 Chicago.
const NOON = t("2026-07-01T17:00:00Z");

const cases = [
  ["marketing ok", mk("marketing"), NOON, true, null],
  ["marketing opted out", mk("marketing", { optedOutAt: "2026-06-01T00:00:00Z" }), NOON, false, "opted_out"],
  ["marketing bad optedOutAt", mk("marketing", { optedOutAt: "garbage" }), NOON, false, "invalid_opted_out_at"],
  ["marketing no consent", mk("marketing", { marketingConsent: false }), NOON, false, "no_marketing_consent"],
  ["marketing consent string", mk("marketing", { marketingConsent: "true" }), NOON, false, "no_marketing_consent"],
  ["marketing bad zone", mk("marketing", { timeZone: "Nowhere/Land" }), NOON, false, "invalid_time_zone"],
  ["marketing no STOP", mk("marketing", {}, "20% off today"), NOON, false, "missing_opt_out_instructions"],
  // Chicago CDT = UTC-5
  ["07:59:59 local blocked", mk("marketing"), t("2026-07-01T12:59:59Z"), false, "outside_calling_hours"],
  ["08:00:00 local ok", mk("marketing"), t("2026-07-01T13:00:00Z"), true, null],
  ["20:59:59 local ok", mk("marketing"), t("2026-07-02T01:59:59Z"), true, null],
  ["21:00:00 local blocked", mk("marketing"), t("2026-07-02T02:00:00Z"), false, "outside_calling_hours"],
  // Same instant, different zones: 03:00Z = 20:00 Los Angeles (PDT) prev day, 23:00 New York.
  ["LA evening ok", mk("marketing", { timeZone: "America/Los_Angeles" }), t("2026-07-02T03:00:00Z"), true, null],
  ["NY same instant blocked", mk("marketing", { timeZone: "America/New_York" }), t("2026-07-02T03:00:00Z"), false, "outside_calling_hours"],
  // DST: winter Chicago CST = UTC-6. 14:00Z = 08:00 local.
  ["winter 08:00 ok", mk("marketing"), t("2026-01-15T14:00:00Z"), true, null],
  ["winter 07:00 blocked", mk("marketing"), t("2026-01-15T13:00:00Z"), false, "outside_calling_hours"],
  ["midnight local blocked", mk("marketing", { timeZone: "Asia/Tokyo" }), t("2026-07-01T15:00:00Z"), false, "outside_calling_hours"],
  // Transactional ignores consent, opt-out, hours.
  ["transactional at 3am", mk("transactional", { marketingConsent: false }), t("2026-07-01T08:00:00Z"), true, null],
  ["transactional after STOP", mk("transactional", { optedOutAt: "2026-06-01T00:00:00Z" }), NOON, true, null],
  ["transactional bad zone ok", mk("transactional", { timeZone: "x" }), NOON, true, null],
  // Shared checks.
  ["bad kind", mk("promo"), NOON, false, "invalid_kind"],
  ["empty body", mk("transactional", {}, "  "), NOON, false, "empty_body"],
  ["non-US number", mk("transactional", { phone: "+442071838750" }), NOON, false, "non_us_number"],
  ["bad US number", mk("transactional", { phone: "+11125550142" }), NOON, false, "invalid_phone_number"],
  ["no plus", mk("transactional", { phone: "3125550142" }), NOON, false, "invalid_phone_number"],
  ["null message", null, NOON, false, "invalid_message"],
  ["bad now", mk("marketing"), new Date("x"), false, "invalid_now"],
];

for (const [name, msg, now, allowed, reason] of cases) {
  test(name, () => {
    assert.deepEqual(checkSms(msg, now), { allowed, reason });
  });
}

test("server TZ does not matter", () => {
  const r = checkSms(mk("marketing"), t("2026-07-01T13:00:00Z"));
  assert.equal(r.allowed, true);
});
