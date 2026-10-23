import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

const now = new Date("2026-03-10T18:00:00Z"); // 13:00 in Chicago (CDT), 14:00 in New York... see tz below
const user = { timeZone: "America/Chicago", promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const ago = (h) => new Date(now.getTime() - h * 3600e3).toISOString();
const plan = (o) => planSends({ user, candidates: [], history: [], now, ...o });

test("orders by priority, best first", () => {
  const r = plan({ candidates: [c("a", "promo", 1), c("b", "reminder", 5), c("c", "promo", 3)] });
  assert.deepEqual(r.send, ["b", "c", "a"]);
});

test("promo needs opt-in; reminder does not; critical does not", () => {
  const u = { ...user, promoOptIn: false };
  const r = plan({ user: u, candidates: [c("p", "promo", 9), c("r", "reminder", 1), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["r", "x"]);
  assert.deepEqual(r.dropped, [{ id: "p", rule: "promo-not-opted-in" }]);
});

test("quiet hours use the customer's zone and wrap midnight; critical bypasses", () => {
  // 18:00Z = 13:00 Chicago (CDT, -5). Window 12:00-14:00 covers it.
  let u = { ...user, quietHours: { start: "12:00", end: "14:00" } };
  let r = plan({ user: u, candidates: [c("r", "reminder", 1), c("x", "critical", 0)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(r.dropped, [{ id: "r", rule: "quiet-hours" }]);
  // Same instant is 03:00 next day in Tokyo: wrapping window 22:00-07:00 covers it.
  u = { timeZone: "Asia/Tokyo", promoOptIn: true, quietHours: { start: "22:00", end: "07:00" } };
  assert.deepEqual(plan({ user: u, candidates: [c("r", "reminder", 1)] }).dropped[0].rule, "quiet-hours");
  // End is exclusive, start inclusive.
  u = { ...user, quietHours: { start: "08:00", end: "13:00" } };
  assert.deepEqual(plan({ user: u, candidates: [c("r", "reminder", 1)] }).send, ["r"]);
  u = { ...user, quietHours: { start: "13:00", end: "14:00" } };
  assert.deepEqual(plan({ user: u, candidates: [c("r", "reminder", 1)] }).send, []);
});

test("quiet hours follow DST: same UTC clock time, different local time", () => {
  const winter = new Date("2026-01-10T18:00:00Z"); // 12:00 Chicago CST
  const u = { ...user, quietHours: { start: "12:00", end: "13:00" } };
  assert.deepEqual(planSends({ user: u, candidates: [c("r", "reminder", 1)], history: [], now: winter }).send, []);
  assert.deepEqual(planSends({ user: u, candidates: [c("r", "reminder", 1)], history: [], now }).send, ["r"]);
});

test("cap of 3 per rolling 24h counts history, not critical; keeps top priority", () => {
  const history = [
    { sentAt: ago(2), category: "promo", dedupeKey: "h1" },
    { sentAt: ago(23.9), category: "reminder", dedupeKey: "h2" },
    { sentAt: ago(24), category: "reminder", dedupeKey: "h3" }, // exactly 24h: outside
    { sentAt: ago(1), category: "critical", dedupeKey: "h4" }, // not counted
  ];
  const r = plan({
    history,
    candidates: [c("a", "promo", 1), c("b", "reminder", 5), c("c", "promo", 3), c("x", "critical", 0)],
  });
  assert.deepEqual(r.send, ["b", "x"]); // 2 counted in history (h3 is outside), 1 slot left
  assert.deepEqual(r.dropped, [
    { id: "c", rule: "daily-cap" },
    { id: "a", rule: "daily-cap" },
  ]);
});

test("dedupe: 7 day history window, boundary exact, and within the batch", () => {
  const history = [
    { sentAt: ago(24 * 7 - 1), category: "promo", dedupeKey: "k1" },
    { sentAt: ago(24 * 7), category: "promo", dedupeKey: "k2" }, // exactly 7d: allowed
  ];
  const r = plan({
    history,
    candidates: [c("a", "reminder", 1, "k1"), c("b", "reminder", 2, "k2"), c("d", "reminder", 1, "k2")],
  });
  assert.deepEqual(r.send, ["b"]);
  assert.deepEqual(r.dropped.sort((x, y) => x.id.localeCompare(y.id)), [
    { id: "a", rule: "duplicate-within-7d" },
    { id: "d", rule: "duplicate-in-batch" },
  ]);
});

test("a dropped candidate does not use up the cap or block its duplicate", () => {
  const u = { ...user, promoOptIn: false };
  const r = plan({
    user: u,
    candidates: [c("p", "promo", 9, "k"), c("r", "reminder", 1, "k")],
  });
  assert.deepEqual(r.send, ["r"]);
});

test("bad time settings fail closed for non-critical only", () => {
  const u = { ...user, timeZone: "Not/AZone", quietHours: { start: "22:00", end: "07:00" } };
  const r = plan({ user: u, candidates: [c("r", "reminder", 1), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["x"]);
  assert.equal(r.dropped[0].rule, "invalid-user-config");
});

test("every candidate is either sent or dropped once; arguments are not mutated", () => {
  const candidates = [c("a", "promo", 1), c("b", "reminder", 5), c("c", "bogus", 3), c("d", "reminder", 5)];
  const history = [{ sentAt: ago(1), category: "promo", dedupeKey: "z" }];
  const args = { user: { ...user, quietHours: { start: "01:00", end: "02:00" } }, candidates, history, now };
  const before = structuredClone({ ...args, now: undefined });
  const t = now.getTime();
  const r = planSends(args);
  assert.deepEqual(structuredClone({ ...args, now: undefined }), before);
  assert.equal(now.getTime(), t);
  assert.deepEqual([...r.send, ...r.dropped.map((d) => d.id)].sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(r.send, ["b", "d"]); // one history promo leaves 2 slots; a is capped
});
