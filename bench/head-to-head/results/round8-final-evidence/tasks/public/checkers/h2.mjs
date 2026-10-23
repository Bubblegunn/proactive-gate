// Checker for H2 (daily, weekly and monthly caps across channels, state on disk, several processes).
// usage: node h2.mjs <dir containing bot.mjs>
// Expected instants are literals derived by hand from the zone rules:
//   Europe/Istanbul is UTC+3 all year, so local midnight is 21:00Z of the previous UTC day.
//   America/New_York is EST (UTC-5) until 2026-03-08 07:00Z, EDT (UTC-4) until 2026-11-01 06:00Z, EST after.
//   2026-09-04 is a Friday, so Monday is 2026-09-07 and the next Monday is 2026-09-14.
//   2026-03-02 is a Monday (spring-forward Sunday is 2026-03-08); 2026-11-01 is a Sunday.
// Scenarios that share a user run in one state directory, one OS process per call, unless noted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, sameInstant } from "./lib.mjs";
import { run } from "./proc.mjs";

const BOT = process.argv[2];
const r = new Report();
const made = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "h2-"));
  made.push(d);
  return d;
};
let seq = 0;
const U = (id, timezone) => ({ id, timezone });
const IST = "Europe/Istanbul";
const NY = "America/New_York";
const SENT = { sent: true };
const REFUSED = (has, hold) => ({ sent: false, has, hold });

// One trySend call in its own process against the given state directory.
async function call(st, user, channel, now) {
  const [res] = await run(BOT, st, [{ fn: "trySend", args: { user, message: { id: "m" + ++seq, channel }, now } }]);
  return res;
}

function want(note, label, res, exp) {
  if (!res || typeof res !== "object" || res.error) {
    note(`${label}: ${res && res.error ? "threw " + String(res.error).slice(0, 120) : "no result"}`);
    return false;
  }
  const p = [];
  if (exp.sent === true) {
    if (res.sent !== true) p.push(`sent=${res.sent} expected true`);
    if (res.holdUntil !== null) p.push(`holdUntil=${res.holdUntil} expected null`);
    if (res.reason !== null) p.push(`reason=${res.reason} expected null`);
  } else {
    if (res.sent !== false) p.push(`sent=${res.sent} expected false`);
    if (typeof res.holdUntil !== "string" || !sameInstant(res.holdUntil, exp.hold)) p.push(`holdUntil=${res.holdUntil} expected ${exp.hold}`);
    const reason = typeof res.reason === "string" ? res.reason.toLowerCase() : "";
    for (const h of exp.has) if (!reason.includes(h)) p.push(`reason lacks "${h}"`);
  }
  if (p.length) note(`${label}: ${p.join("; ")}`);
  return p.length === 0;
}

// steps: [label, user, channel, now, expectation]; all share one state directory, one process per call.
async function steps(note, list) {
  const st = fresh();
  let ok = true;
  for (const [label, user, channel, now, exp] of list) {
    if (!want(note, label, await call(st, user, channel, now), exp)) ok = false;
  }
  return ok;
}

// 1. Three per local day across SMS and email; the fourth is refused until local midnight.
await r.crit("1 daily cap: three per Istanbul day across channels, fourth refused until local midnight", (note) =>
  steps(note, [
    ["a sms 1", U("a", IST), "sms", "2026-09-04T09:00:00Z", SENT],
    ["a email 2", U("a", IST), "email", "2026-09-04T09:00:00Z", SENT],
    ["a sms 3", U("a", IST), "sms", "2026-09-04T09:00:00Z", SENT],
    ["a email 4 refused", U("a", IST), "email", "2026-09-04T09:00:00Z", REFUSED(["daily cap"], "2026-09-04T21:00:00.000Z")],
    ["a sms at 21:00Z (Sep 5 local)", U("a", IST), "sms", "2026-09-04T21:00:00Z", SENT],
    ["b sms unaffected", U("b", IST), "sms", "2026-09-04T09:00:00Z", SENT],
  ]),
);

// 2. Seven per ISO week. Mon 3, Tue 3, Wed 1 fill the week; Wed and Thu are refused with the weekly
//    reason (Wed has 1 of 3 daily). The reset is Monday 2026-09-14 00:00 +03 = 2026-09-13T21:00Z.
await r.crit("2 weekly cap: seven per Istanbul week, refusals name the weekly cap, reset at Monday midnight", (note) =>
  steps(note, [
    ["w Mon 1", U("w", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["w Mon 2", U("w", IST), "email", "2026-09-07T09:00:00Z", SENT],
    ["w Mon 3", U("w", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["w Tue 1", U("w", IST), "email", "2026-09-08T09:00:00Z", SENT],
    ["w Tue 2", U("w", IST), "sms", "2026-09-08T09:00:00Z", SENT],
    ["w Tue 3", U("w", IST), "email", "2026-09-08T09:00:00Z", SENT],
    ["w Wed 1 (seventh)", U("w", IST), "sms", "2026-09-09T09:00:00Z", SENT],
    ["w Wed 10:00Z refused", U("w", IST), "email", "2026-09-09T10:00:00Z", REFUSED(["weekly cap"], "2026-09-13T21:00:00.000Z")],
    ["w Thu refused", U("w", IST), "sms", "2026-09-10T09:00:00Z", REFUSED(["weekly cap"], "2026-09-13T21:00:00.000Z")],
    ["w Mon Sep 14 sends", U("w", IST), "sms", "2026-09-14T09:00:00Z", SENT],
    ["w Sun Sep 13 20:59:59.999Z still refused", U("w", IST), "email", "2026-09-13T20:59:59.999Z", REFUSED(["weekly cap"], "2026-09-13T21:00:00.000Z")],
    ["w Mon Sep 14 00:00 +03 reset, sends", U("w", IST), "sms", "2026-09-13T21:00:00.000Z", SENT],
  ]),
);

// 3. Both caps full on Thursday: Mon 3, Tue 1, Thu 3 = 7 in the week and 3 on Thursday.
//    Both are refused; the later reset (Monday) is the hold, not Friday midnight 2026-09-10T21:00Z.
await r.crit("3 both caps full: refusal names daily and weekly caps and holds until the later reset", (note) =>
  steps(note, [
    ["w3 Mon 1", U("w3", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["w3 Mon 2", U("w3", IST), "email", "2026-09-07T09:00:00Z", SENT],
    ["w3 Mon 3", U("w3", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["w3 Tue 1", U("w3", IST), "sms", "2026-09-08T09:00:00Z", SENT],
    ["w3 Thu 1", U("w3", IST), "sms", "2026-09-10T09:00:00Z", SENT],
    ["w3 Thu 2", U("w3", IST), "email", "2026-09-10T09:00:00Z", SENT],
    ["w3 Thu 3", U("w3", IST), "sms", "2026-09-10T09:00:00Z", SENT],
    ["w3 Thu 12:00Z refused", U("w3", IST), "email", "2026-09-10T12:00:00Z", REFUSED(["daily cap", "weekly cap"], "2026-09-13T21:00:00.000Z")],
  ]),
);

// 4. Monthly cap of 12 in September (Istanbul). The week of Aug 31 fills on Thu Sep 3 (7 sends), so a
//    Friday attempt is refused by the weekly cap. After Mon 7 (3) and Tue 8 (2) September holds 12;
//    Wed 9 is refused by the monthly cap (the week has 5 of 7, the day has 0 of 3).
//    The monthly reset is Oct 1 00:00 +03 = 2026-09-30T21:00Z. The Friday attempt is not recorded.
await r.crit("4 monthly cap: twelve per Istanbul month, refusals name the cap that is full", (note) =>
  steps(note, [
    ["m Tue 1 a", U("m", IST), "sms", "2026-09-01T09:00:00Z", SENT],
    ["m Tue 1 b", U("m", IST), "email", "2026-09-01T09:00:00Z", SENT],
    ["m Tue 1 c", U("m", IST), "sms", "2026-09-01T09:00:00Z", SENT],
    ["m Wed 2 a", U("m", IST), "email", "2026-09-02T09:00:00Z", SENT],
    ["m Wed 2 b", U("m", IST), "sms", "2026-09-02T09:00:00Z", SENT],
    ["m Wed 2 c", U("m", IST), "email", "2026-09-02T09:00:00Z", SENT],
    ["m Thu 3 (week of Aug 31 now 7)", U("m", IST), "sms", "2026-09-03T09:00:00Z", SENT],
    ["m Fri 4 refused by weekly cap", U("m", IST), "email", "2026-09-04T09:00:00Z", REFUSED(["weekly cap"], "2026-09-06T21:00:00.000Z")],
    ["m Mon 7 a", U("m", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["m Mon 7 b", U("m", IST), "email", "2026-09-07T09:00:00Z", SENT],
    ["m Mon 7 c", U("m", IST), "sms", "2026-09-07T09:00:00Z", SENT],
    ["m Tue 8 a", U("m", IST), "email", "2026-09-08T09:00:00Z", SENT],
    ["m Tue 8 b (twelfth)", U("m", IST), "sms", "2026-09-08T09:00:00Z", SENT],
    ["m Wed 9 refused by monthly cap", U("m", IST), "email", "2026-09-09T09:00:00Z", REFUSED(["monthly cap"], "2026-09-30T21:00:00.000Z")],
    ["m Wed 30 Sep 20:59:59.999Z still refused by monthly cap", U("m", IST), "sms", "2026-09-30T20:59:59.999Z", REFUSED(["monthly cap"], "2026-09-30T21:00:00.000Z")],
    ["m Thu 1 Oct 00:00 +03 reset, sends", U("m", IST), "email", "2026-09-30T21:00:00.000Z", SENT],
  ]),
);

// 5. DST. New York: the local day of 2026-03-08 lasts 23 hours (05:00Z to 04:00Z next day); the local day of
//    2026-11-01 lasts 25 hours (04:00Z to 05:00Z next day). The week of Mon 2026-03-02 spans spring forward.
await r.crit("5 DST: 23-hour and 25-hour local days cap by local midnight, a week across spring forward resets Monday midnight", async (note) => {
  let ok = true;
  ok = (await steps(note, [
    ["d 03-08 00:00 EST", U("d", NY), "sms", "2026-03-08T05:00:00Z", SENT],
    ["d 03-08 06:00 EDT", U("d", NY), "email", "2026-03-08T10:00:00Z", SENT],
    ["d 03-08 23:00 EDT", U("d", NY), "sms", "2026-03-09T03:00:00Z", SENT],
    ["d 03-08 23:59 EDT refused", U("d", NY), "email", "2026-03-09T03:59:00Z", REFUSED(["daily cap"], "2026-03-09T04:00:00.000Z")],
    ["d 03-09 00:00 EDT", U("d", NY), "sms", "2026-03-09T04:00:00Z", SENT],
  ])) && ok;
  ok = (await steps(note, [
    ["f 11-01 00:00 EDT", U("f", NY), "sms", "2026-11-01T04:00:00Z", SENT],
    ["f 11-01 07:00 EST", U("f", NY), "email", "2026-11-01T12:00:00Z", SENT],
    ["f 11-01 23:30 EST", U("f", NY), "sms", "2026-11-02T04:30:00Z", SENT],
    ["f 11-01 23:59 EST refused", U("f", NY), "email", "2026-11-02T04:59:00Z", REFUSED(["daily cap"], "2026-11-02T05:00:00.000Z")],
  ])) && ok;
  ok = (await steps(note, [
    ["dw Mon 03-02 x1", U("dw", NY), "sms", "2026-03-02T15:00:00Z", SENT],
    ["dw Mon 03-02 x2", U("dw", NY), "email", "2026-03-02T15:00:00Z", SENT],
    ["dw Mon 03-02 x3", U("dw", NY), "sms", "2026-03-02T15:00:00Z", SENT],
    ["dw Tue 03-03 x1", U("dw", NY), "email", "2026-03-03T15:00:00Z", SENT],
    ["dw Tue 03-03 x2", U("dw", NY), "sms", "2026-03-03T15:00:00Z", SENT],
    ["dw Tue 03-03 x3", U("dw", NY), "email", "2026-03-03T15:00:00Z", SENT],
    ["dw Wed 03-04 x1 (seventh)", U("dw", NY), "sms", "2026-03-04T15:00:00Z", SENT],
    ["dw Thu 03-05 refused by weekly cap", U("dw", NY), "email", "2026-03-05T15:00:00Z", REFUSED(["weekly cap"], "2026-03-09T04:00:00.000Z")],
  ])) && ok;
  return ok;
});

// 6. Concurrency. Per repeat: two processes run 12 concurrent calls for each of 5 users at the same instant;
//    exactly 3 are sent per user in total. A restarted process is refused by the daily cap. On the next local
//    day three calls per user are sent and the fourth is refused, which shows the refusals recorded nothing.
await r.crit("6 concurrency: two processes race for 12 calls per user, exactly three sent, refusals record nothing", async (note) => {
  const users = ["c0", "c1", "c2", "c3", "c4"];
  const now = "2026-09-04T09:00:00Z";
  const plan = (tag) => {
    const items = [];
    for (let k = 0; k < 12; k++) {
      for (const u of users) {
        items.push({ fn: "trySend", args: { user: U(u, IST), message: { id: `${tag}-${u}-${k}`, channel: k % 2 ? "sms" : "email" }, now } });
      }
    }
    return items;
  };
  let ok = true;
  for (let rep = 0; rep < 3; rep++) {
    const st = fresh();
    const pa = plan("A");
    const pb = plan("B");
    const [ra, rb] = await Promise.all([run(BOT, st, pa, true), run(BOT, st, pb, true)]);
    const sent = Object.fromEntries(users.map((u) => [u, 0]));
    for (const [items, out] of [[pa, ra], [pb, rb]]) {
      items.forEach((it, i) => {
        const res = out[i];
        if (!res || typeof res !== "object" || res.error) {
          note(`rep ${rep} ${it.args.message.id}: ${res && res.error ? "threw " + String(res.error).slice(0, 120) : "no result"}`);
          ok = false;
        } else if (res.sent === true) {
          sent[it.args.user.id]++;
        }
      });
    }
    for (const u of users) {
      if (sent[u] !== 3) {
        note(`rep ${rep} ${u}: sent ${sent[u]} in total, expected 3`);
        ok = false;
      }
    }
    const restart = users.map((u) => ({ fn: "trySend", args: { user: U(u, IST), message: { id: `R-${rep}-${u}`, channel: "sms" }, now } }));
    const rr = await run(BOT, st, restart, false);
    restart.forEach((it, i) => {
      if (!want(note, `rep ${rep} restart ${it.args.user.id}`, rr[i], REFUSED(["daily cap"], "2026-09-04T21:00:00.000Z"))) ok = false;
    });
    const next = [];
    for (const u of users) {
      for (let k = 0; k < 4; k++) {
        next.push({ fn: "trySend", args: { user: U(u, IST), message: { id: `N-${rep}-${u}-${k}`, channel: k % 2 ? "email" : "sms" }, now: "2026-09-04T21:00:00Z" } });
      }
    }
    const nr = await run(BOT, st, next, false);
    next.forEach((it, i) => {
      const k = i % 4;
      const exp = k < 3 ? SENT : REFUSED(["daily cap"], "2026-09-05T21:00:00.000Z");
      if (!want(note, `rep ${rep} next day ${it.args.user.id} call ${k + 1}`, nr[i], exp)) ok = false;
    });
  }
  return ok;
});

r.print();
for (const d of made) rmSync(d, { recursive: true, force: true });
