import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

const NOW = new Date("2026-03-10T18:00:00Z"); // 13:00 in Chicago (CDT, UTC-5)
const user = { timeZone: "America/Chicago", promoOptIn: true, quietHours: null };
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const run = (o) => planSends({ user, candidates: [], history: [], now: NOW, ...o });
const rules = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test("orders by priority, critical first", () => {
  const r = run({ candidates: [c("a", "promo", 1), c("b", "reminder", 9), c("f", "critical", 0)] });
  assert.deepEqual(r.send, ["f", "b", "a"]);
  assert.deepEqual(r.dropped, []);
});

test("promo without opt-in dropped; critical unaffected", () => {
  const r = run({ user: { ...user, promoOptIn: false }, candidates: [c("p", "promo", 5), c("f", "critical", 1)] });
  assert.deepEqual(r.send, ["f"]);
  assert.equal(rules(r).p, "promo-no-opt-in");
});

test("quiet hours use local time, wrap midnight, critical bypasses", () => {
  const q = { ...user, quietHours: { start: "12:30", end: "13:30" } };
  let r = run({ user: q, candidates: [c("r", "reminder", 1), c("f", "critical", 1)] });
  assert.deepEqual(r.send, ["f"]);
  assert.equal(rules(r).r, "quiet-hours");
  // 18:00Z is 13:00 Chicago: outside 22:00-07:00, inside 08:00-02:00 wrap
  r = run({ user: { ...user, quietHours: { start: "22:00", end: "07:00" } }, candidates: [c("r", "reminder", 1)] });
  assert.deepEqual(r.send, ["r"]);
  r = run({ user: { ...user, quietHours: { start: "12:00", end: "02:00" } }, candidates: [c("r", "reminder", 1)] });
  assert.equal(rules(r).r, "quiet-hours");
  // end is exclusive
  r = run({ user: { ...user, quietHours: { start: "12:00", end: "13:00" } }, candidates: [c("r", "reminder", 1)] });
  assert.deepEqual(r.send, ["r"]);
});

test("quiet hours follow DST (same UTC time, different local time)", () => {
  const q = { ...user, quietHours: { start: "12:30", end: "13:30" } };
  const winter = new Date("2026-01-10T18:00:00Z"); // 12:00 CST: outside
  assert.deepEqual(run({ user: q, now: winter, candidates: [c("r", "reminder", 1)] }).send, ["r"]);
});

test("bad timezone or quiet hours format holds non-critical with its own rule", () => {
  const r = run({ user: { ...user, timeZone: "Nope/Zone", quietHours: { start: "22:00", end: "07:00" } }, candidates: [c("r", "reminder", 1), c("f", "critical", 1)] });
  assert.deepEqual(r.send, ["f"]);
  assert.equal(rules(r).r, "quiet-hours-unevaluable");
});

test("rolling 24h cap of 3 counts history and batch; critical not counted", () => {
  const h = (hoursAgo, category = "reminder", k = `h${hoursAgo}`) => ({ sentAt: new Date(NOW - hoursAgo * 3600e3).toISOString(), category, dedupeKey: k });
  const r = run({
    history: [h(1), h(23.9), h(24), h(2, "critical")],
    candidates: [c("a", "reminder", 3), c("b", "promo", 2), c("f", "critical", 0)],
  });
  // h(1) and h(23.9) count; h(24) is outside the window; critical never counts. One slot left.
  assert.deepEqual(r.send, ["f", "a"]);
  assert.equal(rules(r).b, "rate-limit-24h");
});

test("cap: only remaining slots used, rest rate-limited", () => {
  const h = (hoursAgo) => ({ sentAt: new Date(NOW - hoursAgo * 3600e3).toISOString(), category: "promo", dedupeKey: `h${hoursAgo}` });
  const r = run({ history: [h(1), h(5)], candidates: [c("a", "reminder", 3), c("b", "promo", 2)] });
  assert.deepEqual(r.send, ["a"]);
  assert.equal(rules(r).b, "rate-limit-24h");
});

test("dedupe: 7 days from history, boundary allowed, and within batch", () => {
  const sent = (days, k) => ({ sentAt: new Date(NOW - days * 86400e3).toISOString(), category: "promo", dedupeKey: k });
  const r = run({
    history: [sent(6.99, "x"), sent(7, "y")],
    candidates: [c("a", "reminder", 1, "x"), c("b", "reminder", 1, "y"), c("d1", "reminder", 5, "z"), c("d2", "reminder", 4, "z")],
  });
  assert.deepEqual(r.send, ["d1", "b"]);
  assert.deepEqual(rules(r), { a: "dedupe-7d", d2: "dedupe-same-batch" });
});

test("unknown category dropped; every candidate appears exactly once", () => {
  const cands = [c("a", "weird", 1), c("b", "reminder", 1), c("c", "promo", 1), c("d", "promo", 1), c("e", "promo", 1)];
  const r = run({ candidates: cands });
  assert.equal(rules(r).a, "unknown-category");
  assert.equal(r.send.length + r.dropped.length, cands.length);
});

test("does not mutate arguments", () => {
  const args = {
    user: { ...user, quietHours: { start: "01:00", end: "02:00" } },
    candidates: [c("a", "reminder", 1), c("b", "promo", 9)],
    history: [{ sentAt: "2026-03-10T10:00:00Z", category: "promo", dedupeKey: "q" }],
    now: NOW,
  };
  const snap = structuredClone({ ...args, now: undefined });
  const t = NOW.getTime();
  planSends(args);
  assert.deepEqual({ ...structuredClone(args), now: undefined }, snap);
  assert.equal(NOW.getTime(), t);
});
