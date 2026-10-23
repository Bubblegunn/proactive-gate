// Checker for H3 (STOP keywords per channel, START, snooze, consent, state on disk shared by processes).
// usage: node h3.mjs <dir containing bot.mjs>
// Keyword rule behind the expectations: the whole message, trimmed, lower-cased, with trailing punctuation
// removed, must equal a keyword. So "  Stop.  " is STOP, "UNSUBSCRIBE!" is STOP, "Yes." is START, while
// "stop it", "stopping", "yes please" and "please stop by tomorrow" change nothing.
// The only instants are 2026-09-04T12:00:00Z (snooze until, exclusive) and 11:59:59.999Z one millisecond before.
// Scenarios that check order run in one process (a single module instance); persistence checks use
// separate processes against the same state directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report } from "./lib.mjs";
import { run } from "./proc.mjs";

const BOT = process.argv[2];
const r = new Report();
const made = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "h3-"));
  made.push(d);
  return d;
};
const T0 = "2026-09-04T09:00:00Z";
const BEFORE = "2026-09-04T11:59:59.999Z";
const AT = "2026-09-04T12:00:00Z";
const SENT = { sent: true };
const STOP = { sent: false, has: ["stop"] };
const SNOOZE = { sent: false, has: ["snooze"] };
const CONSENT = { sent: false, has: ["consent"] };
const CHANNELS = ["sms", "email", "push"];

const inb = (userId, channel, text) => ({ fn: "handleInbound", args: { userId, channel, text, now: T0 } });
const tr = (id, consent, channel, now = T0) => ({ fn: "trySend", args: { user: { id, consent }, channel, now } });
const snz = (userId, until) => ({ fn: "snooze", args: { userId, until } });

function want(note, label, res, exp) {
  if (!res || typeof res !== "object" || res.error) {
    note(`${label}: ${res && res.error ? "threw " + String(res.error).slice(0, 120) : "no result"}`);
    return false;
  }
  const p = [];
  if (res.sent !== exp.sent) p.push(`sent=${res.sent} expected ${exp.sent}`);
  if (exp.sent) {
    if (res.reason !== null) p.push(`reason=${res.reason} expected null`);
  } else {
    const reason = typeof res.reason === "string" ? res.reason.toLowerCase() : "";
    for (const h of exp.has) if (!reason.includes(h)) p.push(`reason lacks "${h}"`);
  }
  if (p.length) note(`${label}: ${p.join("; ")}`);
  return p.length === 0;
}

// list: [label, plan item, expectation?]; one process, one module instance, items run in order.
async function script(note, list) {
  const res = await run(BOT, fresh(), list.map((x) => x[1]), false);
  let ok = true;
  list.forEach(([label, , exp], i) => {
    if (exp) {
      if (!want(note, label, res[i], exp)) ok = false;
    } else if (res[i] && res[i].error) {
      note(`${label}: threw ${String(res[i].error).slice(0, 120)}`);
      ok = false;
    }
  });
  return ok;
}

// 1. Eight spellings stop SMS even though consent is true.
const SPELLINGS = ["STOP", "stop", "  Stop.  ", "UNSUBSCRIBE!", "end", "Quit", "STOPALL", "cancel"];
await r.crit("1 stop keywords: each of eight spellings stops sms with consent still true, reason names stop", async (note) => {
  let ok = true;
  let k = 0;
  for (const text of SPELLINGS) {
    const id = "k" + ++k;
    const label = JSON.stringify(text);
    if (!(await script(note, [[`${label} handled`, inb(id, "sms", text)], [`${label} then sms`, tr(id, true, "sms"), STOP]]))) ok = false;
  }
  return ok;
});

// 2. A stop is per channel: sms stop leaves email and push; email stop leaves sms and push.
await r.crit("2 channel isolation: a stop on one channel leaves the other two channels sending", (note) =>
  script(note, [
    ["i1 sms STOP", inb("i1", "sms", "STOP")],
    ["i1 sms refused", tr("i1", true, "sms"), STOP],
    ["i1 email sent", tr("i1", true, "email"), SENT],
    ["i1 push sent", tr("i1", true, "push"), SENT],
    ["i2 email STOP", inb("i2", "email", "STOP")],
    ["i2 email refused", tr("i2", true, "email"), STOP],
    ["i2 sms sent", tr("i2", true, "sms"), SENT],
    ["i2 push sent", tr("i2", true, "push"), SENT],
  ]),
);

// 3. Ordinary texts, including ones that contain a keyword, change nothing.
const NO_EFFECT = ["please stop by tomorrow", "thanks", "HELP", "stopping", "end of month", "stop it", "I want to stop"];
await r.crit("3 no effect: seven ordinary texts that contain or resemble a keyword do not stop sms", async (note) => {
  let ok = true;
  let k = 0;
  for (const text of NO_EFFECT) {
    const id = "n" + ++k;
    if (!(await script(note, [[`${JSON.stringify(text)} handled`, inb(id, "sms", text)], [`${JSON.stringify(text)} then sms`, tr(id, true, "sms"), SENT]]))) ok = false;
  }
  return ok;
});

// 4. Re-enable with START, UNSTOP and YES (the exact upper-case spellings the prompt gives); a second STOP blocks again; "yes please" does not re-enable.
await r.crit("4 re-enable: START, UNSTOP and YES restore sms, a second STOP blocks again, yes please does not", async (note) => {
  let ok = true;
  for (const [i, word] of ["START", "UNSTOP", "YES"].entries()) {
    const id = "r" + i;
    const ok1 = await script(note, [
      [`${word}: STOP`, inb(id, "sms", "STOP")],
      [`${word}: sms refused`, tr(id, true, "sms"), STOP],
      [`${word}: email sent`, tr(id, true, "email"), SENT],
      [`${word}: reply`, inb(id, "sms", word)],
      [`${word}: sms sent after reply`, tr(id, true, "sms"), SENT],
      [`${word}: email still sent`, tr(id, true, "email"), SENT],
      [`${word}: second STOP`, inb(id, "sms", "STOP")],
      [`${word}: sms refused again`, tr(id, true, "sms"), STOP],
      [`${word}: START again`, inb(id, "sms", "START")],
      [`${word}: sms sent again`, tr(id, true, "sms"), SENT],
    ]);
    if (!ok1) ok = false;
  }
  if (!(await script(note, [
    ["START on a user who never stopped: handled", inb("never", "sms", "START")],
    ["never: sms sent", tr("never", true, "sms"), SENT],
  ]))) ok = false;
  if (!(await script(note, [
    ["yes please: STOP", inb("yp", "sms", "STOP")],
    ["yes please: reply", inb("yp", "sms", "yes please")],
    ["yes please: sms still refused", tr("yp", true, "sms"), STOP],
  ]))) ok = false;
  return ok;
});

// 5. Persistence: a stop written by one process is seen by another; four concurrent processes all persist;
//    STOP, START and STOP written by three separate processes end stopped.
await r.crit("5 persistence: state survives restarts and concurrent processes, and the order of writes holds", async (note) => {
  const st = fresh();
  let ok = true;
  const one = (plan) => run(BOT, st, plan, false);
  await one([inb("p", "sms", "STOP")]);
  const [p] = await one([tr("p", true, "sms")]);
  ok = want(note, "p stopped by an earlier process", p, STOP) && ok;

  const users = ["q1", "q2", "q3", "q4"];
  await Promise.all(users.map((q) => run(BOT, st, [inb(q, "sms", "STOP")], false)));
  const checks = await one(users.map((q) => tr(q, true, "sms")));
  users.forEach((q, i) => {
    ok = want(note, `${q} stopped by a concurrent process`, checks[i], STOP) && ok;
  });

  await one([inb("z", "sms", "STOP")]);
  await one([inb("z", "sms", "START")]);
  const [mid] = await one([tr("z", true, "sms")]);
  ok = want(note, "z sent after START in a later process", mid, SENT) && ok;
  await one([inb("z", "sms", "STOP")]);
  const [z] = await one([tr("z", true, "sms")]);
  ok = want(note, "z stopped after STOP, START, STOP in three processes", z, STOP) && ok;
  return ok;
});

// 6. Snooze: blocks every channel strictly before 12:00Z and lapses at 12:00Z; other users unaffected;
//    consent false refuses every channel, including a user who never interacted.
await r.crit("6 snooze and consent: snooze is exclusive at its until on every channel, consent false refuses every channel", (note) => {
  const list = [["snooze s until 12:00Z", snz("s", AT)]];
  for (const ch of CHANNELS) list.push([`s ${ch} 1 ms before`, tr("s", true, ch, BEFORE), SNOOZE]);
  list.push(["s2 sms 1 ms before (other user)", tr("s2", true, "sms", BEFORE), SENT]);
  for (const ch of CHANNELS) list.push([`s ${ch} at 12:00Z`, tr("s", true, ch, AT), SENT]);
  for (const ch of CHANNELS) list.push([`n1 ${ch} consent false, never interacted`, tr("n1", false, ch), CONSENT]);
  return script(note, list);
});

r.print();
for (const d of made) rmSync(d, { recursive: true, force: true });
