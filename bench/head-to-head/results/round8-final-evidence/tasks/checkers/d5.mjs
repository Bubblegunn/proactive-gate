process.env.TZ = "UTC";
import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const CH = "America/Chicago";
const H = 3600 * 1000;
const plan = async (o) => {
  const bot = await load(dir);
  const user = { timeZone: CH, promoOptIn: true, quietHours: null, ...(o.user || {}) };
  const now = new Date(o.now || "2026-06-10T18:00:00Z"); // 13:00 CDT
  const history = (o.history || []).map((h) => ({ category: "reminder", dedupeKey: "old-" + Math.random(), ...h, sentAt: new Date(now.getTime() - h.ago).toISOString() }));
  const candidates = o.candidates.map((c, i) => ({ priority: 1, dedupeKey: "k" + i, category: "reminder", ...c }));
  return bot.planSends({ user, candidates, history, now });
};
const ids = (x) => (x && Array.isArray(x.send) ? x.send : null);
const dropRule = (x, id) => ((x.dropped || []).find((d) => d.id === id) || {}).rule;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

await r.crit("1 promos need the customer's opt-in, reminders and critical messages do not", async (why) => {
  const cands = [{ id: "p", category: "promo" }, { id: "r", category: "reminder" }, { id: "c", category: "critical" }];
  const x = await plan({ user: { promoOptIn: false }, candidates: cands });
  const s = ids(x);
  if (!s || s.includes("p") || !s.includes("r") || !s.includes("c")) { why(JSON.stringify(x)); return false; }
  const y = await plan({ user: { promoOptIn: true }, candidates: cands });
  if (!ids(y) || !ids(y).includes("p")) { why("opted-in promo not sent"); return false; }
  return true;
});
await r.crit("2 quiet hours follow the customer's own window and zone, critical messages ignore them", async (why) => {
  const night = { quietHours: { start: "22:00", end: "07:00" } };
  const cases = [["2026-06-11T04:30:00Z", false], ["2026-06-11T11:59:00Z", false], ["2026-06-11T12:00:00Z", true], ["2026-06-11T02:59:00Z", true], ["2026-06-11T03:00:00Z", false]];
  for (const [now, want] of cases) {
    const x = await plan({ user: night, now, candidates: [{ id: "r", category: "reminder" }] });
    if ((ids(x) || []).includes("r") !== want) { why(`${now} want sent=${want}`); return false; }
  }
  const c = await plan({ user: night, now: "2026-06-11T04:30:00Z", candidates: [{ id: "c", category: "critical" }] });
  if (!(ids(c) || []).includes("c")) { why("critical held"); return false; }
  const nap = { quietHours: { start: "13:00", end: "15:00" } };
  for (const [now, want] of [["2026-06-10T18:30:00Z", false], ["2026-06-10T20:00:00Z", true]]) {
    const x = await plan({ user: nap, now, candidates: [{ id: "r", category: "reminder" }] });
    if ((ids(x) || []).includes("r") !== want) { why(`nap window ${now} want sent=${want}`); return false; }
  }
  const none = await plan({ user: { quietHours: null }, now: "2026-06-11T04:30:00Z", candidates: [{ id: "r", category: "reminder" }] });
  if (!(ids(none) || []).includes("r")) { why("no quiet hours set, still held"); return false; }
  return true;
});
await r.crit("3 at most three non-critical messages in any rolling 24 hours, critical ones neither count nor wait", async (why) => {
  const full = [{ ago: 1 * H }, { ago: 10 * H }, { ago: 24 * H - 60000 }];
  const x = await plan({ history: full, candidates: [{ id: "a" }, { id: "b", category: "promo" }] });
  if (!ids(x) || ids(x).length !== 0) { why("cap full but sent " + JSON.stringify(ids(x))); return false; }
  const y = await plan({ history: [{ ago: 1 * H }, { ago: 10 * H }, { ago: 24 * H + 60000 }], candidates: [{ id: "a" }, { id: "b" }] });
  if (!ids(y) || ids(y).length !== 1) { why("one slot expected, got " + JSON.stringify(ids(y))); return false; }
  const z = await plan({ history: [{ ago: 1 * H, category: "critical" }, { ago: 2 * H, category: "critical" }, { ago: 3 * H, category: "critical" }, { ago: 4 * H }], candidates: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  if (!ids(z) || ids(z).length !== 2) { why("critical history counted: " + JSON.stringify(ids(z))); return false; }
  const w = await plan({ history: full, candidates: [{ id: "k", category: "critical" }] });
  if (!(ids(w) || []).includes("k")) { why("critical held at cap"); return false; }
  return true;
});
await r.crit("4 when the cap leaves fewer slots than candidates, higher priority goes first, in that order", async (why) => {
  const cands = [
    { id: "low", priority: 1 }, { id: "high", priority: 9 }, { id: "mid", priority: 5 },
    { id: "tieA", priority: 5 }, { id: "zero", priority: 0 },
  ];
  const x = await plan({ candidates: cands });
  if (!same(ids(x), ["high", "mid", "tieA"])) { why(JSON.stringify(ids(x))); return false; }
  return true;
});
await r.crit("5 the same dedupe key is not repeated within seven days or twice in one batch", async (why) => {
  const x = await plan({ history: [{ ago: 3 * 24 * H, dedupeKey: "summer" }], candidates: [{ id: "a", dedupeKey: "summer" }] });
  if (!same(ids(x), [])) { why("repeat within 7 days sent"); return false; }
  const y = await plan({ history: [{ ago: 8 * 24 * H, dedupeKey: "summer" }], candidates: [{ id: "a", dedupeKey: "summer" }] });
  if (!same(ids(y), ["a"])) { why("old repeat held: " + JSON.stringify(ids(y))); return false; }
  const z = await plan({ candidates: [{ id: "first", dedupeKey: "d", priority: 7 }, { id: "second", dedupeKey: "d", priority: 3 }] });
  if (!same(ids(z), ["first"])) { why("batch duplicate: " + JSON.stringify(ids(z))); return false; }
  return true;
});
await r.crit("6 every candidate is sent or dropped exactly once, and each reason has its own non-empty rule", async (why) => {
  const night = { quietHours: { start: "22:00", end: "07:00" } };
  const a = await plan({ user: { promoOptIn: false }, candidates: [{ id: "x", category: "promo" }] });
  const b = await plan({ user: night, now: "2026-06-11T04:30:00Z", candidates: [{ id: "x" }] });
  const c = await plan({ history: [{ ago: H }, { ago: 2 * H }, { ago: 3 * H }], candidates: [{ id: "x" }] });
  const d = await plan({ history: [{ ago: H, dedupeKey: "same" }], candidates: [{ id: "x", dedupeKey: "same" }] });
  const rules = [a, b, c, d].map((p) => dropRule(p, "x"));
  if (rules.some((s) => typeof s !== "string" || !s)) { why(JSON.stringify(rules)); return false; }
  if (new Set(rules).size !== 4) { why("rules not distinct: " + JSON.stringify(rules)); return false; }
  const m = await plan({ user: { promoOptIn: false }, candidates: [{ id: "p", category: "promo" }, { id: "q" }, { id: "c", category: "critical" }] });
  const all = [...(m.send || []), ...(m.dropped || []).map((x) => x.id)].sort();
  if (!same(all, ["c", "p", "q"])) { why(JSON.stringify(all)); return false; }
  return true;
});
r.print();
