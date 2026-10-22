import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const CHICAGO = "America/Chicago";
const STOP_BODY = "Sale today! Reply STOP to opt out.";
const PLAIN_BODY = "Sale today!";

// 2026-10-22 is in CDT (UTC-5) in Chicago.
const at = (iso) => new Date(iso);
const chicagoLocal = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  // Chicago is UTC-5 on this date.
  return at(`2026-10-22T${String((h + 5) % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
};

const customer = (overrides = {}) => ({
  phone: "+13125550142",
  timeZone: CHICAGO,
  marketingConsent: true,
  optedOutAt: null,
  ...overrides,
});

const marketing = (body = STOP_BODY, to = customer()) => ({ kind: "marketing", body, to });
const transactional = (body = "Your login code is 123456", to = customer()) => ({ kind: "transactional", body, to });

test("transactional text goes out at any hour without consent", () => {
  const to = customer({ marketingConsent: false });
  assert.deepEqual(checkSms(transactional(undefined, to), chicagoLocal("03:00")), { allowed: true, reason: null });
  assert.deepEqual(checkSms(transactional(undefined, to), chicagoLocal("23:30")), { allowed: true, reason: null });
});

test("marketing text allowed inside 08:00-20:59 local with consent and STOP", () => {
  assert.deepEqual(checkSms(marketing(), chicagoLocal("10:00")), { allowed: true, reason: null });
  assert.deepEqual(checkSms(marketing(), chicagoLocal("08:00")), { allowed: true, reason: null });
  assert.deepEqual(checkSms(marketing(), chicagoLocal("20:59")), { allowed: true, reason: null });
});

test("marketing quiet hours: before 08:00 and at/after 21:00 local", () => {
  assert.deepEqual(checkSms(marketing(), chicagoLocal("07:59")), { allowed: false, reason: "quiet_hours" });
  assert.deepEqual(checkSms(marketing(), chicagoLocal("03:00")), { allowed: false, reason: "quiet_hours" });
  assert.deepEqual(checkSms(marketing(), chicagoLocal("21:00")), { allowed: false, reason: "quiet_hours" });
  assert.deepEqual(checkSms(marketing(), chicagoLocal("23:59")), { allowed: false, reason: "quiet_hours" });
});

test("quiet hours follow the customer's zone, not UTC or the server zone", () => {
  // 15:00 UTC is 10:00 in Chicago (ok) but 00:00 in Tokyo (quiet).
  const now = at("2026-10-22T15:00:00Z");
  assert.equal(checkSms(marketing(), now).allowed, true);
  assert.equal(checkSms(marketing(STOP_BODY, customer({ timeZone: "Asia/Tokyo" })), now).reason, "quiet_hours");
});

test("result does not change with the server time zone", () => {
  const original = process.env.TZ;
  const results = [];
  try {
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      results.push(checkSms(marketing(), chicagoLocal("07:59")).reason);
      results.push(checkSms(marketing(), chicagoLocal("10:00")).reason);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
  assert.deepEqual(results, ["quiet_hours", null, "quiet_hours", null, "quiet_hours", null]);
});

test("marketing needs prior consent", () => {
  assert.deepEqual(
    checkSms(marketing(STOP_BODY, customer({ marketingConsent: false })), chicagoLocal("10:00")),
    { allowed: false, reason: "no_marketing_consent" },
  );
  assert.equal(
    checkSms(marketing(STOP_BODY, customer({ marketingConsent: "yes" })), chicagoLocal("10:00")).reason,
    "no_marketing_consent",
  );
});

test("marketing text must say how to opt out", () => {
  assert.deepEqual(checkSms(marketing(PLAIN_BODY), chicagoLocal("10:00")), {
    allowed: false,
    reason: "missing_opt_out_language",
  });
});

test("STOP blocks both kinds, with code opted_out", () => {
  const to = customer({ optedOutAt: "2026-10-20T14:00:00Z" });
  assert.deepEqual(checkSms(marketing(STOP_BODY, to), chicagoLocal("10:00")), { allowed: false, reason: "opted_out" });
  assert.deepEqual(checkSms(transactional(undefined, to), chicagoLocal("10:00")), { allowed: false, reason: "opted_out" });
});

test("rule order: opted_out is reported before quiet_hours and consent", () => {
  const to = customer({ optedOutAt: "2026-10-20T14:00:00Z", marketingConsent: false });
  assert.equal(checkSms(marketing(PLAIN_BODY, to), chicagoLocal("03:00")).reason, "opted_out");
});

test("invalid inputs fail closed with distinct codes", () => {
  const now = chicagoLocal("10:00");
  assert.equal(checkSms(transactional(), new Date("nope")).reason, "invalid_now");
  assert.equal(checkSms(transactional(), "2026-10-22").reason, "invalid_now");
  assert.equal(checkSms({ ...transactional(), kind: "promo" }, now).reason, "invalid_kind");
  assert.equal(checkSms(transactional("   "), now).reason, "empty_body");
  assert.equal(checkSms({ kind: "transactional", body: "hi" }, now).reason, "invalid_recipient");
  assert.equal(checkSms(transactional(undefined, customer({ phone: "+442071234567" })), now).reason, "invalid_phone");
  assert.equal(checkSms(transactional(undefined, customer({ phone: "+11125550142" })), now).reason, "invalid_phone");
  assert.equal(checkSms(transactional(undefined, customer({ timeZone: "Mars/Olympus" })), now).reason, "invalid_time_zone");
  assert.equal(checkSms(transactional(undefined, customer({ optedOutAt: "not a date" })), now).reason, "invalid_opt_out_timestamp");
});

test("reason is null only when allowed", () => {
  const r = checkSms(marketing(), chicagoLocal("12:00"));
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});
