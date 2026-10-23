// Checker for Y3 (replay and compare under notification policies; pure and synchronous).
// usage: node y3.mjs <dir containing bot.mjs>
//
// The checker carries its own reference (expectedReplay, expectedCompare), written from the prompt. Local calendar
// days and clocks come from Intl.DateTimeFormat. The moment quiet hours end is found by scanning minute by minute.
// The ISO week is taken from the local calendar date (Monday is the first day). The 120 events are generated from
// mulberry32 seed 20261022 and then adjusted by the fixed rules in makeEvents(). Directed cases are literals.
//
// Expected local clocks used for the directed cases (offsets from Intl, cross-checked outside this file):
//   Europe/Istanbul UTC+3 (no DST). Asia/Kolkata UTC+5:30. America/New_York EST (UTC-5) until 2026-03-08 07:00Z,
//   EDT (UTC-4) from then on. 2026-03-08 is a Sunday, 2026-03-02 is a Monday.
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = {
    replay: () => {
      throw e;
    },
    compare: () => {
      throw e;
    },
  };
}
const r = new Report();
const MIN = 60000;

// ---------- reference (written from the prompt) ----------
const dtf = new Map();
function localParts(ms, tz) {
  if (!dtf.has(tz)) {
    dtf.set(
      tz,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  const o = {};
  for (const p of dtf.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  const hour = o.hour === "24" ? "00" : o.hour;
  return { day: `${o.year}-${o.month}-${o.day}`, min: Number(hour) * 60 + Number(o.minute) };
}
// Monday of the ISO week that contains the local calendar day (YYYY-MM-DD).
function mondayOf(day) {
  const [y, m, d] = day.split("-").map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  return new Date(Date.UTC(y, m - 1, d - dow)).toISOString().slice(0, 10);
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
function quietEndMs(ms, tz, end) {
  const target = hm(end);
  let t = ms + MIN;
  for (let i = 0; i < 3 * 24 * 60; i++, t += MIN) {
    if (localParts(t, tz).min === target) return t;
  }
  throw new Error("no quiet end found");
}
function expectedReplay(events, policy) {
  const order = events
    .map((_, i) => i)
    .sort((x, y) => Date.parse(events[x].at) - Date.parse(events[y].at) || x - y);
  const daily = new Map();
  const weekly = new Map();
  const decisions = [];
  const counts = { sent: 0, held: 0, refused: 0 };
  const byRule = {};
  for (const i of order) {
    const ev = events[i];
    const ms = Date.parse(ev.at);
    const lp = localParts(ms, ev.timezone);
    const dk = `${ev.userId}|${lp.day}`;
    const wk = `${ev.userId}|${mondayOf(lp.day)}`;
    let outcome = "sent";
    let rule = null;
    let holdUntil = null;
    if (policy.requireConsent && ev.consent !== true) {
      outcome = "refused";
      rule = "consent";
    } else if (ev.priority !== "critical" && quietAt(lp.min, policy.quietHours)) {
      outcome = "held";
      rule = "quietHours";
      holdUntil = new Date(quietEndMs(ms, ev.timezone, policy.quietHours.end)).toISOString();
    } else if (policy.dailyCap != null && (daily.get(dk) || 0) >= policy.dailyCap) {
      outcome = "refused";
      rule = "dailyCap";
    } else if (policy.weeklyCap != null && (weekly.get(wk) || 0) >= policy.weeklyCap) {
      outcome = "refused";
      rule = "weeklyCap";
    }
    if (outcome === "sent") {
      daily.set(dk, (daily.get(dk) || 0) + 1);
      weekly.set(wk, (weekly.get(wk) || 0) + 1);
    }
    counts[outcome] += 1;
    if (rule) byRule[rule] = (byRule[rule] || 0) + 1;
    decisions.push({ id: ev.id, outcome, rule, holdUntil });
  }
  return { decisions, counts, byRule };
}
function expectedCompare(events, pA, pB) {
  const a = expectedReplay(events, pA);
  const b = expectedReplay(events, pB);
  const label = (d) => (d.outcome === "sent" ? "sent" : `${d.outcome}:${d.rule}`);
  const changed = [];
  a.decisions.forEach((d, k) => {
    const from = label(d);
    const to = label(b.decisions[k]);
    if (from !== to) changed.push({ id: d.id, from, to });
  });
  return { countsA: a.counts, countsB: b.counts, byRuleA: a.byRule, byRuleB: b.byRule, changed };
}

// ---------- events ----------
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Ten users, two per zone: u0 Istanbul, u1 New York, u2 Kolkata, u3 Kathmandu, u4 Sydney, then the same again.
const ZONE_OF_USER = ["Europe/Istanbul", "America/New_York", "Asia/Kolkata", "Asia/Kathmandu", "Australia/Sydney"];
const START = Date.parse("2026-03-02T00:00:00Z");
const SPAN_MIN = 14 * 24 * 60;
function makeEvents() {
  const rnd = mulberry32(20261022);
  const ev = [];
  for (let i = 0; i < 120; i++) {
    const u = i % 10;
    ev.push({
      id: "e" + String(i + 1).padStart(3, "0"),
      userId: "u" + u,
      timezone: ZONE_OF_USER[u % 5],
      at: new Date(START + Math.floor(rnd() * SPAN_MIN) * MIN).toISOString(),
      priority: rnd() < 0.2 ? "critical" : "normal",
      consent: rnd() >= 0.15,
    });
  }
  // Fixed adjustments (zero-based indexes):
  ev[1].at = "2026-03-08T06:30:00.000Z"; // u1 New York, 01:30 EST on the spring-forward day
  ev[11].at = "2026-03-09T03:30:00.000Z"; // u1 New York, Sun 23:30 EDT, belongs to the old week
  ev[21].at = "2026-03-09T04:10:00.000Z"; // u1 New York, Mon 00:10 EDT, belongs to the new week
  ev[40].at = "2026-03-06T19:00:00.000Z"; // u0 Istanbul, 22:00 local: exact start of policy A quiet hours
  ev[42].at = "2026-03-07T01:30:00.000Z"; // u2 Kolkata, 07:00 local: exact end of policy A quiet hours
  // Ties: same instant, different users or events
  ev[30].at = ev[0].at;
  ev[31].at = ev[2].at;
  ev[32].at = ev[4].at;
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

const PA = { requireConsent: true, quietHours: { start: "22:00", end: "07:00" }, dailyCap: 3, weeklyCap: 8 };
const PB = { requireConsent: false, quietHours: { start: "23:00", end: "06:00" }, dailyCap: 2, weeklyCap: 5 };
const PC = { requireConsent: false, quietHours: null, dailyCap: null, weeklyCap: null };
const clone = (x) => JSON.parse(JSON.stringify(x));
const events = makeEvents();

// ---------- comparison helpers ----------
const sortKeys = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
const normHold = (h) => (typeof h === "string" ? Date.parse(h) : h);
const label = (d) => (d.outcome === "sent" ? "sent" : `${d.outcome}:${d.rule}`);

// Returns null when the replay result matches on counts and byRule, otherwise a short reason.
function countsMsg(res, want) {
  if (!res || typeof res !== "object") return "result is not an object";
  if (!res.counts || ["sent", "held", "refused"].some((k) => res.counts[k] !== want.counts[k])) {
    return `counts ${JSON.stringify(res.counts)} expected ${JSON.stringify(want.counts)}`;
  }
  if (!res.byRule || typeof res.byRule !== "object") return "byRule missing";
  if (sortKeys(res.byRule) !== sortKeys(want.byRule)) {
    return `byRule ${JSON.stringify(res.byRule)} expected ${JSON.stringify(want.byRule)}`;
  }
  return null;
}
// Returns null when the decisions match the reference in processing order, otherwise a short reason.
function decisionsMsg(res, want, n) {
  if (!res || !Array.isArray(res.decisions)) return "decisions is not an array";
  if (res.decisions.length !== n) return `${res.decisions.length} decisions, expected ${n}`;
  for (let k = 0; k < want.decisions.length; k++) {
    const g = res.decisions[k] || {};
    const w = want.decisions[k];
    const gRule = g.rule === undefined ? "undefined" : g.rule;
    if (g.id !== w.id || g.outcome !== w.outcome || gRule !== w.rule || normHold(g.holdUntil) !== normHold(w.holdUntil)) {
      return `position ${k}: got ${g.id}/${g.outcome}/${g.rule}/${g.holdUntil}, expected ${w.id}/${w.outcome}/${w.rule}/${w.holdUntil}`;
    }
  }
  return null;
}
// Returns null when each listed id has the expected "sent" or "outcome:rule" label.
function labelsMsg(res, want) {
  if (!res || !Array.isArray(res.decisions)) return "decisions is not an array";
  const got = new Map(res.decisions.map((d) => [d.id, d]));
  for (const [id, expect] of Object.entries(want)) {
    const d = got.get(id);
    if (!d) return `${id} missing`;
    if (label(d) !== expect) return `${id} is ${label(d)}, expected ${expect}`;
  }
  return null;
}
function call(fn, args) {
  try {
    const out = fn(args);
    if (out && typeof out.then === "function") return { threw: "returned a promise (must be synchronous)" };
    return out;
  } catch (e) {
    return { threw: String((e && e.message) || e).slice(0, 150) };
  }
}

// Directed cases -------------------------------------------------------------
const ev = (id, userId, timezone, at, consent = true, priority = "normal") => ({ id, userId, timezone, at, priority, consent });
const IST = "Europe/Istanbul";
const NY = "America/New_York";

// Weekly cap, Istanbul: Mon 03-02, Tue 03-03, Wed 03-04 (10:00 local = 07:00Z), then Mon 03-09.
const WEEK_IST = [
  ev("w1", "w", IST, "2026-03-02T07:00:00Z"),
  ev("w2", "w", IST, "2026-03-03T07:00:00Z"),
  ev("w3", "w", IST, "2026-03-04T07:00:00Z"),
  ev("w4", "w", IST, "2026-03-09T07:00:00Z"),
];
const POLICY_WEEK_IST = { requireConsent: false, quietHours: null, dailyCap: null, weeklyCap: 2 };
const LABELS_WEEK_IST = { w1: "sent", w2: "sent", w3: "refused:weeklyCap", w4: "sent" };

// Week boundary, New York across the 2026-03-08 DST Sunday. Sat 12:00 EST = 17:00Z; Sun 23:30 EDT = 03:30Z on 03-09;
// Mon 00:10 EDT = 04:10Z on 03-09. With a weekly cap of 1, Sunday's event is in the old week and Monday's is new.
const WEEK_NY = [
  ev("n1", "n", NY, "2026-03-07T17:00:00Z"),
  ev("n2", "n", NY, "2026-03-09T03:30:00Z"),
  ev("n3", "n", NY, "2026-03-09T04:10:00Z"),
];
const POLICY_WEEK_NY = { requireConsent: false, quietHours: null, dailyCap: null, weeklyCap: 1 };
const LABELS_WEEK_NY = { n1: "sent", n2: "refused:weeklyCap", n3: "sent" };

// The fall-back Sunday, 2026-11-01 (EDT until 06:00Z, EST after). Monday 2026-11-02 starts the new ISO week.
// Sat 10-31 12:00 EDT = 16:00Z on 10-31. Sun 11-01 23:30 EST = 04:30Z on 11-02 (a UTC reading puts it in the new week).
// Mon 11-02 00:10 EST = 05:10Z on 11-02. Weekly cap 1: the Saturday event fills the old week, so the Sunday event is
// refused and the Monday event is sent. A UTC week would send the Sunday event and refuse the Monday one.
const WEEK_NY_FALL = [
  ev("f1", "f", NY, "2026-10-31T16:00:00Z"),
  ev("f2", "f", NY, "2026-11-02T04:30:00Z"),
  ev("f3", "f", NY, "2026-11-02T05:10:00Z"),
];
const LABELS_WEEK_NY_FALL = { f1: "sent", f2: "refused:weeklyCap", f3: "sent" };

// Rule order and critical. Policy: consent, quiet 22:00 to 07:00, daily cap 1, weekly cap 1. All Istanbul.
//   d1 a 09:00 local sent. b 12:00 consent false: consent beats the cap. c 12:30 cap full: dailyCap.
//   d 23:00 local, cap full, quiet: quiet beats the cap, held until 07:00 local on 03-03 (04:00Z).
//   e 23:30 consent false, quiet: consent beats quiet. f Tue 10:00, weekly cap full: weeklyCap.
//   d2 g 13:00 critical sent; i 14:00 critical, cap full: dailyCap; h 23:40 critical consent false: consent.
//   d3 j 23:10 critical, quiet: critical ignores quiet hours, so sent.
const POLICY_ORDER = { requireConsent: true, quietHours: { start: "22:00", end: "07:00" }, dailyCap: 1, weeklyCap: 1 };
const ORDER_EVENTS = [
  ev("a", "d1", IST, "2026-03-02T06:00:00Z"),
  ev("b", "d1", IST, "2026-03-02T09:00:00Z", false),
  ev("c", "d1", IST, "2026-03-02T09:30:00Z"),
  ev("g", "d2", IST, "2026-03-02T10:00:00Z", true, "critical"),
  ev("i", "d2", IST, "2026-03-02T11:00:00Z", true, "critical"),
  ev("d", "d1", IST, "2026-03-02T20:00:00Z"),
  ev("j", "d3", IST, "2026-03-02T20:10:00Z", true, "critical"),
  ev("e", "d1", IST, "2026-03-02T20:30:00Z", false),
  ev("h", "d2", IST, "2026-03-02T20:40:00Z", false, "critical"),
  ev("f", "d1", IST, "2026-03-03T07:00:00Z"),
];
const LABELS_ORDER = {
  a: "sent",
  b: "refused:consent",
  c: "refused:dailyCap",
  g: "sent",
  i: "refused:dailyCap",
  d: "held:quietHours",
  j: "sent",
  e: "refused:consent",
  h: "refused:consent",
  f: "refused:weeklyCap",
};

// ---------- criteria ----------
await r.crit("1 replay A counts and byRule equal the reference (120 events, two weeks, five zones)", (note) => {
  const want = expectedReplay(clone(events), PA);
  const res = call(bot.replay, { events: clone(events), policy: clone(PA) });
  const why = countsMsg(res, want);
  if (why) note(why);
  return why === null;
});

await r.crit("2 replay A decisions equal the reference in processing order, shuffled input, input not modified", (note) => {
  const input = shuffled(clone(events), 7);
  const want = expectedReplay(clone(input), PA); // computed before the bot runs, on a copy
  const before = JSON.stringify(input);
  const res = call(bot.replay, { events: input, policy: clone(PA) });
  let ok = true;
  if (res && res.threw) {
    note(`threw ${res.threw}`);
    return false;
  }
  if (JSON.stringify(input) !== before) {
    note("input array was modified by replay");
    ok = false;
  }
  const why = decisionsMsg(res, want, events.length);
  if (why) {
    note(why);
    ok = false;
  }
  return ok;
});

await r.crit("3 replay B and C equal the reference; C sends all 120 with byRule empty", (note) => {
  let ok = true;
  for (const [name, pol] of [["B", PB], ["C", PC]]) {
    const want = expectedReplay(clone(events), pol);
    const res = call(bot.replay, { events: clone(events), policy: clone(pol) });
    if (res && res.threw) {
      note(`${name} threw ${res.threw}`);
      return false;
    }
    const why = countsMsg(res, want) || decisionsMsg(res, want, events.length);
    if (why) {
      note(`${name}: ${why}`);
      ok = false;
    }
  }
  const resC = call(bot.replay, { events: clone(events), policy: clone(PC) });
  if (!resC || !resC.counts || resC.counts.sent !== events.length || !resC.byRule || Object.keys(resC.byRule).length !== 0) {
    note(`C: expected all ${events.length} sent and byRule {}, got ${JSON.stringify(resC && { counts: resC.counts, byRule: resC.byRule })}`);
    ok = false;
  }
  return ok;
});

await r.crit("4 weekly cap: ISO week by local Monday, New York weeks across the 2026-03-08 and 2026-11-01 DST Sundays", (note) => {
  let ok = true;
  const resI = call(bot.replay, { events: clone(WEEK_IST), policy: clone(POLICY_WEEK_IST) });
  const whyI = labelsMsg(resI, LABELS_WEEK_IST);
  if (whyI) {
    note(`Istanbul: ${whyI}`);
    ok = false;
  }
  const resN = call(bot.replay, { events: clone(WEEK_NY), policy: clone(POLICY_WEEK_NY) });
  const whyN = labelsMsg(resN, LABELS_WEEK_NY);
  if (whyN) {
    note(`New York: ${whyN}`);
    ok = false;
  }
  const resF = call(bot.replay, { events: clone(WEEK_NY_FALL), policy: clone(POLICY_WEEK_NY) });
  const whyF = labelsMsg(resF, LABELS_WEEK_NY_FALL);
  if (whyF) {
    note(`New York fall-back week: ${whyF}`);
    ok = false;
  }
  return ok;
});

await r.crit("5 compare returns countsA, countsB, byRuleA, byRuleB and changed equal to the reference, input not modified", (note) => {
  const input = shuffled(clone(events), 11);
  const want = expectedCompare(clone(input), PA, PB);
  const before = JSON.stringify(input);
  const res = call(bot.compare, { events: input, policyA: clone(PA), policyB: clone(PB) });
  if (res && res.threw) {
    note(`threw ${res.threw}`);
    return false;
  }
  let ok = true;
  if (JSON.stringify(input) !== before) {
    note("input array was modified by compare");
    ok = false;
  }
  if (!res || typeof res !== "object") return false;
  for (const [k, w] of [["countsA", want.countsA], ["countsB", want.countsB]]) {
    if (!res[k] || ["sent", "held", "refused"].some((x) => res[k][x] !== w[x])) {
      note(`${k} ${JSON.stringify(res[k])} expected ${JSON.stringify(w)}`);
      ok = false;
    }
  }
  for (const [k, w] of [["byRuleA", want.byRuleA], ["byRuleB", want.byRuleB]]) {
    if (!res[k] || typeof res[k] !== "object" || sortKeys(res[k]) !== sortKeys(w)) {
      note(`${k} ${JSON.stringify(res[k])} expected ${JSON.stringify(w)}`);
      ok = false;
    }
  }
  if (!Array.isArray(res.changed) || JSON.stringify(res.changed) !== JSON.stringify(want.changed)) {
    const got = Array.isArray(res.changed) ? res.changed.length : "not an array";
    note(`changed: ${got} entries, expected ${want.changed.length} in processing order (first expected ${JSON.stringify(want.changed[0])})`);
    ok = false;
  }
  return ok;
});

await r.crit("6 rule order consent, quiet hours, daily cap, weekly cap; critical ignores quiet hours only", (note) => {
  // Reversed input: the order must come from the timestamps, not from the input.
  const res = call(bot.replay, { events: clone(ORDER_EVENTS).reverse(), policy: clone(POLICY_ORDER) });
  if (res && res.threw) {
    note(`threw ${res.threw}`);
    return false;
  }
  let ok = true;
  const why = labelsMsg(res, LABELS_ORDER);
  if (why) {
    note(why);
    ok = false;
  }
  const d = res && Array.isArray(res.decisions) ? res.decisions.find((x) => x.id === "d") : undefined;
  if (!d || normHold(d.holdUntil) !== Date.parse("2026-03-03T04:00:00.000Z")) {
    note(`held event d holdUntil ${JSON.stringify(d && d.holdUntil)}, expected 2026-03-03T04:00:00.000Z`);
    ok = false;
  }
  return ok;
});

r.print();
