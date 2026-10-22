import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "./bot.mjs";

let userSeq = 0;
const newUser = () => `u-${++userSeq}`;

// Builds a candidate with the default window 22:00-07:30 Istanbul time.
const cand = (over = {}) => ({
  userId: newUser(),
  category: "marketing",
  timezone: "Europe/Istanbul",
  quietStart: "22:00",
  quietEnd: "07:30",
  ...over,
});

// Istanbul is UTC+3 with no DST, so 12:00 local is 09:00Z.
const at = (iso) => new Date(iso);

test("transactional passes during quiet hours", () => {
  const c = cand({ category: "transactional" });
  assert.deepEqual(decide(c, at("2026-10-23T22:30:00+03:00")), { send: true, rule: null });
});

test("marketing blocked in a quiet window that crosses midnight", () => {
  const u = newUser();
  assert.deepEqual(decide(cand({ userId: u }), at("2026-10-23T23:59:00+03:00")), { send: false, rule: "quiet-hours" });
  assert.deepEqual(decide(cand({ userId: u }), at("2026-10-24T00:00:00+03:00")), { send: false, rule: "quiet-hours" });
  assert.deepEqual(decide(cand({ userId: u }), at("2026-10-24T07:29:59+03:00")), { send: false, rule: "quiet-hours" });
});

test("quiet window end is exclusive and start is inclusive", () => {
  assert.equal(decide(cand(), at("2026-10-23T22:00:00+03:00")).rule, "quiet-hours");
  assert.deepEqual(decide(cand(), at("2026-10-24T07:30:00+03:00")), { send: true, rule: null });
});

test("quiet window that does not cross midnight", () => {
  const c = cand({ quietStart: "13:00", quietEnd: "14:00" });
  assert.equal(decide(c, at("2026-10-23T13:30:00+03:00")).rule, "quiet-hours");
  assert.equal(decide(c, at("2026-10-23T12:59:00+03:00")).send, true);
  assert.equal(decide(c, at("2026-10-23T14:00:00+03:00")).send, true);
});

test("equal start and end means no quiet window", () => {
  const c = cand({ quietStart: "09:00", quietEnd: "09:00" });
  assert.deepEqual(decide(c, at("2026-10-23T09:00:00+03:00")), { send: true, rule: null });
});

test("uses the customer's zone, not the server's UTC clock", () => {
  // 23:00 Istanbul is 20:00Z. The UTC hour 20 is not in the window; local 23:00 is.
  const c = cand();
  assert.equal(decide(c, at("2026-10-23T20:00:00Z")).rule, "quiet-hours");
  // 09:00Z is 05:00 in New York, which is inside that customer's 22:00-07:30 window.
  const ny = cand({ timezone: "America/New_York", quietStart: "22:00", quietEnd: "07:30" });
  assert.equal(decide(ny, at("2026-10-23T09:00:00Z")).rule, "quiet-hours");
});

test("daily cap: 3 marketing sends per local day, 4th blocked", () => {
  const u = newUser();
  const c = cand({ userId: u, quietStart: "00:00", quietEnd: "00:00" });
  const t = at("2026-10-23T12:00:00+03:00");
  assert.deepEqual(decide(c, t), { send: true, rule: null });
  assert.deepEqual(decide(c, t), { send: true, rule: null });
  assert.deepEqual(decide(c, t), { send: true, rule: null });
  assert.deepEqual(decide(c, t), { send: false, rule: "daily-cap" });
});

test("daily cap resets on the customer's local day", () => {
  const u = newUser();
  const c = cand({ userId: u, quietStart: "00:00", quietEnd: "00:00" });
  for (let i = 0; i < 3; i++) decide(c, at("2026-10-23T23:00:00+03:00"));
  assert.equal(decide(c, at("2026-10-23T23:59:00+03:00")).rule, "daily-cap");
  assert.deepEqual(decide(c, at("2026-10-24T00:01:00+03:00")), { send: true, rule: null });
});

test("local day comes from the candidate's zone: same instant, different day", () => {
  const u = newUser();
  const ist = cand({ userId: u, timezone: "Europe/Istanbul", quietStart: "00:00", quietEnd: "00:00" });
  const la = cand({ userId: u, timezone: "America/Los_Angeles", quietStart: "00:00", quietEnd: "00:00" });
  // 2026-10-23T22:00Z: Istanbul is 2026-10-24 01:00, Los Angeles is 2026-10-23 15:00.
  const t = at("2026-10-23T22:00:00Z");
  for (let i = 0; i < 3; i++) assert.equal(decide(ist, t).send, true);
  assert.equal(decide(ist, t).rule, "daily-cap");
  // The LA call is on local day 10-23, which has no sends yet, so it passes.
  assert.deepEqual(decide(la, t), { send: true, rule: null });
});

test("transactional does not count toward the marketing cap", () => {
  const u = newUser();
  const t = at("2026-10-23T12:00:00+03:00");
  const tx = cand({ userId: u, category: "transactional" });
  const mk = cand({ userId: u, quietStart: "00:00", quietEnd: "00:00" });
  for (let i = 0; i < 10; i++) assert.equal(decide(tx, t).send, true);
  for (let i = 0; i < 3; i++) assert.equal(decide(mk, t).send, true);
  assert.equal(decide(mk, t).rule, "daily-cap");
});

test("blocked marketing does not consume the cap", () => {
  const u = newUser();
  const c = cand({ userId: u });
  for (let i = 0; i < 5; i++) assert.equal(decide(c, at("2026-10-23T23:00:00+03:00")).rule, "quiet-hours");
  const day = cand({ userId: u, quietStart: "00:00", quietEnd: "00:00" });
  for (let i = 0; i < 3; i++) assert.equal(decide(day, at("2026-10-23T12:00:00+03:00")).send, true);
});

test("quiet hours reported before daily cap when both apply", () => {
  const u = newUser();
  const day = cand({ userId: u, quietStart: "00:00", quietEnd: "00:00" });
  for (let i = 0; i < 3; i++) decide(day, at("2026-10-23T12:00:00+03:00"));
  const night = cand({ userId: u });
  assert.equal(decide(night, at("2026-10-23T23:00:00+03:00")).rule, "quiet-hours");
});

test("rejects malformed input instead of guessing", () => {
  const now = at("2026-10-23T12:00:00+03:00");
  assert.throws(() => decide(cand({ category: "promo" }), now), TypeError);
  assert.throws(() => decide(cand({ quietStart: "24:00" }), now), TypeError);
  assert.throws(() => decide(cand({ quietEnd: "7:30" }), now), TypeError);
  assert.throws(() => decide(cand({ userId: "" }), now), TypeError);
  assert.throws(() => decide(cand(), new Date("nope")), TypeError);
  assert.throws(() => decide(cand({ timezone: "Mars/Olympus" }), now), RangeError);
});
