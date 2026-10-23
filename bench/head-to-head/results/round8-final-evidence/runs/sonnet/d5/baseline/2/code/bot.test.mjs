import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

// 2026-03-10T15:00:00Z = 10:00 in America/Chicago (CDT, UTC-5), 16:00 in Europe/Berlin... (CET+1 -> 16:00)
const NOW = new Date("2026-03-10T15:00:00Z");
const user = (o = {}) => ({ timeZone: "America/Chicago", promoOptIn: true, quietHours: null, ...o });
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const run = (o) => planSends({ user: user(), candidates: [], history: [], now: NOW, ...o });
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600e3).toISOString();

test("sends best first, critical ahead of higher-priority others", () => {
  const r = run({ candidates: [c("a", "reminder", 5), c("b", "reminder", 9), c("z", "critical", 1)] });
  assert.deepEqual(r.send, ["z", "b", "a"]);
  assert.deepEqual(r.dropped, []);
});

test("promo without opt-in dropped; reminder and critical unaffected", () => {
  const r = run({
    user: user({ promoOptIn: false }),
    candidates: [c("p", "promo", 9), c("r", "reminder", 1), c("x", "critical", 1)],
  });
  assert.deepEqual(r.send, ["x", "r"]);
  assert.deepEqual(r.dropped, [{ id: "p", rule: "promo-not-opted-in" }]);
});

test("quiet hours in user's zone, wrap past midnight, critical bypasses", () => {
  const q = { start: "22:00", end: "11:00" }; // 10:00 Chicago is inside; 15:00 UTC would not be
  const r = run({ user: user({ quietHours: q }), candidates: [c("r", "reminder", 1), c("p", "promo", 2), c("x", "critical", 0)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(r.dropped, [{ id: "r", rule: "quiet-hours" }, { id: "p", rule: "quiet-hours" }]);
  // Same instant, Berlin = 16:00, outside window.
  const r2 = run({ user: user({ timeZone: "Europe/Berlin", quietHours: q }), candidates: [c("r", "reminder", 1)] });
  assert.deepEqual(r2.send, ["r"]);
});

test("quiet hours boundaries: start inclusive, end exclusive; same-day window", () => {
  const at = (iso, q) => planSends({ user: user({ quietHours: q }), candidates: [c("r", "reminder", 1)], history: [], now: new Date(iso) }).send;
  assert.deepEqual(at("2026-03-10T15:00:00Z", { start: "10:00", end: "12:00" }), []); // 10:00 local
  assert.deepEqual(at("2026-03-10T17:00:00Z", { start: "10:00", end: "12:00" }), ["r"]); // 12:00 local
  assert.deepEqual(at("2026-03-10T15:00:00Z", { start: "10:00", end: "10:00" }), ["r"]); // empty window
});

test("DST: local time follows the zone rules on the actual date", () => {
  // US spring-forward 2026-03-08. 2026-03-09T03:30Z is 22:30 CDT (UTC-5) the evening of Mar 8.
  const r = planSends({
    user: user({ quietHours: { start: "22:00", end: "23:00" } }),
    candidates: [c("r", "reminder", 1)], history: [], now: new Date("2026-03-09T03:30:00Z"),
  });
  assert.deepEqual(r.dropped, [{ id: "r", rule: "quiet-hours" }]);
});

test("7-day dedupe against history, boundary exact 7d allowed", () => {
  const r = run({
    candidates: [c("a", "reminder", 1, "k1"), c("b", "reminder", 1, "k2"), c("x", "critical", 1, "k3")],
    history: [
      { sentAt: hoursAgo(167), category: "reminder", dedupeKey: "k1" },
      { sentAt: hoursAgo(168), category: "reminder", dedupeKey: "k2" },
      { sentAt: hoursAgo(1), category: "critical", dedupeKey: "k3" },
    ],
  });
  assert.deepEqual(r.send, ["b"]);
  assert.deepEqual(r.dropped, [{ id: "a", rule: "dedupe-7d" }, { id: "x", rule: "dedupe-7d" }]);
});

test("same dedupeKey twice in one batch: best one wins", () => {
  const r = run({ candidates: [c("lo", "reminder", 1, "k"), c("hi", "promo", 8, "k")] });
  assert.deepEqual(r.send, ["hi"]);
  assert.deepEqual(r.dropped, [{ id: "lo", rule: "dedupe-in-batch" }]);
});

test("cap of 3 per rolling 24h counts history; critical neither counted nor capped", () => {
  const r = run({
    candidates: [c("a", "reminder", 5), c("b", "promo", 4), c("c", "reminder", 3), c("x", "critical", 0)],
    history: [
      { sentAt: hoursAgo(2), category: "promo", dedupeKey: "h1" },
      { sentAt: hoursAgo(23.9), category: "reminder", dedupeKey: "h2" },
      { sentAt: hoursAgo(24), category: "reminder", dedupeKey: "h3" }, // outside window
      { sentAt: hoursAgo(1), category: "critical", dedupeKey: "h4" }, // not counted
    ],
  });
  assert.deepEqual(r.send, ["x", "a"]);
  assert.deepEqual(r.dropped, [{ id: "b", rule: "daily-cap" }, { id: "c", rule: "daily-cap" }]);
});

test("quiet-hours drop does not consume cap; deduped twin does not consume cap", () => {
  const r = run({
    candidates: [c("a", "reminder", 9, "k"), c("b", "reminder", 8, "k"), c("c", "reminder", 7), c("d", "reminder", 6), c("e", "reminder", 5)],
  });
  assert.deepEqual(r.send, ["a", "c", "d"]);
  assert.deepEqual(r.dropped, [{ id: "b", rule: "dedupe-in-batch" }, { id: "e", rule: "daily-cap" }]);
});

test("unknown category dropped; every candidate appears exactly once; stable ties", () => {
  const cands = [c("a", "reminder", 1), c("b", "reminder", 1), c("u", "newsletter", 9)];
  const r = run({ candidates: cands });
  assert.deepEqual(r.send, ["a", "b"]);
  assert.deepEqual(r.dropped, [{ id: "u", rule: "unknown-category" }]);
});

test("does not mutate arguments", () => {
  const args = {
    user: user({ quietHours: { start: "22:00", end: "07:00" } }),
    candidates: [c("a", "reminder", 1), c("b", "reminder", 2), c("x", "critical", 0)],
    history: [{ sentAt: hoursAgo(1), category: "promo", dedupeKey: "h" }],
    now: NOW,
  };
  const snap = structuredClone({ ...args, now: NOW.getTime() });
  Object.freeze(args.candidates); Object.freeze(args.history);
  args.candidates.forEach(Object.freeze); args.history.forEach(Object.freeze);
  planSends(args);
  assert.deepEqual(structuredClone({ ...args, now: args.now.getTime() }), snap);
});

test("bad input fails loudly", () => {
  assert.throws(() => run({ user: user({ timeZone: "Mars/Base", quietHours: { start: "22:00", end: "07:00" } }) }), RangeError);
  assert.throws(() => run({ user: user({ quietHours: { start: "25:00", end: "07:00" } }) }), TypeError);
  assert.throws(() => run({ history: [{ sentAt: "nope", category: "promo", dedupeKey: "k" }] }), TypeError);
});
