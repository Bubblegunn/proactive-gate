import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./bot.mjs";

// Oct 23 2026 is still EDT (UTC-4) in New York; Tokyo is UTC+9 with no DST.
const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

function cand(overrides) {
  return {
    userId: "u-default",
    category: "marketing",
    timezone: NY,
    quietStart: "22:00",
    quietEnd: "07:30",
    ...overrides,
  };
}

test("transactional passes during quiet hours and does not use up the cap", () => {
  const userId = "u-tx-quiet";
  const night = new Date("2026-10-24T03:30:00Z"); // 23:30 NY
  assert.deepEqual(decide(cand({ userId, category: "transactional" }), night), { send: true, rule: null });
  for (let i = 0; i < 3; i++) {
    const at = new Date(Date.parse("2026-10-23T14:00:00Z") + i * 60_000); // 10:00 NY
    assert.deepEqual(decide(cand({ userId }), at), { send: true, rule: null });
  }
});

test("transactional is never capped", () => {
  const userId = "u-tx-cap";
  const noon = new Date("2026-10-23T16:00:00Z");
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(decide(cand({ userId, category: "transactional" }), noon), { send: true, rule: null });
  }
});

test("marketing inside a midnight-crossing window is held as quiet-hours", () => {
  const userId = "u-q-cross";
  assert.deepEqual(decide(cand({ userId }), new Date("2026-10-24T03:30:00Z")), { send: false, rule: "quiet-hours" }); // 23:30 NY
  assert.deepEqual(decide(cand({ userId }), new Date("2026-10-23T09:00:00Z")), { send: false, rule: "quiet-hours" }); // 05:00 NY
});

test("quiet window end is exclusive and start is inclusive", () => {
  const userId = "u-q-edges";
  assert.deepEqual(decide(cand({ userId }), new Date("2026-10-23T02:00:00Z")), { send: false, rule: "quiet-hours" }); // 22:00 NY, start
  assert.deepEqual(decide(cand({ userId }), new Date("2026-10-23T11:29:00Z")), { send: false, rule: "quiet-hours" }); // 07:29 NY
  assert.deepEqual(decide(cand({ userId }), new Date("2026-10-23T11:30:00Z")), { send: true, rule: null });          // 07:30 NY, end
});

test("non-crossing quiet window", () => {
  const userId = "u-q-day";
  const c = cand({ userId, quietStart: "13:00", quietEnd: "14:00" });
  assert.deepEqual(decide(c, new Date("2026-10-23T17:30:00Z")), { send: false, rule: "quiet-hours" }); // 13:30 NY
  assert.deepEqual(decide(c, new Date("2026-10-23T18:00:00Z")), { send: true, rule: null });          // 14:00 NY
});

test("quiet window is evaluated in the customer's time zone, not UTC", () => {
  // 20:30 UTC on Oct 22 = 05:30 on Oct 23 in Tokyo, inside 22:00-07:30 there
  const at = new Date("2026-10-22T20:30:00Z");
  assert.deepEqual(decide(cand({ userId: "u-tz-tokyo", timezone: TOKYO }), at), { send: false, rule: "quiet-hours" });
  // The same instant is 16:30 in New York, outside the window
  assert.deepEqual(decide(cand({ userId: "u-tz-ny" }), at), { send: true, rule: null });
});

test("equal start and end means no quiet window", () => {
  const c = cand({ userId: "u-q-none", quietStart: "00:00", quietEnd: "00:00" });
  assert.deepEqual(decide(c, new Date("2026-10-23T14:00:00Z")), { send: true, rule: null });
});

test("cap: 3 marketing sends per customer-local day, 4th is daily-cap", () => {
  const userId = "u-cap-basic";
  const c = cand({ userId });
  const base = Date.parse("2026-10-23T14:00:00Z"); // 10:00 NY
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(decide(c, new Date(base + i * 60_000)), { send: true, rule: null });
  }
  assert.deepEqual(decide(c, new Date(base + 3 * 60_000)), { send: false, rule: "daily-cap" });
});

test("cap resets on the customer's next local day", () => {
  const userId = "u-cap-reset";
  const c = cand({ userId });
  for (let i = 0; i < 3; i++) {
    decide(c, new Date(Date.parse("2026-10-23T14:00:00Z") + i * 60_000));
  }
  assert.equal(decide(c, new Date("2026-10-23T23:00:00Z")).rule, "daily-cap"); // 19:00 NY Oct 23
  // 2026-10-24T14:00Z = 10:00 NY Oct 24, a new local day outside quiet hours
  assert.deepEqual(decide(c, new Date("2026-10-24T14:00:00Z")), { send: true, rule: null });
});

test("blocked pushes do not count toward the cap", () => {
  const userId = "u-cap-blocked";
  const c = cand({ userId });
  // 3 quiet-hour blocks at 23:00 NY, then 3 real sends at 10:00 NY must all pass
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(decide(c, new Date("2026-10-24T03:00:00Z")), { send: false, rule: "quiet-hours" });
  }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(decide(c, new Date(Date.parse("2026-10-23T14:00:00Z") + i * 60_000)), { send: true, rule: null });
  }
});

test("quiet-hours takes precedence over daily-cap when both apply", () => {
  const userId = "u-precedence";
  const day = cand({ userId });
  for (let i = 0; i < 3; i++) {
    decide(day, new Date(Date.parse("2026-10-23T14:00:00Z") + i * 60_000));
  }
  assert.deepEqual(decide(day, new Date("2026-10-24T03:00:00Z")), { send: false, rule: "quiet-hours" });
});

test("cap is per customer", () => {
  const a = cand({ userId: "u-cap-a" });
  const b = cand({ userId: "u-cap-b" });
  const t = Date.parse("2026-10-23T14:00:00Z");
  for (let i = 0; i < 3; i++) decide(a, new Date(t + i * 60_000));
  assert.equal(decide(a, new Date(t + 5 * 60_000)).rule, "daily-cap");
  assert.deepEqual(decide(b, new Date(t + 5 * 60_000)), { send: true, rule: null });
});

test("invalid input throws instead of silently sending", () => {
  const now = new Date("2026-10-23T14:00:00Z");
  assert.throws(() => decide(cand({ userId: "u-bad-tz", timezone: "Mars/Olympus" }), now), RangeError);
  assert.throws(() => decide(cand({ userId: "u-bad-time", quietStart: "25:00" }), now), TypeError);
  assert.throws(() => decide(cand({ userId: "u-bad-cat", category: "promo" }), now), TypeError);
  assert.throws(() => decide(cand({ userId: "u-bad-now" }), new Date("nope")), TypeError);
  assert.throws(() => decide(cand({ userId: "" }), now), TypeError);
});
