import test from "node:test";
import assert from "node:assert/strict";
import { planSends } from "./bot.mjs";

const user = { timeZone: "America/Chicago", promoOptIn: true, quietHours: { start: "22:00", end: "07:00" } };
// 2026-07-01T18:00Z = 13:00 in Chicago (CDT), outside quiet hours.
const noon = new Date("2026-07-01T18:00:00Z");
const c = (id, category, priority, dedupeKey = id) => ({ id, category, priority, dedupeKey });
const reasons = (r) => Object.fromEntries(r.dropped.map((d) => [d.id, d.rule]));

test("orders by priority, ties keep input order", () => {
  const r = planSends({ user, now: noon, history: [], candidates: [c("a", "reminder", 1), c("b", "reminder", 5), c("c", "reminder", 5)] });
  assert.deepEqual(r.send, ["b", "c", "a"]);
});

test("quiet hours wrap midnight, use local time, critical bypasses", () => {
  const night = new Date("2026-07-02T04:00:00Z"); // 23:00 Chicago
  const r = planSends({ user, now: night, history: [], candidates: [c("p", "promo", 9), c("r", "reminder", 8), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(reasons(r), { p: "quiet-hours", r: "quiet-hours" });
  // 07:00 local is the first allowed minute; 06:59 is still quiet.
  const at = (iso) => planSends({ user, now: new Date(iso), history: [], candidates: [c("r", "reminder", 1)] }).send.length;
  assert.equal(at("2026-07-02T11:59:00Z"), 0); // 06:59
  assert.equal(at("2026-07-02T12:00:00Z"), 1); // 07:00
  assert.equal(at("2026-07-03T03:00:00Z"), 0); // 22:00
});

test("DST: same UTC hour maps to different local time in winter", () => {
  const winter = new Date("2026-01-15T04:00:00Z"); // 22:00 CST
  assert.equal(planSends({ user, now: winter, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 0);
  const summer = new Date("2026-07-15T04:00:00Z"); // 23:00 CDT, also quiet
  assert.equal(planSends({ user, now: summer, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 0);
  const summer2 = new Date("2026-07-15T03:00:00Z"); // 22:00 CDT
  assert.equal(planSends({ user, now: summer2, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 0);
  const w2 = new Date("2026-01-15T03:00:00Z"); // 21:00 CST -> allowed
  assert.equal(planSends({ user, now: w2, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 1);
});

test("null quiet hours and same-day window", () => {
  const u = { ...user, quietHours: null };
  const night = new Date("2026-07-02T04:00:00Z");
  assert.equal(planSends({ user: u, now: night, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 1);
  const day = { ...user, quietHours: { start: "12:00", end: "14:00" } };
  assert.equal(planSends({ user: day, now: noon, history: [], candidates: [c("r", "reminder", 1)] }).send.length, 0);
});

test("promo without opt-in is dropped, critical still goes", () => {
  const r = planSends({ user: { ...user, promoOptIn: false }, now: noon, history: [], candidates: [c("p", "promo", 9), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(reasons(r), { p: "promo-no-opt-in" });
});

test("rolling 24h cap counts history, ignores critical, boundary exclusive", () => {
  const ago = (h) => new Date(noon.getTime() - h * 3600e3).toISOString();
  const history = [
    { sentAt: ago(1), category: "promo", dedupeKey: "h1" },
    { sentAt: ago(23.9), category: "reminder", dedupeKey: "h2" },
    { sentAt: ago(24), category: "reminder", dedupeKey: "h3" }, // exactly 24h: outside
    { sentAt: ago(2), category: "critical", dedupeKey: "h4" }, // not counted
  ];
  const r = planSends({ user, now: noon, history, candidates: [c("a", "reminder", 3), c("b", "promo", 2), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["a", "x"]);
  assert.deepEqual(reasons(r), { b: "daily-cap-3" });
});

test("dedupe: 7 day history window and within batch", () => {
  const ago = (d) => new Date(noon.getTime() - d * 86400e3).toISOString();
  const history = [
    { sentAt: ago(6.9), category: "reminder", dedupeKey: "k1" },
    { sentAt: ago(7), category: "reminder", dedupeKey: "k2" }, // exactly 7d: allowed again
  ];
  const r = planSends({ user, now: noon, history, candidates: [c("a", "reminder", 1, "k1"), c("b", "reminder", 1, "k2"), c("d1", "reminder", 5, "k3"), c("d2", "reminder", 4, "k3")] });
  assert.deepEqual(r.send, ["d1", "b"]);
  assert.deepEqual(reasons(r), { a: "dedupe-7d", d2: "dedupe-in-batch" });
});

test("a held candidate does not consume the dedupe key or a cap slot", () => {
  const u = { ...user, promoOptIn: false };
  const r = planSends({ user: u, now: noon, history: [], candidates: [c("p", "promo", 9, "k"), c("r", "reminder", 1, "k")] });
  assert.deepEqual(r.send, ["r"]);
});

test("every candidate accounted for once; no mutation; no clock", () => {
  const candidates = [c("a", "reminder", 1), c("b", "promo", 9), c("zz", "bogus", 1), c("a2", "reminder", 2)];
  const args = { user, candidates, history: [{ sentAt: "bad", category: "promo", dedupeKey: "q" }], now: noon };
  const snap = structuredClone({ ...args, now: 0 });
  const r = planSends(args);
  assert.equal(r.send.length + r.dropped.length, candidates.length);
  assert.equal(reasons(r).zz, "invalid-candidate");
  assert.deepEqual({ ...args, now: 0 }, snap);
  assert.equal(args.now, noon);
  const realNow = Date.now;
  Date.now = () => { throw new Error("clock read"); };
  try { planSends(args); } finally { Date.now = realNow; }
});

test("bad time zone holds non-critical only", () => {
  const r = planSends({ user: { ...user, timeZone: "Mars/Base" }, now: noon, history: [], candidates: [c("r", "reminder", 1), c("x", "critical", 1)] });
  assert.deepEqual(r.send, ["x"]);
  assert.deepEqual(reasons(r), { r: "invalid-time-zone" });
});
