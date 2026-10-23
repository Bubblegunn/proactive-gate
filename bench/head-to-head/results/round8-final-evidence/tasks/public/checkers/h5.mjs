// Checker for H5 (replay and compare, pure and synchronous). usage: node h5.mjs <dir containing bot.mjs>
// The checker carries its own reference (expectedReplay, expectedCompare) that works from Intl.DateTimeFormat
// for local clocks and a minute-by-minute scan for the moment quiet hours end. The events are generated from a
// seeded mulberry32 (seed 20261021) and then adjusted by fixed rules, listed in makeEvents().
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = {
    replay: () => { throw e; },
    compare: () => { throw e; },
  };
}
const r = new Report();
const MIN = 60000;

// ---------- reference (independent of ref/h5-good.mjs) ----------
const dtf = new Map();
function localParts(ms, tz) {
  if (!dtf.has(tz)) {
    dtf.set(tz, new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }));
  }
  const o = {};
  for (const p of dtf.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { day: `${o.year}-${o.month}-${o.day}`, min: Number(o.hour) * 60 + Number(o.minute) };
}
const hm = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
function quietAt(min, q) {
  if (!q) return false;
  const s = hm(q.start);
  const e = hm(q.end);
  return s < e ? min >= s && min < e : min >= s || min < e;
}
// Moment quiet hours end: scan minute by minute after `ms` until the local clock reads the end time.
function quietEndMs(ms, tz, q) {
  const target = hm(q.end);
  for (let t = ms + MIN, i = 0; i < 3 * 24 * 60; i++, t += MIN) {
    if (localParts(t, tz).min === target) return t;
  }
  throw new Error("no quiet end found");
}
function expectedReplay(events, policy) {
  // Processing order: time, ties by input position.
  const idx = events.map((_, i) => i);
  idx.sort((a, b) => {
    const d = Date.parse(events[a].at) - Date.parse(events[b].at);
    return d !== 0 ? d : a - b;
  });
  const used = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  for (const i of idx) {
    const ev = events[i];
    const ms = Date.parse(ev.at);
    const local = localParts(ms, ev.timezone);
    let d;
    if (ev.priority !== "critical" && quietAt(local.min, policy.quietHours)) {
      d = { id: ev.id, outcome: "held", holdUntil: new Date(quietEndMs(ms, ev.timezone, policy.quietHours)).toISOString(), reason: "quiet hours" };
    } else {
      const key = ev.userId + "|" + local.day;
      const n = used.get(key) || 0;
      if (policy.dailyCap !== null && n >= policy.dailyCap) {
        d = { id: ev.id, outcome: "refused", holdUntil: null, reason: "daily cap" };
      } else {
        used.set(key, n + 1);
        d = { id: ev.id, outcome: "sent", holdUntil: null, reason: null };
      }
    }
    counts[d.outcome] += 1;
    decisions.push(d);
  }
  return { decisions, counts };
}
function expectedCompare(events, pA, pB) {
  const a = expectedReplay(events, pA);
  const b = expectedReplay(events, pB);
  const changed = [];
  a.decisions.forEach((d, k) => {
    if (d.outcome !== b.decisions[k].outcome) changed.push({ id: d.id, from: d.outcome, to: b.decisions[k].outcome });
  });
  return { countsA: a.counts, countsB: b.counts, changed };
}

// ---------- event generation ----------
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const USERS = [
  ["ist", "Europe/Istanbul"],
  ["ny", "America/New_York"],
  ["kol", "Asia/Kolkata"],
  ["ktm", "Asia/Kathmandu"],
  ["syd", "Australia/Sydney"],
];
const WEEK0 = Date.parse("2026-03-05T00:00:00Z");
const WEEK_MINUTES = 7 * 24 * 60;
// 70 events, 14 per user (user = index mod 5), ids e01..e70 in generation order, 20% critical, minute-aligned
// instants drawn uniformly over 2026-03-05T00:00Z .. 2026-03-12T00:00Z. Then, in this order:
//   e02 (ny) set to 2026-03-08T06:30:00Z (01:30 EST on the spring-forward day, quiet under policy A).
//   e11 (ist) set to 2026-03-06T19:00:00Z (22:00 Istanbul, the exact start of policy A quiet hours).
//   e13 (kol) set to 2026-03-07T01:30:00Z (07:00 Kolkata, the exact end of policy A quiet hours).
//   Ties: e06 copies e01's instant (ist), e07 copies e02's (ny), e08 copies e03's (kol), e09 copies e04's (ktm).
// (Indexes below are zero-based array positions: e01 is position 0.)
function makeEvents() {
  const rnd = mulberry32(20261021);
  const ev = [];
  for (let i = 0; i < 70; i++) {
    const [userId, timezone] = USERS[i % 5];
    const at = new Date(WEEK0 + Math.floor(rnd() * WEEK_MINUTES) * MIN).toISOString();
    const priority = rnd() < 0.2 ? "critical" : "normal";
    ev.push({ id: "e" + String(i + 1).padStart(2, "0"), userId, timezone, at, priority });
  }
  ev[1].at = "2026-03-08T06:30:00.000Z";
  ev[10].at = "2026-03-06T19:00:00.000Z";
  ev[12].at = "2026-03-07T01:30:00.000Z";
  ev[5].at = ev[0].at;
  ev[6].at = ev[1].at;
  ev[7].at = ev[2].at;
  ev[8].at = ev[3].at;
  return ev;
}
function shuffled(arr, seed) {
  const rnd = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const A = { quietHours: { start: "22:00", end: "07:00" }, dailyCap: 3 };
const B = { quietHours: { start: "23:00", end: "06:00" }, dailyCap: 2 };
const C = { quietHours: null, dailyCap: null };
const clone = (x) => JSON.parse(JSON.stringify(x));
const events = makeEvents();

// ---------- comparison helpers ----------
const normHold = (h) => (typeof h === "string" ? Date.parse(h) : h);
function sameCounts(got, want) {
  return ["sent", "held", "refused"].every((k) => got && got[k] === want[k]);
}
function diffDecisions(got, want, note, label) {
  if (!Array.isArray(got)) {
    note(`${label}: decisions is not an array`);
    return false;
  }
  if (got.length !== want.length) {
    note(`${label}: ${got.length} decisions, expected ${want.length}`);
    return false;
  }
  let ok = true;
  for (let k = 0; k < want.length; k++) {
    const g = got[k] || {};
    const w = want[k];
    if (g.id !== w.id || g.outcome !== w.outcome || normHold(g.holdUntil) !== normHold(w.holdUntil)) {
      note(`${label}: position ${k} got ${g.id}/${g.outcome}/${g.holdUntil}, expected ${w.id}/${w.outcome}/${w.holdUntil}`);
      ok = false;
      break;
    }
  }
  return ok;
}
async function safe(note, label, fn) {
  try {
    return await fn();
  } catch (e) {
    note(`${label} threw ${String((e && e.message) || e).slice(0, 120)}`);
    return undefined;
  }
}

// 1. Counts for policy A equal the reference.
await r.crit("1 replay A counts equal reference", async (note) => {
  const want = expectedReplay(events, A).counts;
  const res = await safe(note, "replay A", () => bot.replay({ events: clone(events), policy: clone(A) }));
  if (res === undefined) return false;
  if (!sameCounts(res.counts, want)) {
    note(`counts ${JSON.stringify(res.counts)} expected ${JSON.stringify(want)}`);
    return false;
  }
  return true;
});

// 2. Policy A decisions are the same when the input is shuffled, and the input array is not modified.
await r.crit("2 replay A decisions with shuffled input, input unchanged", async (note) => {
  // Ties keep input order, so the reference is computed on this shuffled input, not on the generated order.
  const input = shuffled(clone(events), 7);
  const want = expectedReplay(input, A).decisions;
  const before = JSON.stringify(input);
  const res = await safe(note, "replay A shuffled", () => bot.replay({ events: input, policy: clone(A) }));
  if (res === undefined) return false;
  let ok = true;
  if (JSON.stringify(input) !== before) {
    note("input array was modified by replay");
    ok = false;
  }
  if (!diffDecisions(res.decisions, want, note, "replay A shuffled")) ok = false;
  return ok;
});

// 3. Policy B and policy C equal the reference. C (no quiet hours, no cap) sends everything.
await r.crit("3 replay B and C equal reference, C sends all", async (note) => {
  const wantB = expectedReplay(events, B);
  const wantC = expectedReplay(events, C);
  let ok = true;
  const resB = await safe(note, "replay B", () => bot.replay({ events: clone(events), policy: clone(B) }));
  if (resB === undefined) return false;
  if (!sameCounts(resB.counts, wantB.counts)) {
    note(`B counts ${JSON.stringify(resB.counts)} expected ${JSON.stringify(wantB.counts)}`);
    ok = false;
  }
  if (!diffDecisions(resB.decisions, wantB.decisions, note, "replay B")) ok = false;
  const resC = await safe(note, "replay C", () => bot.replay({ events: clone(events), policy: clone(C) }));
  if (resC === undefined) return false;
  if (!sameCounts(resC.counts, { sent: 70, held: 0, refused: 0 })) {
    note(`C counts ${JSON.stringify(resC.counts)} expected all 70 sent`);
    ok = false;
  }
  if (!diffDecisions(resC.decisions, wantC.decisions, note, "replay C")) ok = false;
  return ok;
});

// 4. Reasons and holdUntil fields by outcome, for policies A and B.
await r.crit("4 reasons and holdUntil fields match outcome", async (note) => {
  let ok = true;
  for (const [name, pol] of [["A", A], ["B", B]]) {
    const res = await safe(note, `replay ${name}`, () => bot.replay({ events: clone(events), policy: clone(pol) }));
    if (res === undefined) return false;
    if (!Array.isArray(res.decisions)) {
      note(`${name}: decisions is not an array`);
      return false;
    }
    for (const d of res.decisions) {
      const tag = `${name} ${d && d.id}`;
      if (d && d.outcome === "sent") {
        if (d.reason !== null || d.holdUntil !== null) {
          note(`${tag}: sent must have reason and holdUntil null`);
          ok = false;
        }
      } else if (d && d.outcome === "held") {
        const reason = typeof d.reason === "string" ? d.reason.toLowerCase() : "";
        if (!reason.includes("quiet hours")) {
          note(`${tag}: held reason lacks "quiet hours"`);
          ok = false;
        }
        if (typeof d.holdUntil !== "string" || Number.isNaN(Date.parse(d.holdUntil))) {
          note(`${tag}: held holdUntil is not an ISO string`);
          ok = false;
        }
      } else if (d && d.outcome === "refused") {
        const reason = typeof d.reason === "string" ? d.reason.toLowerCase() : "";
        if (!reason.includes("daily cap")) {
          note(`${tag}: refused reason lacks "daily cap"`);
          ok = false;
        }
        if (d.holdUntil !== null) {
          note(`${tag}: refused holdUntil must be null`);
          ok = false;
        }
      } else {
        note(`${tag}: unknown outcome ${d && d.outcome}`);
        ok = false;
      }
    }
  }
  return ok;
});

// 5. compare(A, B): counts for both policies and the changed list in processing order.
await r.crit("5 compare A and B: counts and changed list", async (note) => {
  const want = expectedCompare(events, A, B);
  const input = clone(events);
  const res = await safe(note, "compare", () => bot.compare({ events: input, policyA: clone(A), policyB: clone(B) }));
  if (res === undefined) return false;
  let ok = true;
  if (!sameCounts(res.countsA, want.countsA)) {
    note(`countsA ${JSON.stringify(res.countsA)} expected ${JSON.stringify(want.countsA)}`);
    ok = false;
  }
  if (!sameCounts(res.countsB, want.countsB)) {
    note(`countsB ${JSON.stringify(res.countsB)} expected ${JSON.stringify(want.countsB)}`);
    ok = false;
  }
  if (!Array.isArray(res.changed) || res.changed.length !== want.changed.length) {
    note(`changed has ${Array.isArray(res.changed) ? res.changed.length : "no list"} entries, expected ${want.changed.length}`);
    return false;
  }
  for (let k = 0; k < want.changed.length; k++) {
    const g = res.changed[k] || {};
    const w = want.changed[k];
    if (g.id !== w.id || g.from !== w.from || g.to !== w.to) {
      note(`changed[${k}] got ${g.id} ${g.from}->${g.to}, expected ${w.id} ${w.from}->${w.to}`);
      ok = false;
      break;
    }
  }
  if (JSON.stringify(input) !== JSON.stringify(events)) {
    note("compare modified its events input");
    ok = false;
  }
  return ok;
});

// 6. Directed cases: critical ignores quiet hours but not the cap; quiet is checked before the cap;
// equal timestamps keep input order.
// 6a: ny, cap 1, normal 12:00Z (08:00 EDT, sent) then critical 13:00Z (09:00 EDT, same local day): refused.
// 6b: ny, cap 1, critical 02:00Z (22:00 EDT on 06-14, quiet, sent) then normal 03:00Z (23:00 EDT, same day):
//     held, not refused (quiet first), holdUntil 2026-06-15T12:00:00Z (08:00 EDT).
// 6c: two normal events at 12:00Z, cap 1, input [t1, t2]: t1 sent, t2 refused; input [t2, t1]: t2 sent, t1 refused.
await r.crit("6 critical vs cap, quiet before cap, ties keep input order", async (note) => {
  const ny = "America/New_York";
  const pol = { quietHours: { start: "21:00", end: "08:00" }, dailyCap: 1 };
  const cases = [
    [
      "6a",
      [
        { id: "a", userId: "u", timezone: ny, at: "2026-06-15T12:00:00Z", priority: "normal" },
        { id: "b", userId: "u", timezone: ny, at: "2026-06-15T13:00:00Z", priority: "critical" },
      ],
      [["a", "sent"], ["b", "refused"]],
    ],
    [
      "6b",
      [
        { id: "c", userId: "u", timezone: ny, at: "2026-06-15T02:00:00Z", priority: "critical" },
        { id: "d", userId: "u", timezone: ny, at: "2026-06-15T03:00:00Z", priority: "normal" },
      ],
      [["c", "sent"], ["d", "held"]],
      { d: "2026-06-15T12:00:00Z" },
    ],
    [
      "6c",
      [
        { id: "t1", userId: "u", timezone: ny, at: "2026-06-15T12:00:00Z", priority: "normal" },
        { id: "t2", userId: "u", timezone: ny, at: "2026-06-15T12:00:00Z", priority: "normal" },
      ],
      [["t1", "sent"], ["t2", "refused"]],
    ],
    [
      "6c swapped",
      [
        { id: "t2", userId: "u", timezone: ny, at: "2026-06-15T12:00:00Z", priority: "normal" },
        { id: "t1", userId: "u", timezone: ny, at: "2026-06-15T12:00:00Z", priority: "normal" },
      ],
      [["t2", "sent"], ["t1", "refused"]],
    ],
  ];
  let ok = true;
  for (const [label, input, wantSeq, holds] of cases) {
    const res = await safe(note, label, () => bot.replay({ events: clone(input), policy: clone(pol) }));
    if (res === undefined) return false;
    const got = Array.isArray(res.decisions) ? res.decisions.map((d) => [d && d.id, d && d.outcome]) : [];
    if (JSON.stringify(got) !== JSON.stringify(wantSeq)) {
      note(`${label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(wantSeq)}`);
      ok = false;
    }
    if (holds) {
      for (const [id, until] of Object.entries(holds)) {
        const d = res.decisions.find((x) => x && x.id === id);
        if (!d || normHold(d.holdUntil) !== Date.parse(until)) {
          note(`${label}: ${id} holdUntil ${d && d.holdUntil}, expected ${until}`);
          ok = false;
        }
      }
    }
  }
  return ok;
});

r.print();
