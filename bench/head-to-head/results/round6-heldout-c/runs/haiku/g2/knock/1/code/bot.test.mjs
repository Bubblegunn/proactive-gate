import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./bot.mjs";

const IST = "Europe/Istanbul"; // UTC+3, no DST
const NY = "America/New_York";

const mkt = (userId, extra = {}) => ({
  userId,
  category: "marketing",
  timezone: IST,
  quietStart: "02:00",
  quietEnd: "03:00",
  ...extra,
});
const tx = (userId, extra = {}) => ({ ...mkt(userId), category: "transactional", ...extra });

test("transactional always sends, even in quiet hours and over the cap", () => {
  const u = "tx-user";
  const t = new Date("2026-10-23T23:30:00Z"); // 02:30 IST, inside the 02:00-03:00 window
  const allDay = { ...tx(u), quietStart: "00:00", quietEnd: "23:59" };
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(decide(allDay, t), { send: true, rule: null });
  }
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(decide(tx(u), t), { send: true, rule: null });
  }
});

test("marketing: first three send, fourth hits daily-cap, same local day", () => {
  const u = "cap-user";
  const t = new Date("2026-10-23T10:00:00Z"); // 13:00 IST
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(decide(mkt(u), t), { send: true, rule: null });
  }
  assert.deepEqual(decide(mkt(u), t), { send: false, rule: "daily-cap" });
});

test("daily cap resets on the customer's local day, not UTC", () => {
  const u = "tz-user";
  // 2026-10-23 21:30Z is 00:30 on 10-24 in Istanbul, and still 10-23 in UTC.
  const lateUtc = new Date("2026-10-23T21:30:00Z");
  for (let i = 0; i < 3; i++) decide(mkt(u), lateUtc);
  assert.equal(decide(mkt(u), lateUtc).rule, "daily-cap");
  // 2026-10-24 06:00Z is 09:00 on 10-24 in Istanbul: same local day as above.
  assert.equal(decide(mkt(u), new Date("2026-10-24T06:00:00Z")).rule, "daily-cap");
  // 2026-10-24 00:30Z is 03:30 on 10-24 in Istanbul: still same local day.
  assert.equal(decide(mkt(u), new Date("2026-10-24T00:30:00Z")).rule, "daily-cap");
  // 2026-10-24 21:30Z is 00:30 on 10-25 in Istanbul: new local day, cap resets.
  assert.deepEqual(decide(mkt(u), new Date("2026-10-24T21:30:00Z")), { send: true, rule: null });
});

test("quiet window wrapping midnight blocks marketing in local time", () => {
  const u = "quiet-user";
  const q = { ...mkt(u), quietStart: "22:00", quietEnd: "07:30" };
  // 23:00 IST
  assert.deepEqual(decide(q, new Date("2026-10-23T20:00:00Z")), { send: false, rule: "quiet-hours" });
  // 06:00 IST
  assert.deepEqual(decide(q, new Date("2026-10-23T03:00:00Z")), { send: false, rule: "quiet-hours" });
  // 07:30 IST is the end (exclusive): allowed
  assert.deepEqual(decide(q, new Date("2026-10-23T04:30:00Z")), { send: true, rule: null });
  // 12:00 IST: allowed
  assert.deepEqual(decide(q, new Date("2026-10-23T09:00:00Z")), { send: true, rule: null });
});

test("quiet window uses customer zone, not server (UTC) clock", () => {
  const u = "ny-user";
  const q = { ...mkt(u), timezone: NY, quietStart: "22:00", quietEnd: "07:30" };
  // 2026-10-23 02:00Z = 22:00 EDT on 10-22 in New York: inside window
  assert.equal(decide(q, new Date("2026-10-23T02:00:00Z")).rule, "quiet-hours");
  // 2026-10-23 16:00Z = 12:00 EDT: outside window
  assert.deepEqual(decide(q, new Date("2026-10-23T16:00:00Z")), { send: true, rule: null });
});

test("quiet-hours block does not consume the daily cap", () => {
  const u = "noconsume-user";
  const night = new Date("2026-10-23T23:30:00Z"); // 02:30 IST, inside 02:00-03:00
  const day = new Date("2026-10-23T10:00:00Z");   // 13:00 IST
  for (let i = 0; i < 5; i++) {
    assert.equal(decide(mkt(u), night).rule, "quiet-hours");
  }
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(decide(mkt(u), day), { send: true, rule: null });
  }
  assert.equal(decide(mkt(u), day).rule, "daily-cap");
});

test("cap is per customer", () => {
  const t = new Date("2026-10-23T10:00:00Z");
  for (let i = 0; i < 3; i++) decide(mkt("a-user"), t);
  assert.equal(decide(mkt("a-user"), t).rule, "daily-cap");
  assert.deepEqual(decide(mkt("b-user"), t), { send: true, rule: null });
});

test("invalid input throws", () => {
  const t = new Date("2026-10-23T10:00:00Z");
  assert.throws(() => decide({ ...mkt("x"), category: "promo" }, t), TypeError);
  assert.throws(() => decide({ ...mkt("x"), quietStart: "24:00" }, t), TypeError);
  assert.throws(() => decide(mkt("x"), new Date("nope")), TypeError);
  assert.throws(() => decide({ ...mkt("x"), timezone: "Not/AZone" }, t), RangeError);
});
