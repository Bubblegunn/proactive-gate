// Checker for Z6 (support and dry run: decide, whyNotReceived, dryRun). usage: node z6.mjs <dir containing bot.mjs>
// State is shared across OS processes: every bot call runs in its own process through procz.mjs (runProc), with a fresh
// STATE_DIR per scenario. Users are in Europe/Istanbul (UTC+3, no DST).
// Derivation of the expected instants and counts (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   2026-09-04T09:00:00Z = 12:00 on 4 Sep, 10:00Z = 13:00, 11:00Z = 14:00, 12:00Z = 15:00,
//   2026-09-04T19:30:00Z = 22:30 on 4 Sep (quiet hours 22:00 to 08:00), 2026-09-04T21:00:00Z = 00:00 on 5 Sep,
//   2026-09-05T05:00:00Z = 08:00 on 5 Sep (quiet hours end).
//   Scenario S (n5 belongs to user u4, who has no other deliveries that day):
//     s1: n1 (12:00) to n3 (14:00) delivered (cap 3 on 4 Sep); n4 (15:00) blocked by the cap, available at the next
//         local midnight (2026-09-04T21:00:00Z = 00:00 on 5 Sep) or at the first moment after it outside quiet hours
//         (2026-09-05T05:00:00Z = 08:00 on 5 Sep); either reading is accepted (see criterion 2).
//     u4: n5 (22:30) blocked by quiet hours, available 08:00 on 5 Sep = 2026-09-05T05:00:00Z.
//     s2: n6 blocked by consent (no availability).
//   dryRun, policy quiet 23:00 to 07:00 and cap 2, on S plus s3 events (13:00, 14:00, 15:00, 23:30, 00:30 on 5 Sep, 08:00 on 5 Sep):
//     s1: n1 and n2 delivered, n3 and n4 blocked by the cap; s2: n6 blocked by consent;
//     u4: n5 at 22:30 is outside the 23:00 start, so delivered (no delivery yet that day);
//     s3: 13:00 and 14:00 delivered, 15:00 blocked by the cap, 23:30 and 00:30 blocked by quiet hours,
//         08:00 delivered on the new day. Total delivered 6, blocked 6 (12 events).
//   dryRun, policy null and null: s1 n1 to n4 delivered, u4 n5 delivered, n6 blocked, s3's six events all delivered: 11 and 1.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";

const dir = process.argv[2];

const ZONE = "Europe/Istanbul";
const u = (id, consent) => ({ id, timezone: ZONE, consent });
const U1 = u("s1", true);
const U2 = u("s2", false);
const U3 = u("s3", true);
const U4 = u("u4", true);
const S_EVENTS = [
  { user: U1, id: "n1", at: "2026-09-04T09:00:00Z" },
  { user: U1, id: "n2", at: "2026-09-04T10:00:00Z" },
  { user: U1, id: "n3", at: "2026-09-04T11:00:00Z" },
  { user: U1, id: "n4", at: "2026-09-04T12:00:00Z" },
  { user: U4, id: "n5", at: "2026-09-04T19:30:00Z" },
  { user: U2, id: "n6", at: "2026-09-04T09:00:00Z" },
];
const U3_EVENTS = [
  { user: U3, id: "t1", at: "2026-09-04T10:00:00Z" },
  { user: U3, id: "t2", at: "2026-09-04T11:00:00Z" },
  { user: U3, id: "t3", at: "2026-09-04T12:00:00Z" },
  { user: U3, id: "t4", at: "2026-09-04T20:30:00Z" },
  { user: U3, id: "t5", at: "2026-09-04T21:30:00Z" },
  { user: U3, id: "t6", at: "2026-09-05T05:00:00Z" },
];
const asDry = (evs) => evs.map((e) => ({ user: e.user, notification: { id: e.id }, at: e.at }));

const HM = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function localHM(iso) {
  const p = {};
  for (const part of HM.formatToParts(new Date(iso))) p[part.type] = part.value;
  return `${p.hour}:${p.minute}`;
}
// True when text states the local time hm ("HH:MM") as 24-hour HH:MM, or as 12-hour h:MM with the AM or PM that denotes
// the same time (3:00 PM is 15:00, 12:00 AM is 00:00).
function hasLocalTime(text, hm) {
  const [hh, mm] = hm.split(":").map(Number);
  const mmS = String(mm).padStart(2, "0");
  const h24 = `${String(hh).padStart(2, "0")}:${mmS}`;
  if (new RegExp(`(^|[^0-9])${h24}(?![0-9])`).test(text)) return true;
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const ap = hh < 12 ? "a\\.?m\\.?" : "p\\.?m\\.?";
  return new RegExp(`(^|[^0-9])${h12}:${mmS}\\s*${ap}(?![A-Za-z])`, "i").test(text);
}
function sameInstant(a, iso) {
  return typeof a === "string" && Date.parse(a) === Date.parse(iso);
}
const roots = [];
function newState() {
  const d = mkdtempSync(join(tmpdir(), "z6-"));
  roots.push(d);
  return join(d, "state");
}
// one bot call in its own OS process
async function call(state, fn, args) {
  const [res] = await runProc(dir, state, [{ fn, args }]);
  return res;
}
async function decideIn(state, user, id, at) {
  const res = await call(state, "decide", [{ user, notification: { id }, now: { $date: at } }]);
  return res && res.send === true;
}
// Scenario S decided one event per process, in the order given
async function runS(state) {
  const sends = [];
  for (const e of S_EVENTS) sends.push(await decideIn(state, e.user, e.id, e.at));
  return sends;
}
const FULL = { from: "2026-09-04T00:00:00Z", to: "2026-09-05T00:00:00Z" };

const r = new Report();

await r.crit("1 entries: whyNotReceived lists every considered notification in order, with blocked ruleCodes, and from is inclusive and to exclusive", async (why) => {
  const state = newState();
  let ok = true;
  const sends = await runS(state);
  if (JSON.stringify(sends) !== JSON.stringify([true, true, true, false, false, false])) {
    why(`scenario S sends ${JSON.stringify(sends)}, want true,true,true,false,false,false`);
    ok = false;
  }
  const list = await call(state, "whyNotReceived", [{ userId: "s1", ...FULL }]);
  if (!Array.isArray(list) || list.length !== 4) {
    why(`u1 full day: ${JSON.stringify(list)} is not 4 entries`);
    return false;
  }
  const ids = list.map((e) => e.notificationId);
  if (JSON.stringify(ids) !== JSON.stringify(["n1", "n2", "n3", "n4"])) {
    why(`ids ${JSON.stringify(ids)}, want n1..n4 in order`);
    ok = false;
  }
  const delivered = list.map((e) => e.delivered);
  if (JSON.stringify(delivered) !== JSON.stringify([true, true, true, false])) {
    why(`delivered ${JSON.stringify(delivered)}, want true,true,true,false`);
    ok = false;
  }
  list.forEach((e, i) => {
    if (e.delivered && e.ruleCode !== null) {
      why(`${e.notificationId} delivered with ruleCode ${e.ruleCode}`);
      ok = false;
    }
    if (!e.delivered && (typeof e.ruleCode !== "string" || e.ruleCode.length === 0)) {
      why(`${e.notificationId} blocked without a ruleCode`);
      ok = false;
    }
    if (!sameInstant(e.at, S_EVENTS[i].at)) {
      why(`${e.notificationId} at ${e.at}, want ${S_EVENTS[i].at}`);
      ok = false;
    }
  });
  const before = await call(state, "whyNotReceived", [{ userId: "s1", from: "2026-09-04T00:00:00Z", to: "2026-09-04T11:00:00Z" }]);
  if (!Array.isArray(before) || JSON.stringify(before.map((e) => e.notificationId)) !== '["n1","n2"]') {
    why(`to exclusive: range ending at n3's instant gave ${JSON.stringify(before && before.map && before.map((e) => e.notificationId))}, want n1,n2`);
    ok = false;
  }
  const from = await call(state, "whyNotReceived", [{ userId: "s1", from: "2026-09-04T09:00:00Z", to: "2026-09-04T10:00:00Z" }]);
  if (!Array.isArray(from) || JSON.stringify(from.map((e) => e.notificationId)) !== '["n1"]') {
    why(`from inclusive: range [09:00Z, 10:00Z) gave ${JSON.stringify(from && from.map && from.map((e) => e.notificationId))}, want n1`);
    ok = false;
  }
  const empty = await call(state, "whyNotReceived", [{ userId: "s1", from: "2026-09-06T00:00:00Z", to: "2026-09-07T00:00:00Z" }]);
  if (!Array.isArray(empty) || empty.length !== 0) {
    why(`empty range gave ${JSON.stringify(empty)}, want []`);
    ok = false;
  }
  const unknown = await call(state, "whyNotReceived", [{ userId: "nobody-z6", ...FULL }]);
  if (!Array.isArray(unknown) || unknown.length !== 0) {
    why(`unknown user gave ${JSON.stringify(unknown)}, want []`);
    ok = false;
  }
  return ok;
});

await r.crit("2 availableAt: a cap block is available at the next local midnight or at the end of quiet hours that follows it, a quiet-hours block at the end of quiet hours, consent and delivered entries carry none", async (why) => {
  const state = newState();
  await runS(state);
  let ok = true;
  const u1 = await call(state, "whyNotReceived", [{ userId: "s1", ...FULL }]);
  const u2 = await call(state, "whyNotReceived", [{ userId: "s2", ...FULL }]);
  const u4 = await call(state, "whyNotReceived", [{ userId: "u4", ...FULL }]);
  if (!Array.isArray(u1) || u1.length !== 4 || !Array.isArray(u2) || u2.length !== 1 || !Array.isArray(u4) || u4.length !== 1) {
    why(`unexpected entry counts: u1 ${JSON.stringify(u1)} u2 ${JSON.stringify(u2)} u4 ${JSON.stringify(u4)}`);
    return false;
  }
  const byId = Object.fromEntries([...u1, ...u2, ...u4].map((e) => [e.notificationId, e]));
  // the cap block may report the next local midnight, or the first moment after it outside quiet hours (both are defensible)
  if (!sameInstant(byId.n4.availableAt, "2026-09-04T21:00:00Z") && !sameInstant(byId.n4.availableAt, "2026-09-05T05:00:00Z")) {
    why(`n4 (cap) availableAt ${byId.n4.availableAt}, want 2026-09-04T21:00:00Z (00:00 local on 5 Sep) or 2026-09-05T05:00:00Z (08:00 local on 5 Sep)`);
    ok = false;
  }
  if (!sameInstant(byId.n5.availableAt, "2026-09-05T05:00:00Z")) {
    why(`n5 (quiet hours) availableAt ${byId.n5.availableAt}, want 2026-09-05T05:00:00Z (08:00 local on 5 Sep)`);
    ok = false;
  }
  for (const id of ["n1", "n2", "n3"]) {
    if (byId[id].availableAt !== null && byId[id].availableAt !== undefined) {
      why(`${id} delivered but availableAt ${byId[id].availableAt}`);
      ok = false;
    }
  }
  if (byId.n6.availableAt !== null && byId.n6.availableAt !== undefined) {
    why(`n6 (consent) availableAt ${byId.n6.availableAt}, want null or absent`);
    ok = false;
  }
  return ok;
});

await r.crit("3 text: every entry is a sentence without an ISO date-time or UTC/GMT, and blocked entries give the local HH:MM of the decision and of availableAt", async (why) => {
  const state = newState();
  await runS(state);
  let ok = true;
  const entries = [
    ...(await call(state, "whyNotReceived", [{ userId: "s1", ...FULL }])),
    ...(await call(state, "whyNotReceived", [{ userId: "s2", ...FULL }])),
    ...(await call(state, "whyNotReceived", [{ userId: "u4", ...FULL }])),
  ];
  if (entries.length !== 6) {
    why(`expected 6 entries, got ${entries.length}`);
    return false;
  }
  for (const e of entries) {
    const t = e.text;
    if (typeof t !== "string" || t.trim().length === 0) {
      why(`${e.notificationId} text empty or not a string`);
      ok = false;
      continue;
    }
    if (/\d{4}-\d{2}-\d{2}T/.test(t)) {
      why(`${e.notificationId} text has an ISO date-time: ${t}`);
      ok = false;
    }
    if (/\bUTC\b|\bGMT\b/i.test(t)) {
      why(`${e.notificationId} text says UTC or GMT: ${t}`);
      ok = false;
    }
    if (!e.delivered) {
      const at = localHM(e.at);
      if (!hasLocalTime(t, at)) {
        why(`${e.notificationId} text lacks local decision time ${at}: ${t}`);
        ok = false;
      }
      if (e.availableAt && !hasLocalTime(t, localHM(e.availableAt))) {
        why(`${e.notificationId} text lacks local availableAt time ${localHM(e.availableAt)}: ${t}`);
        ok = false;
      }
    }
  }
  // the literal values: n4 15:00 (its availableAt is checked above), n5 22:30 and 08:00, n6 12:00
  const want = { n4: ["15:00"], n5: ["22:30", "08:00"], n6: ["12:00"] };
  for (const [id, parts] of Object.entries(want)) {
    const e = entries.find((x) => x.notificationId === id);
    for (const p of parts) {
      if (!e || !hasLocalTime(e.text, p)) {
        why(`${id} text lacks ${p}: ${e && e.text}`);
        ok = false;
      }
    }
  }
  return ok;
});

await r.crit("4 dryRun: counts the proposed policy on last week's events, and leaves the live counters untouched", async (why) => {
  let ok = true;
  const policy = { quietHours: { start: "23:00", end: "07:00" }, dailyCap: 2 };
  const state = newState();
  const dr = await call(state, "dryRun", [{ events: [...asDry(S_EVENTS), ...asDry(U3_EVENTS)], policy }]);
  if (!dr || dr.delivered !== 6 || dr.blocked !== 6) {
    why(`policy quiet 23:00-07:00 cap 2: ${JSON.stringify(dr)}, want delivered 6 blocked 6`);
    ok = false;
  }
  const all = await call(newState(), "dryRun", [{ events: [...asDry(S_EVENTS), ...asDry(U3_EVENTS)], policy: { quietHours: null, dailyCap: null } }]);
  if (!all || all.delivered !== 11 || all.blocked !== 1) {
    why(`policy null/null: ${JSON.stringify(all)}, want delivered 11 blocked 1`);
    ok = false;
  }
  // a dry run over a user who never had a live decision: spends nothing, leaves no log
  const fresh = newState();
  const dx = u("dx", true);
  const dryOnly = [0, 10, 20, 30, 40].map((m, i) => ({ user: dx, notification: { id: `d${i + 1}` }, at: `2026-09-04T09:${String(m).padStart(2, "0")}:00Z` }));
  const dr2 = await call(fresh, "dryRun", [{ events: dryOnly, policy: { quietHours: null, dailyCap: 1 } }]);
  if (!dr2 || dr2.delivered !== 1 || dr2.blocked !== 4) {
    why(`cap 1 on five events: ${JSON.stringify(dr2)}, want delivered 1 blocked 4`);
    ok = false;
  }
  const logged = await call(fresh, "whyNotReceived", [{ userId: "dx", ...FULL }]);
  if (!Array.isArray(logged) || logged.length !== 0) {
    why(`dryRun left a log: ${JSON.stringify(logged)}`);
    ok = false;
  }
  const lives = [];
  for (const [i, at] of ["2026-09-04T10:00:00Z", "2026-09-04T10:10:00Z", "2026-09-04T10:20:00Z"].entries()) {
    lives.push(await decideIn(fresh, dx, `l${i + 1}`, at));
  }
  if (JSON.stringify(lives) !== JSON.stringify([true, true, true])) {
    why(`live decide after dryRun: ${JSON.stringify(lives)}, want true x3`);
    ok = false;
  }
  return ok;
});

await r.crit("5 equality: dryRun with the live policy matches the live outcomes of the same events, and repeats identically", async (why) => {
  const state = newState();
  const sends = await runS(state);
  const liveDelivered = sends.filter(Boolean).length;
  const liveBlocked = sends.length - liveDelivered;
  const policy = { quietHours: { start: "22:00", end: "08:00" }, dailyCap: 3 };
  const events = asDry(S_EVENTS);
  const d1 = await call(state, "dryRun", [{ events, policy }]);
  const d2 = await call(state, "dryRun", [{ events, policy }]);
  let ok = true;
  if (!d1 || d1.delivered !== liveDelivered || d1.blocked !== liveBlocked) {
    why(`dryRun ${JSON.stringify(d1)} vs live delivered ${liveDelivered} blocked ${liveBlocked}`);
    ok = false;
  }
  if (JSON.stringify(d1) !== JSON.stringify(d2)) {
    why(`dryRun repeated differently: ${JSON.stringify(d1)} then ${JSON.stringify(d2)}`);
    ok = false;
  }
  return ok;
});

await r.crit("6 durability: the log written by one process is read by later processes, and 24 concurrent decisions over two processes log 24 entries with exactly 3 delivered", async (why) => {
  const state = newState();
  let ok = true;
  const first = await decideIn(state, U1, "n1", "2026-09-04T09:00:00Z");
  if (first !== true) {
    why(`first decision not delivered: ${first}`);
    ok = false;
  }
  const seenBy2 = await call(state, "whyNotReceived", [{ userId: "s1", ...FULL }]);
  const seenBy3 = await call(state, "whyNotReceived", [{ userId: "s1", ...FULL }]);
  for (const [label, list] of [["process 2", seenBy2], ["process 3", seenBy3]]) {
    if (!Array.isArray(list) || list.length !== 1 || list[0].notificationId !== "n1" || list[0].delivered !== true) {
      why(`${label} does not see n1: ${JSON.stringify(list)}`);
      ok = false;
    }
  }
  const C = u("c1", true);
  const plan = (tag) =>
    Array.from({ length: 12 }, (_, i) => ({ fn: "decide", args: [{ user: C, notification: { id: `${tag}-${i}` }, now: { $date: "2026-09-04T09:00:00Z" } }] }));
  const [p1, p2] = await Promise.all([runProc(dir, state, plan("a"), true), runProc(dir, state, plan("b"), true)]);
  const sends = [...p1, ...p2].filter((x) => x && x.send === true).length;
  if (sends !== 3) {
    why(`24 concurrent decisions delivered ${sends}, want 3`);
    ok = false;
  }
  const all = await call(state, "whyNotReceived", [{ userId: "c1", ...FULL }]);
  if (!Array.isArray(all) || all.length !== 24) {
    why(`c1 log has ${Array.isArray(all) ? all.length : JSON.stringify(all)} entries, want 24`);
    ok = false;
  } else if (new Set(all.map((e) => e.notificationId)).size !== 24) {
    why("c1 log does not hold 24 distinct notifications");
    ok = false;
  }
  return ok;
});

r.print();
