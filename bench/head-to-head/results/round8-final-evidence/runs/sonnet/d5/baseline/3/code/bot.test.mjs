import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

const NOW = new Date("2026-01-15T12:00:00Z"); // 06:00 in Chicago (CST, UTC-6)
const base = { timeZone: "America/Chicago", promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const h = (hoursAgo, category = "reminder", dedupeKey = "x") => ({
  sentAt: new Date(NOW.getTime() - hoursAgo * 3600e3).toISOString(),
  category,
  dedupeKey,
});
const run = (o) => planSends({ user: base, candidates: [], history: [], now: NOW, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test("orders by priority, stable on ties", () => {
  const r = run({ candidates: [c("a", "reminder", 1), c("b", "reminder", 5), c("c", "reminder", 5)] });
  assert.deepEqual(r.send, ["b", "c", "a"]);
  assert.deepEqual(r.dropped, []);
});

test("promo without opt-in is held, reminders unaffected", () => {
  const r = run({ user: { ...base, promoOptIn: false }, candidates: [c("p", "promo", 9), c("r", "reminder", 1)] });
  assert.deepEqual(r.send, ["r"]);
  assert.deepEqual(rules(r), { p: "promo-no-opt-in" });
});

test("cap: 3 per rolling 24h counts history, keeps best", () => {
  const r = run({
    history: [h(1, "promo", "k1"), h(23.9, "reminder", "k2"), h(24.1, "reminder", "k3"), h(2, "critical", "k4")],
    candidates: [c("lo", "reminder", 1), c("hi", "promo", 8), c("mid", "reminder", 4)],
  });
  // in-window reminder/promo: 2 (critical and the 24.1h-old one do not count) -> 1 slot left
  assert.deepEqual(r.send, ["hi"]);
  assert.deepEqual(rules(r), { lo: "daily-cap-3-per-24h", mid: "daily-cap-3-per-24h" });
});

test("critical bypasses cap, quiet hours; non-critical blocked in quiet hours", () => {
  const user = { ...base, quietHours: { start: "22:00", end: "07:00" } }; // wraps midnight, 06:00 local is inside
  const r = run({
    user,
    history: [h(1), h(2), h(3)],
    candidates: [c("crit", "critical", 0), c("rem", "reminder", 9)],
  });
  assert.deepEqual(r.send, ["crit"]);
  assert.deepEqual(rules(r), { rem: "quiet-hours" });
});

test("quiet hours use customer's zone and end is exclusive", () => {
  const user = { ...base, quietHours: { start: "22:00", end: "06:00" } };
  assert.deepEqual(run({ user, candidates: [c("a", "reminder", 1)] }).send, ["a"]); // 06:00 exactly
  const inside = new Date("2026-01-15T11:59:00Z"); // 05:59 Chicago
  assert.deepEqual(run({ user, now: inside, candidates: [c("a", "reminder", 1)] }).send, []);
  const sameDay = { ...base, quietHours: { start: "09:00", end: "17:00" } };
  assert.deepEqual(run({ user: sameDay, now: new Date("2026-01-15T18:00:00Z"), candidates: [c("a", "reminder", 1)] }).send, []);
});

test("quiet hours follow DST", () => {
  const user = { ...base, quietHours: { start: "22:00", end: "06:30" } };
  const summer = new Date("2026-07-15T11:15:00Z"); // 06:15 CDT
  assert.deepEqual(run({ user, now: summer, candidates: [c("a", "reminder", 1)] }).send, []);
});

test("7-day dedupe vs history, and within the batch", () => {
  const r = run({
    history: [h(24 * 6.9, "reminder", "same"), h(24 * 7.1, "reminder", "old")],
    candidates: [c("a", "reminder", 5, "same"), c("b", "reminder", 4, "old"), c("c", "reminder", 3, "old"), c("d", "promo", 2, "new")],
  });
  assert.deepEqual(r.send, ["b", "d"]);
  assert.deepEqual(rules(r), { a: "dedupe-7-days", c: "dedupe-same-batch" });
});

test("duplicate held for another reason does not block its twin", () => {
  const r = run({
    user: { ...base, promoOptIn: false },
    candidates: [c("p", "promo", 9, "k"), c("r", "reminder", 1, "k")],
  });
  assert.deepEqual(r.send, ["r"]);
});

test("invalid category and priority get their own rules", () => {
  const r = run({ candidates: [c("a", "spam", 1), c("b", "reminder", NaN)] });
  assert.deepEqual(rules(r), { a: "invalid-category", b: "invalid-priority" });
});

test("does not mutate arguments", () => {
  const args = {
    user: { ...base, quietHours: { start: "22:00", end: "07:00" } },
    candidates: [c("a", "reminder", 1), c("b", "critical", 9)],
    history: [h(1)],
    now: NOW,
  };
  const copy = structuredClone(args);
  const frozen = JSON.parse(JSON.stringify(args));
  const deepFreeze = (o) => (Object.values(o).forEach((v) => typeof v === "object" && v && deepFreeze(v)), Object.freeze(o));
  deepFreeze(frozen.user); deepFreeze(frozen.candidates); deepFreeze(frozen.history);
  planSends({ ...frozen, now: NOW });
  planSends(args);
  assert.deepEqual(args, copy);
});
