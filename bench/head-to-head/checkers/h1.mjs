// Checker for H1 (async decide). usage: node h1.mjs <dir containing bot.mjs>
// Expected instants are derived by hand from the zone offsets, then cross-checked with Intl
// (see the derivation comments per criterion). Offsets used:
//   America/New_York and America/Toronto: EST = UTC-5, EDT = UTC-4 (EDT from 2026-03-08 07:00Z to 2026-11-01 06:00Z)
//   Europe/Istanbul: UTC+3 all year. Asia/Kolkata: UTC+5:30. Asia/Kathmandu: UTC+5:45.
// Reason text is matched case-insensitively. now is passed as a Date.
import { Report, load, sameInstant } from "./lib.mjs";

const dir = process.argv[2];
let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = { decide: async () => { throw e; } };
}
const r = new Report();

const usr = (timezone, country, quietHours = { start: "21:00", end: "08:00" }) => ({ id: "u1", timezone, country, quietHours });
const msg = (priority, channel) => ({ id: "m1", priority, channel });

// c = { user, message, now, send, hold (ISO string or null), has: [...] }. Only required words are checked:
// a reason is not checked for absent words, since a correct reason may name one rule or both.
async function check(note, label, c) {
  let out;
  try {
    out = await bot.decide({ user: c.user, message: c.message, now: new Date(c.now) });
  } catch (e) {
    note(`${label}: threw ${String((e && e.message) || e).slice(0, 120)}`);
    return false;
  }
  const problems = [];
  if (!out || typeof out !== "object") {
    problems.push("no result object");
  } else {
    if (out.send !== c.send) problems.push(`send=${out.send} expected ${c.send}`);
    if (c.hold === null) {
      if (out.holdUntil !== null) problems.push(`holdUntil=${out.holdUntil} expected null`);
    } else if (!sameInstant(out.holdUntil, c.hold)) {
      problems.push(`holdUntil=${out.holdUntil} expected ${c.hold}`);
    }
    const reason = typeof out.reason === "string" ? out.reason.toLowerCase() : "";
    for (const h of c.has || []) if (!reason.includes(h.toLowerCase())) problems.push(`reason lacks "${h}"`);
  }
  if (problems.length) note(`${label}: ${problems.join("; ")}`);
  return problems.length === 0;
}

async function all(note, cases) {
  let ok = true;
  for (const [label, c] of cases) {
    const res = await check(note, label, c);
    ok = res && ok;
  }
  return ok;
}

// 1. Basic quiet hours and the US legal window (NY, default quiet 21:00-08:00).
// 13:00Z = 09:00 EDT, outside both windows.
// 01:00Z = 21:00 EDT on 2026-06-14: quiet and legal both start; both end at 08:00 EDT = 12:00Z.
// 01:30Z = 21:30 EDT: critical ignores quiet hours but not the legal window; held to 12:00Z.
// 16:00Z = 12:00 EDT: critical SMS after the window, sent.
await r.crit("1 quiet and legal: NY SMS around the 21:00 and 08:00 edges", (note) =>
  all(note, [
    ["NY normal sms 13:00Z", { user: usr("America/New_York", "US"), message: msg("normal", "sms"), now: "2026-06-15T13:00:00Z", send: true, hold: null }],
    ["NY normal sms 01:00Z", { user: usr("America/New_York", "US"), message: msg("normal", "sms"), now: "2026-06-15T01:00:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["quiet hours", "47 CFR 64.1200"] }],
    ["NY critical sms 01:30Z", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-15T01:30:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["47 CFR 64.1200"] }],
    ["NY critical sms 16:00Z", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-15T16:00:00Z", send: true, hold: null }],
  ]),
);

// 2. Critical SMS to a US recipient is held to 08:00 local across DST edges and at the boundaries.
// 2026-03-08 spring forward at 07:00Z (02:00 EST to 03:00 EDT).
//   07:30Z = 03:30 EDT, held to 08:00 EDT = 12:00Z.
//   06:30Z = 01:30 EST (before the switch), held to 08:00 EDT = 12:00Z.
// 2026-11-01 fall back at 06:00Z (02:00 EDT to 01:00 EST).
//   05:30Z = 01:30 EDT (first pass), held to 08:00 EST = 13:00Z.
//   06:30Z = 01:30 EST (second pass), held to 08:00 EST = 13:00Z.
// Boundary on 2026-06-15 (EDT): 11:59Z = 07:59 held to 12:00Z; 12:00Z = 08:00 sent;
//   2026-06-16T00:59Z = 20:59 on 06-15 sent; 2026-06-16T01:00Z = 21:00 held to 2026-06-16T12:00Z.
await r.crit("2 DST: critical SMS held to 08:00 local on DST days and at the window edges", (note) =>
  all(note, [
    ["spring 03:30 EDT", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-03-08T07:30:00Z", send: false, hold: "2026-03-08T12:00:00Z", has: ["47 CFR 64.1200"] }],
    ["spring 01:30 EST", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-03-08T06:30:00Z", send: false, hold: "2026-03-08T12:00:00Z", has: ["47 CFR 64.1200"] }],
    ["fall 01:30 EDT first pass", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-11-01T05:30:00Z", send: false, hold: "2026-11-01T13:00:00Z", has: ["47 CFR 64.1200"] }],
    ["fall 01:30 EST second pass", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-11-01T06:30:00Z", send: false, hold: "2026-11-01T13:00:00Z", has: ["47 CFR 64.1200"] }],
    ["Jun 15 07:59 EDT", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-15T11:59:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["47 CFR 64.1200"] }],
    ["Jun 15 08:00 EDT", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-15T12:00:00Z", send: true, hold: null }],
    ["Jun 15 20:59 EDT", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-16T00:59:00Z", send: true, hold: null }],
    ["Jun 15 21:00 EDT", { user: usr("America/New_York", "US"), message: msg("critical", "sms"), now: "2026-06-16T01:00:00Z", send: false, hold: "2026-06-16T12:00:00Z", has: ["47 CFR 64.1200"] }],
  ]),
);

// 3. The hold is the later of the quiet-hours end and the legal opening (both computed in local time).
// quiet 22:00-10:00, normal SMS 11:00Z = 07:00 EDT: quiet ends 10:00 EDT = 14:00Z (later than legal 12:00Z).
// quiet 22:00-06:00, normal SMS 09:00Z = 05:00 EDT: quiet ends 06:00 EDT = 10:00Z, legal opens 12:00Z: hold 12:00Z.
// quiet 22:00-06:00, normal SMS 10:30Z = 06:30 EDT: not quiet; legal only, held to 12:00Z (the reason names the legal rule).
await r.crit("3 later-of: hold is the later of quiet-hours end and legal opening", (note) =>
  all(note, [
    ["quiet 22-10, NY normal sms 11:00Z", { user: usr("America/New_York", "US", { start: "22:00", end: "10:00" }), message: msg("normal", "sms"), now: "2026-06-15T11:00:00Z", send: false, hold: "2026-06-15T14:00:00Z", has: ["quiet hours", "47 CFR 64.1200"] }],
    ["quiet 22-06, NY normal sms 09:00Z", { user: usr("America/New_York", "US", { start: "22:00", end: "06:00" }), message: msg("normal", "sms"), now: "2026-06-15T09:00:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["quiet hours", "47 CFR 64.1200"] }],
    ["quiet 22-06, NY normal sms 10:30Z", { user: usr("America/New_York", "US", { start: "22:00", end: "06:00" }), message: msg("normal", "sms"), now: "2026-06-15T10:30:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["47 CFR 64.1200"] }],
  ]),
);

// 4. Scope: legal window only for SMS to country US; quiet hours skipped for critical; zones per user.
// critical email NY 07:00Z = 03:00 EDT: critical ignores quiet hours, email is not in the legal window.
// critical push NY 07:00Z: same.
// critical SMS TR (Istanbul) 00:30Z = 03:30 local: critical, country not US, sent.
// normal SMS CA (Toronto) 13:00Z = 09:00 EDT: country not US, outside quiet hours, sent.
// normal email NY 05:00Z = 01:00 EDT: quiet until 08:00 EDT = 12:00Z (the reason names quiet hours).
// normal SMS TR 00:00Z = 03:00 Istanbul: quiet until 08:00 Istanbul = 05:00Z.
// quietHours null, NY normal email 05:00Z: no restriction, sent.
await r.crit("4 scope: channel, priority, country and zone decide which rules apply", (note) =>
  all(note, [
    ["critical email NY 07:00Z", { user: usr("America/New_York", "US"), message: msg("critical", "email"), now: "2026-06-15T07:00:00Z", send: true, hold: null }],
    ["critical push NY 07:00Z", { user: usr("America/New_York", "US"), message: msg("critical", "push"), now: "2026-06-15T07:00:00Z", send: true, hold: null }],
    ["critical sms TR 00:30Z", { user: usr("Europe/Istanbul", "TR"), message: msg("critical", "sms"), now: "2026-06-15T00:30:00Z", send: true, hold: null }],
    ["normal sms CA Toronto 13:00Z", { user: usr("America/Toronto", "CA"), message: msg("normal", "sms"), now: "2026-06-15T13:00:00Z", send: true, hold: null }],
    ["normal email NY 05:00Z", { user: usr("America/New_York", "US"), message: msg("normal", "email"), now: "2026-06-15T05:00:00Z", send: false, hold: "2026-06-15T12:00:00Z", has: ["quiet hours"] }],
    ["normal sms TR 00:00Z", { user: usr("Europe/Istanbul", "TR"), message: msg("normal", "sms"), now: "2026-06-15T00:00:00Z", send: false, hold: "2026-06-15T05:00:00Z", has: ["quiet hours"] }],
    ["quiet null, NY normal email 05:00Z", { user: usr("America/New_York", "US", null), message: msg("normal", "email"), now: "2026-06-15T05:00:00Z", send: true, hold: null }],
  ]),
);

// 5. Half-hour and quarter-hour zones (no DST), normal email, quiet 22:00-06:00.
// Kolkata +05:30: 00:29Z = 05:59 held to 06:00 IST = 00:30Z; 00:30Z = 06:00 sent;
//   16:29Z = 21:59 sent; 16:30Z = 22:00 held to 06:00 IST on 06-16 = 2026-06-16T00:30:00Z.
// Kathmandu +05:45: 00:14Z = 05:59 held to 00:15Z; 00:15Z = 06:00 sent;
//   16:14Z = 21:59 sent; 16:15Z = 22:00 held to 2026-06-16T00:15:00Z.
await r.crit("5 half-hour zones: quiet window follows +05:30 and +05:45 local clocks", (note) =>
  all(note, [
    ["Kolkata 05:59 IST", { user: usr("Asia/Kolkata", "IN", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T00:29:00Z", send: false, hold: "2026-06-15T00:30:00Z", has: ["quiet hours"] }],
    ["Kolkata 06:00 IST", { user: usr("Asia/Kolkata", "IN", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T00:30:00Z", send: true, hold: null }],
    ["Kolkata 21:59 IST", { user: usr("Asia/Kolkata", "IN", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T16:29:00Z", send: true, hold: null }],
    ["Kolkata 22:00 IST", { user: usr("Asia/Kolkata", "IN", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T16:30:00Z", send: false, hold: "2026-06-16T00:30:00Z", has: ["quiet hours"] }],
    ["Kathmandu 05:59 NPT", { user: usr("Asia/Kathmandu", "NP", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T00:14:00Z", send: false, hold: "2026-06-15T00:15:00Z", has: ["quiet hours"] }],
    ["Kathmandu 06:00 NPT", { user: usr("Asia/Kathmandu", "NP", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T00:15:00Z", send: true, hold: null }],
    ["Kathmandu 21:59 NPT", { user: usr("Asia/Kathmandu", "NP", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T16:14:00Z", send: true, hold: null }],
    ["Kathmandu 22:00 NPT", { user: usr("Asia/Kathmandu", "NP", { start: "22:00", end: "06:00" }), message: msg("normal", "email"), now: "2026-06-15T16:15:00Z", send: false, hold: "2026-06-16T00:15:00Z", has: ["quiet hours"] }],
  ]),
);

// 6. Missing or invalid zone blocks everything, with a reason that names the time zone.
// Every combination below is checked at 2026-06-15T13:00Z with country US, so the legal window
// cannot be the reason for the block. Plus: a valid zone with quietHours null and country FR sends.
await r.crit("6 invalid time zone blocks every channel and priority; valid zone without quiet hours sends", (note) => {
  const cases = [];
  for (const tz of [undefined, "", "Mars/Olympus", null]) {
    for (const [p, ch] of [["normal", "sms"], ["normal", "email"], ["critical", "email"], ["critical", "sms"]]) {
      cases.push([`tz ${String(tz)} ${p} ${ch}`, { user: usr(tz, "US"), message: msg(p, ch), now: "2026-06-15T13:00:00Z", send: false, hold: null, has: ["time zone"] }]);
    }
  }
  cases.push(["Europe/Paris, quiet null, FR email", { user: usr("Europe/Paris", "FR", null), message: msg("normal", "email"), now: "2026-06-15T13:00:00Z", send: true, hold: null }]);
  return all(note, cases);
});

r.print();
