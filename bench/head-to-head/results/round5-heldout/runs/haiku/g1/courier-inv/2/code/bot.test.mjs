import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSms } from "./bot.mjs";

const OPT_OUT_BODY = "Sale today: 20% off. Reply STOP to opt out.";

function msg(overrides = {}) {
  const base = {
    kind: "marketing",
    body: OPT_OUT_BODY,
    to: {
      phone: "+13125550142",
      timeZone: "America/Chicago",
      marketingConsent: true,
      optedOutAt: null,
    },
  };
  return {
    ...base,
    ...overrides,
    to: { ...base.to, ...(overrides.to ?? {}) },
  };
}

// Winter: Chicago is UTC-6 (CST). Summer: UTC-5 (CDT).
const jan = (h, m = 0, s = 0) => new Date(Date.UTC(2026, 0, 15, h + 6, m, s));
const jul = (h, m = 0, s = 0) => new Date(Date.UTC(2026, 6, 15, h + 5, m, s));

test("transactional text is allowed at 3am local with no marketing consent", () => {
  const result = checkSms(
    msg({ kind: "transactional", body: "Your code is 123456", to: { marketingConsent: false } }),
    jan(3),
  );
  assert.deepEqual(result, { allowed: true, reason: null });
});

test("transactional text is allowed even when quiet hours would block marketing", () => {
  assert.equal(checkSms(msg({ kind: "transactional", body: "Out for delivery" }), jan(23)).allowed, true);
});

test("STOP blocks transactional texts too", () => {
  const result = checkSms(
    msg({ kind: "transactional", body: "Your code is 123456", to: { optedOutAt: "2026-01-10T12:00:00Z" } }),
    jan(10),
  );
  assert.deepEqual(result, { allowed: false, reason: "opted_out" });
});

test("STOP blocks marketing texts, and it is checked before consent", () => {
  const result = checkSms(
    msg({ to: { marketingConsent: false, optedOutAt: "2026-01-10T12:00:00Z" } }),
    jan(10),
  );
  assert.deepEqual(result, { allowed: false, reason: "opted_out" });
});

test("marketing text without marketing consent is blocked", () => {
  const result = checkSms(msg({ to: { marketingConsent: false } }), jan(10));
  assert.deepEqual(result, { allowed: false, reason: "no_marketing_consent" });
});

test("marketing text without an opt-out instruction is blocked", () => {
  const result = checkSms(msg({ body: "Sale today: 20% off." }), jan(10));
  assert.deepEqual(result, { allowed: false, reason: "missing_opt_out_language" });
});

test("opt-out language check is case-insensitive", () => {
  assert.equal(checkSms(msg({ body: "Sale. reply stop to end" }), jan(10)).allowed, true);
});

test("consent is checked before opt-out language and quiet hours", () => {
  const result = checkSms(msg({ body: "Sale", to: { marketingConsent: false } }), jan(3));
  assert.equal(result.reason, "no_marketing_consent");
});

test("opt-out language is checked before quiet hours", () => {
  const result = checkSms(msg({ body: "Sale" }), jan(3));
  assert.equal(result.reason, "missing_opt_out_language");
});

test("marketing text is allowed at 08:00:00 local", () => {
  assert.equal(checkSms(msg(), jan(8)).allowed, true);
});

test("marketing text is blocked at 07:59:59 local", () => {
  assert.deepEqual(checkSms(msg(), jan(7, 59, 59)), { allowed: false, reason: "outside_quiet_hours" });
});

test("marketing text is allowed at 21:00:00 local", () => {
  assert.equal(checkSms(msg(), jan(21)).allowed, true);
});

test("marketing text is blocked at 21:00:01 local", () => {
  assert.deepEqual(checkSms(msg(), jan(21, 0, 1)), { allowed: false, reason: "outside_quiet_hours" });
});

test("quiet hours follow the customer's zone, not UTC", () => {
  const instant = new Date("2026-01-15T14:00:00Z");
  // 14:00 UTC is 08:00 in Chicago (allowed) and 23:00 in Tokyo (blocked).
  assert.equal(checkSms(msg(), instant).allowed, true);
  assert.equal(
    checkSms(msg({ to: { timeZone: "Asia/Tokyo" } }), instant).reason,
    "outside_quiet_hours",
  );
  // 03:00 UTC is 21:00:00 in Chicago on the previous day, the last allowed second.
  assert.equal(checkSms(msg(), new Date("2026-01-15T03:00:00Z")).allowed, true);
  // 03:00:01 UTC is 21:00:01 in Chicago, blocked.
  assert.equal(
    checkSms(msg(), new Date("2026-01-15T03:00:01Z")).reason,
    "outside_quiet_hours",
  );
});

test("daylight saving time shifts the local boundary", () => {
  // In July Chicago is UTC-5. 13:00 UTC is 08:00 CDT, allowed.
  assert.equal(checkSms(msg(), new Date("2026-07-15T13:00:00Z")).allowed, true);
  // 12:59:59 UTC is 07:59:59 CDT, blocked.
  assert.equal(checkSms(msg(), new Date("2026-07-15T12:59:59Z")).reason, "outside_quiet_hours");
});

test("result does not change with the server's time zone", () => {
  const original = process.env.TZ;
  const now = new Date("2026-01-15T14:00:00Z");
  try {
    for (const tz of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      process.env.TZ = tz;
      assert.equal(checkSms(msg(), now).allowed, true, `server TZ=${tz}`);
      assert.equal(checkSms(msg(), new Date("2026-01-15T13:59:59Z")).reason, "outside_quiet_hours", `server TZ=${tz}`);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

test("each blocking rule has a different code", () => {
  const codes = [
    checkSms(msg({ to: { optedOutAt: "2026-01-10T00:00:00Z" } }), jan(10)).reason,
    checkSms(msg({ to: { marketingConsent: false } }), jan(10)).reason,
    checkSms(msg({ body: "Sale" }), jan(10)).reason,
    checkSms(msg(), jan(3)).reason,
  ];
  assert.equal(new Set(codes).size, 4);
  assert.ok(codes.every((c) => typeof c === "string"));
});

test("allowed result has reason null", () => {
  assert.equal(checkSms(msg(), jan(10)).reason, null);
});

test("invalid input throws a TypeError", () => {
  assert.throws(() => checkSms(msg({ kind: "promo" }), jan(10)), TypeError);
  assert.throws(() => checkSms(msg({ body: "" }), jan(10)), TypeError);
  assert.throws(() => checkSms(msg({ to: { timeZone: "Mars/Olympus" } }), jan(10)), TypeError);
  assert.throws(() => checkSms(msg({ to: { marketingConsent: "yes" } }), jan(10)), TypeError);
  assert.throws(() => checkSms(msg({ to: { optedOutAt: "not a date" } }), jan(10)), TypeError);
  assert.throws(() => checkSms(msg(), "2026-01-10"), TypeError);
  assert.throws(() => checkSms(msg(), new Date("nope")), TypeError);
});
