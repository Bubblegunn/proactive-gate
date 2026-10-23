import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

const base = { timeZone: "America/Chicago", promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
// 2026-07-01T15:00Z = 10:00 Chicago (CDT)
const now = new Date("2026-07-01T15:00:00Z");
const plan = (o) => planSends({ user: base, candidates: [], history: [], now, ...o });

test("orders by priority, best first", () => {
  const r = plan({ candidates: [c("a", "reminder", 1), c("b", "promo", 5), c("d", "critical", 3)] });
  assert.deepEqual(r.send, ["b", "d", "a"]);
  assert.deepEqual(r.dropped, []);
});

test("promo without opt-in is dropped, reminder is not", () => {
  const r = plan({ user: { ...base, promoOptIn: false }, candidates: [c("p", "promo", 9), c("r", "reminder", 1)] });
  assert.deepEqual(r.send, ["r"]);
  assert.deepEqual(r.dropped, [{ id: "p", rule: "promo-no-opt-in" }]);
});

test("quiet hours use the customer's zone and wrap midnight; critical bypasses", () => {
  const user = { ...base, quietHours: { start: "22:00", end: "11:00" } }; // 10:00 local is inside
  const r = plan({ user, candidates: [c("r", "reminder", 1), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(r.dropped, [{ id: "r", rule: "quiet-hours" }]);
  // Same instant is 15:00 UTC: a UTC-based check of 22:00-11:00 would not match.
  const outside = plan({ user: { ...base, quietHours: { start: "22:00", end: "10:00" } }, candidates: [c("r", "reminder", 1)] });
  assert.deepEqual(outside.send, ["r"]); // end is exclusive
});

test("quiet hours follow DST", () => {
  const winter = new Date("2026-01-15T15:00:00Z"); // 09:00 CST
  const user = { ...base, quietHours: { start: "09:30", end: "10:30" } };
  assert.deepEqual(plan({ user, now: winter, candidates: [c("r", "reminder", 1)] }).send, ["r"]);
  assert.equal(plan({ user, now, candidates: [c("r", "reminder", 1)] }).dropped[0].rule, "quiet-hours"); // 10:00 CDT
});

test("cap: 3 reminders/promos per rolling 24h, critical not counted or capped", () => {
  const h = (hoursAgo, category = "reminder", k = `h${hoursAgo}`) => ({
    sentAt: new Date(now.getTime() - hoursAgo * 3600e3).toISOString(), category, dedupeKey: k,
  });
  const history = [h(1), h(23), h(24), h(2, "critical")]; // 24h-ago and critical don't count
  const r = plan({ history, candidates: [c("a", "reminder", 3), c("b", "promo", 2), c("c", "reminder", 1), c("k", "critical", 0)] });
  assert.deepEqual(r.send, ["a", "k"]);
  assert.deepEqual(r.dropped, [{ id: "b", rule: "frequency-cap-3-per-24h" }, { id: "c", rule: "frequency-cap-3-per-24h" }]);
});

test("cap leaves exactly the remaining slots, highest priority wins", () => {
  const history = [0.5, 5].map((hrs, i) => ({
    sentAt: new Date(now.getTime() - hrs * 3600e3).toISOString(), category: i ? "promo" : "reminder", dedupeKey: `h${i}`,
  }));
  const r = plan({ history, candidates: [c("lo", "reminder", 1), c("hi", "promo", 8), c("k", "critical", 0)] });
  assert.deepEqual(r.send, ["hi", "k"]);
  assert.deepEqual(r.dropped, [{ id: "lo", rule: "frequency-cap-3-per-24h" }]);
});

test("dedupe: 7-day window against history and within the batch", () => {
  const ago = (d) => new Date(now.getTime() - d * 86400e3).toISOString();
  const history = [
    { sentAt: ago(6.9), category: "reminder", dedupeKey: "recent" },
    { sentAt: ago(7), category: "reminder", dedupeKey: "edge" },
  ];
  const r = plan({ history, candidates: [
    c("a", "reminder", 1, "recent"), c("b", "reminder", 2, "edge"), c("c", "reminder", 3, "dup"), c("d", "reminder", 1, "dup"),
  ] });
  assert.deepEqual(r.send, ["c", "b"]);
  assert.deepEqual(r.dropped, [{ id: "a", rule: "dedupe-sent-within-7d" }, { id: "d", rule: "dedupe-duplicate-in-batch" }]);
});

test("a dropped candidate does not claim its dedupeKey", () => {
  const r = plan({ user: { ...base, promoOptIn: false }, candidates: [c("p", "promo", 9, "k"), c("r", "reminder", 1, "k")] });
  assert.deepEqual(r.send, ["r"]);
});

test("unknown category fails closed; inputs are not mutated", () => {
  const input = { user: { ...base, quietHours: { start: "01:00", end: "02:00" } }, candidates: [c("z", "weird", 1), c("a", "reminder", 2)], history: [], now };
  const snap = structuredClone({ ...input, now: undefined });
  const r = planSends(input);
  assert.deepEqual(r.dropped, [{ id: "z", rule: "unknown-category" }]);
  assert.deepEqual(structuredClone({ ...input, now: undefined }), snap);
  assert.equal(now.getTime(), Date.parse("2026-07-01T15:00:00Z"));
});
