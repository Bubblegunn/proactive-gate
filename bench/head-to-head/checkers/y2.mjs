// Checker for Y2 (decide: consent, snooze, quiet hours and daily limit, with plain reasons; synchronous).
// usage: node y2.mjs <dir containing bot.mjs>
//
// Expected instants are literals, derived by hand from the offsets below and cross-checked with an Intl script:
//   Europe/Istanbul is UTC+3 all year (no daylight saving since 2016).
//   America/New_York: EDT (UTC-4) from 2026-03-08 07:00Z, EST (UTC-5) from 2026-11-01 06:00Z (before that, EDT).
//   Asia/Kolkata is UTC+5:30 (no daylight saving).
// Each expected local clock is written beside its instant.
//
// Text rules checked on every blocked reason (from the prompt): one plain sentence, no "undefined", "null", "NaN",
// "[object" or ISO date-time text; it names the rule; it states the local time at `now` as HH:MM; for the three rules
// that end, it states the sendAt local HH:MM followed by "today" or "tomorrow" when that is the day (the expected word
// is given per case). A sentence break is a terminator (. ! ?) followed by whitespace and an upper-case letter, found
// after the first sentence; "e.g." and "i.e." are not terminators. No length limit: the prompt sets none.
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = {
    decide: () => {
      throw e;
    },
  };
}
const r = new Report();

const IST = "Europe/Istanbul";
const NY = "America/New_York";
const KOL = "Asia/Kolkata";

// Local clock of an instant in a zone: calendar day (YYYY-MM-DD) and HH:MM.
const dtf = new Map();
function localClock(ms, tz) {
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
  return { day: `${o.year}-${o.month}-${o.day}`, hm: `${hour}:${o.minute}` };
}
// Calendar-day difference of two YYYY-MM-DD strings (b minus a).
const dayDiff = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

const isoUtc = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(s) && !Number.isNaN(Date.parse(s));

// Case: { name, user, now (ISO), expect } where expect is one of
//   { send: true }
//   { send: false, sendAt: ISO or null, has: [lowercase phrases and HH:MM tokens], ahead?: { time, word } }
// `ahead` means: `time` occurs in the reason and `word` follows it (any occurrence counts).
const base = (fields) => ({ id: "u1", timezone: IST, consent: true, quietHours: null, snoozedUntil: null, sentToday: 0, ...fields });
const msg = { id: "m1" };
const Q = { start: "22:00", end: "08:00" };
const C = (name, user, now, expect) => ({ name, user, now, expect, message: msg });

// ---- criterion 1: precedence and 'snoozed' edges ----
const group1 = [
  C("no consent beats snoozed, quiet hours and daily limit", base({ consent: false, snoozedUntil: "2026-09-06T10:00:00Z", quietHours: Q, sentToday: 3 }), "2026-09-04T20:15:00Z", {
    send: false,
    sendAt: null,
    has: ["no consent"],
  }),
  // 23:15 local = 20:15Z. Snooze until 13:00 local on 09-06.
  C("snoozed beats quiet hours and daily limit", base({ snoozedUntil: "2026-09-06T10:00:00Z", quietHours: Q, sentToday: 3 }), "2026-09-04T20:15:00Z", {
    send: false,
    sendAt: "2026-09-06T10:00:00Z",
    has: ["snoozed"],
  }),
  C("quiet hours beat daily limit", base({ quietHours: Q, sentToday: 3 }), "2026-09-04T20:15:00Z", {
    send: false,
    sendAt: "2026-09-05T05:00:00Z",
    has: ["quiet hours"],
    ahead: { time: "08:00", word: "tomorrow" },
  }),
  // 14:20 local = 11:20Z. No quiet hours, 3 sent today.
  C("daily limit alone", base({ sentToday: 3 }), "2026-09-04T11:20:00Z", {
    send: false,
    sendAt: "2026-09-04T21:00:00Z",
    has: ["daily limit"],
    ahead: { time: "00:00", word: "tomorrow" },
  }),
  C("nothing applies: send now", base({}), "2026-09-04T11:20:00Z", { send: true }),
  // snoozedUntil equal to now does not snooze
  C("snoozedUntil equal to now does not snooze", base({ snoozedUntil: "2026-09-04T09:00:00Z" }), "2026-09-04T09:00:00Z", { send: true }),
  // snoozedUntil before now does not snooze
  C("snoozedUntil in the past does not snooze", base({ snoozedUntil: "2026-09-04T08:00:00Z" }), "2026-09-04T09:00:00Z", { send: true }),
];

// ---- criterion 2: quiet hours reasons, including DST days and a half-hour zone ----
const group2 = [
  // 23:15 local Istanbul, quiet 22:00 to 08:00: sends at 08:00 tomorrow
  C("quiet 23:15 Istanbul", base({ quietHours: Q }), "2026-09-04T20:15:00Z", {
    send: false,
    sendAt: "2026-09-05T05:00:00Z",
    has: ["quiet hours", "23:15", "08:00"],
    ahead: { time: "08:00", word: "tomorrow" },
  }),
  // 03:30 local Istanbul: sends at 08:00 today
  C("quiet 03:30 Istanbul", base({ quietHours: Q }), "2026-09-05T00:30:00Z", {
    send: false,
    sendAt: "2026-09-05T05:00:00Z",
    has: ["quiet hours", "03:30", "08:00"],
    ahead: { time: "08:00", word: "today" },
  }),
  // 2026-03-08 06:30Z = 01:30 EST (DST starts at 07:00Z). Quiet end 08:00 EDT = 12:00Z today.
  C("quiet 01:30 New York on the spring-forward day", base({ timezone: NY, quietHours: Q }), "2026-03-08T06:30:00Z", {
    send: false,
    sendAt: "2026-03-08T12:00:00Z",
    has: ["quiet hours", "01:30", "08:00"],
    ahead: { time: "08:00", word: "today" },
  }),
  // 2026-11-01 06:30Z = 01:30 EST (second pass; EDT ended at 06:00Z). Quiet end 08:00 EST = 13:00Z today.
  C("quiet 01:30 New York on the fall-back day", base({ timezone: NY, quietHours: Q }), "2026-11-01T06:30:00Z", {
    send: false,
    sendAt: "2026-11-01T13:00:00Z",
    has: ["quiet hours", "01:30", "08:00"],
    ahead: { time: "08:00", word: "today" },
  }),
  // Kolkata UTC+5:30: 2026-06-15 00:15Z = 05:45 IST. Quiet 22:00 to 06:00 ends at 06:00 IST = 00:30Z today.
  C("quiet 05:45 Kolkata (half-hour zone)", base({ timezone: KOL, quietHours: { start: "22:00", end: "06:00" } }), "2026-06-15T00:15:00Z", {
    send: false,
    sendAt: "2026-06-15T00:30:00Z",
    has: ["quiet hours", "05:45", "06:00"],
    ahead: { time: "06:00", word: "today" },
  }),
];

// ---- criterion 3: snoozed reasons ----
const group3 = [
  // now 09:00Z = 12:00 Istanbul; snooze until 10:00Z on 09-06 = 13:00 Istanbul on 09-06 (two days away, no day word)
  C("snooze two days away", base({ snoozedUntil: "2026-09-06T10:00:00Z" }), "2026-09-04T09:00:00Z", {
    send: false,
    sendAt: "2026-09-06T10:00:00Z",
    has: ["snoozed", "12:00", "13:00"],
  }),
  // snooze until 06:00Z on 09-05 = 09:00 Istanbul on 09-05 (tomorrow)
  C("snooze ends tomorrow", base({ snoozedUntil: "2026-09-05T06:00:00Z" }), "2026-09-04T09:00:00Z", {
    send: false,
    sendAt: "2026-09-05T06:00:00Z",
    has: ["snoozed", "12:00", "09:00"],
    ahead: { time: "09:00", word: "tomorrow" },
  }),
];

// ---- criterion 4: daily limit reasons, midnight in each zone ----
const group4 = [
  // Next local midnight in Istanbul is 2026-09-05 00:00 = 2026-09-04T21:00Z
  C("daily limit 14:20 Istanbul", base({ sentToday: 3 }), "2026-09-04T11:20:00Z", {
    send: false,
    sendAt: "2026-09-04T21:00:00Z",
    has: ["daily limit", "14:20"],
    ahead: { time: "00:00", word: "tomorrow" },
  }),
  // 2026-03-08 16:00Z = 12:00 EDT. Next midnight is 2026-03-09 00:00 EDT = 04:00Z.
  C("daily limit 12:00 New York on the spring-forward day", base({ timezone: NY, sentToday: 3 }), "2026-03-08T16:00:00Z", {
    send: false,
    sendAt: "2026-03-09T04:00:00Z",
    has: ["daily limit", "12:00"],
    ahead: { time: "00:00", word: "tomorrow" },
  }),
  // 2026-11-01 20:00Z = 15:00 EST. Next midnight is 2026-11-02 00:00 EST = 05:00Z.
  C("daily limit 15:00 New York on the fall-back day", base({ timezone: NY, sentToday: 3 }), "2026-11-01T20:00:00Z", {
    send: false,
    sendAt: "2026-11-02T05:00:00Z",
    has: ["daily limit", "15:00"],
    ahead: { time: "00:00", word: "tomorrow" },
  }),
];

// ---- criterion 6: edges and boundaries ----
const group6 = [
  // quiet 13:00 to 15:00 (no midnight crossing); 10:30Z = 13:30 Istanbul; ends 15:00 = 12:00Z today
  C("quiet window inside the day", base({ quietHours: { start: "13:00", end: "15:00" } }), "2026-09-04T10:30:00Z", {
    send: false,
    sendAt: "2026-09-04T12:00:00Z",
    has: ["quiet hours", "13:30", "15:00"],
    ahead: { time: "15:00", word: "today" },
  }),
  // quietHours null: 23:15 local is never quiet
  C("quietHours null at 23:15 local sends", base({ quietHours: null }), "2026-09-04T20:15:00Z", { send: true }),
  // exact start 22:00 local (19:00Z) is quiet; sends 08:00 tomorrow (05:00Z on 09-05)
  C("exact quiet start 22:00 is quiet", base({ quietHours: Q }), "2026-09-04T19:00:00Z", {
    send: false,
    sendAt: "2026-09-05T05:00:00Z",
    has: ["quiet hours", "22:00", "08:00"],
    ahead: { time: "08:00", word: "tomorrow" },
  }),
  // exact end 08:00 local (05:00Z on 09-05) is allowed
  C("exact quiet end 08:00 is allowed", base({ quietHours: Q }), "2026-09-05T05:00:00Z", { send: true }),
  // two sent today: the third may go
  C("sentToday 2 is allowed", base({ sentToday: 2 }), "2026-09-04T11:20:00Z", { send: true }),
];

const ALL_BLOCKED = [...group1, ...group2, ...group3, ...group4, ...group6].filter((c) => c.expect.send === false);

// Runs the bot on fresh copies of the input.
function run(c) {
  try {
    const res = bot.decide({ user: structuredClone(c.user), message: structuredClone(c.message), now: new Date(c.now) });
    if (res && typeof res.then === "function") return { threw: "returned a promise" };
    return res;
  } catch (e) {
    return { threw: String((e && e.message) || e).slice(0, 150) };
  }
}

// Returns null when the result matches the case, otherwise a short reason.
function verdict(c, res) {
  if (res && res.threw) return `threw ${res.threw}`;
  if (!res || typeof res !== "object") return "result is not an object";
  if (typeof res.send !== "boolean") return "send is not a boolean";
  const e = c.expect;
  if (e.send) {
    if (res.send !== true || res.sendAt !== null || res.reason !== null) {
      return `want send true, sendAt null, reason null; got ${JSON.stringify(res)}`;
    }
    return null;
  }
  if (res.send !== false) return `want send false, got ${JSON.stringify(res)}`;
  if (e.sendAt === null) {
    if (res.sendAt !== null) return `sendAt must be null for no consent, got ${JSON.stringify(res.sendAt)}`;
  } else if (!isoUtc(res.sendAt) || Date.parse(res.sendAt) !== Date.parse(e.sendAt)) {
    return `sendAt want ${e.sendAt}, got ${JSON.stringify(res.sendAt)}`;
  }
  if (typeof res.reason !== "string" || res.reason.trim().length === 0) return "reason must be a non-empty string";
  const low = res.reason.toLowerCase();
  for (const t of e.has) if (!low.includes(t.toLowerCase())) return `reason lacks ${JSON.stringify(t)}: ${JSON.stringify(res.reason)}`;
  const nowHM = localClock(Date.parse(c.now), c.user.timezone).hm;
  if (!res.reason.includes(nowHM)) return `reason does not state the local time at now (${nowHM}): ${JSON.stringify(res.reason)}`;
  if (e.ahead) {
    const { time, word } = e.ahead;
    let found = false;
    for (let i = res.reason.indexOf(time); i >= 0; i = res.reason.indexOf(time, i + 1)) {
      if (res.reason.slice(i + time.length).toLowerCase().includes(word)) found = true;
    }
    if (!found) return `"${word}" does not follow ${time} in ${JSON.stringify(res.reason)}`;
  }
  return null;
}

// Text rules for every blocked reason. Returns null when the reason is acceptable.
function textVerdict(res) {
  const s = res.reason;
  if (typeof s !== "string") return "reason is not a string";
  if (/\bundefined\b|\bnull\b|\[object|\d{4}-\d{2}-\d{2}T/i.test(s) || /\bNaN\b/.test(s)) {
    return `forbidden text in ${JSON.stringify(s)}`;
  }
  // Abbreviations do not end a sentence. Strip them, then look for a terminator, whitespace, and an upper-case letter.
  const body = s.replace(/\be\.g\./gi, "eg").replace(/\bi\.e\./gi, "ie").replace(/[.!?]\s*$/, "");
  if (/[.!?]\s+[A-Z]/.test(body)) return `more than one sentence in ${JSON.stringify(s)}`;
  return null;
}

function expectCases(list, note) {
  let ok = true;
  for (const c of list) {
    const why = verdict(c, run(c));
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
}

await r.crit("1 precedence: no consent, then snoozed, then quiet hours, then daily limit; snoozedUntil at or before now does not snooze", (note) =>
  expectCases(group1, note),
);
await r.crit("2 quiet hours reasons: local times, sendAt tomorrow or today, DST days and a half-hour zone", (note) =>
  expectCases(group2, note),
);
await r.crit("3 snoozed reasons: sendAt is snoozedUntil, local times named, tomorrow when it ends tomorrow", (note) =>
  expectCases(group3, note),
);
await r.crit("4 daily limit reasons: sendAt is the next local midnight, correct on the 23 and 25 hour days", (note) =>
  expectCases(group4, note),
);
await r.crit("5 hygiene: every blocked reason is one plain sentence with no forbidden text", (note) => {
  let ok = true;
  for (const c of ALL_BLOCKED) {
    const res = run(c);
    if (!res || res.threw) {
      ok = false;
      note(`${c.name}: no usable result`);
      continue;
    }
    if (res.send !== false) continue;
    const why = textVerdict(res);
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
});
await r.crit("6 edges: window not crossing midnight, quietHours null, exact boundaries, sentToday 2 allowed", (note) =>
  expectCases(group6, note),
);

r.print();
