// Checker for Z3 (morning briefing push: deliver, recordDismissal). usage: node z3.mjs <dir containing bot.mjs>
// Every case runs in this process against fresh state (a new temp STATE_DIR and fresh user ids). The transport and the
// consent store are injected objects, so nothing is sent.
// Derivation of the expected instants (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   2026-09-04T05:30:00Z = 08:30 on 4 Sep, Europe/Istanbul (UTC+3, no DST)
//   2026-09-04T05:31:00Z = 08:31, 05:32:00Z = 08:32, 05:33:00Z = 08:33 (same local day)
//   2026-09-04T06:30:00Z = 09:30 on 4 Sep, Europe/Istanbul (the snooze end used by criterion 6; 09:30 is a morning hour)
//   2026-09-04T06:29:59.999Z = 09:29:59.999 on 4 Sep (one millisecond before the snooze end)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
const bot = await load(dir).catch(() => null);

const NOW = "2026-09-04T05:30:00Z";
const CAND = { id: "c1", type: "briefing" };
const GOOD_CONSENTS = { push: true, marketing: true, analytics: true, briefing: true };
let seq = 0;
const uid = (tag) => `${tag}-${++seq}`;
const user = (id, over = {}) => ({
  id,
  timezone: "Europe/Istanbul",
  categories: { briefing: true, tips: true },
  snoozedUntil: null,
  platform: "android",
  notificationsPermitted: true,
  ...over,
});
const roots = [];
function freshState() {
  const d = mkdtempSync(join(tmpdir(), "z3-"));
  roots.push(d);
  process.env.STATE_DIR = join(d, "state");
}
// Transport that records calls; pushResults is consumed in order (default true when exhausted).
function makeTransport(pushResults = []) {
  const calls = [];
  const script = [...pushResults];
  return {
    calls,
    push: async (u, c) => {
      calls.push("push");
      return script.length ? script.shift() : true;
    },
    inApp: async () => {
      calls.push("inApp");
    },
  };
}
const okConsent = () => ({ get: async () => ({ ...GOOD_CONSENTS }) });
const deliver = (u, at, transport, consentStore = okConsent()) =>
  bot.deliver({ user: u, candidate: CAND, now: new Date(at), transport, consentStore });

const r = new Report();

await r.crit("1 dismissals: five dismissals of suggestion do not stop the briefing", async (why) => {
  freshState();
  const u = user(uid("dis"));
  for (let h = 0; h < 5; h++) {
    await bot.recordDismissal(u.id, "suggestion", new Date(Date.parse("2026-09-03T09:00:00Z") + h * 3600_000));
  }
  const t = makeTransport();
  const res = await deliver(u, NOW, t);
  if (!res || res.push !== true) {
    why(`briefing after five suggestion dismissals: push ${JSON.stringify(res && res.push)}, reason ${JSON.stringify(res && res.reason)}`);
    return false;
  }
  return true;
});

await r.crit("2 categories: missing means no push but in-app; briefing true pushes; briefing false does not push", async (why) => {
  freshState();
  let ok = true;
  const missing = makeTransport();
  const a = await deliver(user(uid("cm"), { categories: undefined }), NOW, missing);
  if (!a || a.push !== false) {
    ok = false;
    why(`categories missing: push ${JSON.stringify(a && a.push)}`);
  }
  if (!a || a.inApp !== true || !missing.calls.includes("inApp")) {
    ok = false;
    why(`categories missing: in-app item not produced`);
  }
  if (missing.calls.includes("push")) {
    ok = false;
    why(`categories missing: transport.push was called`);
  }
  const yes = await deliver(user(uid("cy"), { categories: { briefing: true } }), NOW, makeTransport());
  if (!yes || yes.push !== true) {
    ok = false;
    why(`categories.briefing true: push ${JSON.stringify(yes && yes.push)}`);
  }
  const no = await deliver(user(uid("cn"), { categories: { briefing: false } }), NOW, makeTransport());
  if (!no || no.push !== false) {
    ok = false;
    why(`categories.briefing false: push ${JSON.stringify(no && no.push)}`);
  }
  return ok;
});

await r.crit("3 budget: two refused pushes do not spend the day, the third pushes, a fourth the same day does not", async (why) => {
  freshState();
  const u = user(uid("bud"));
  const t = makeTransport([false, false, true, true]);
  const a1 = await deliver(u, "2026-09-04T05:30:00Z", t);
  const a2 = await deliver(u, "2026-09-04T05:31:00Z", t);
  const a3 = await deliver(u, "2026-09-04T05:32:00Z", t);
  const a4 = await deliver(u, "2026-09-04T05:33:00Z", t);
  const want = [
    ["attempt 1 at 08:30", a1, false],
    ["attempt 2 at 08:31", a2, false],
    ["attempt 3 at 08:32", a3, true],
    ["attempt 4 at 08:33", a4, false],
  ];
  let ok = true;
  for (const [label, res, push] of want) {
    if (!res || res.push !== push) {
      ok = false;
      why(`${label}: push ${JSON.stringify(res && res.push)}, want ${push}`);
    }
  }
  return ok;
});

await r.crit("4 consent store: a throwing store means no push but the in-app item is still produced", async (why) => {
  freshState();
  const t = makeTransport();
  const throwing = { get: async () => { throw new Error("consent store unavailable"); } };
  let res;
  try {
    res = await deliver(user(uid("cs")), NOW, t, throwing);
  } catch (e) {
    why(`deliver threw: ${e.message}`);
    return false;
  }
  let ok = true;
  if (!res || res.push !== false) {
    ok = false;
    why(`push ${JSON.stringify(res && res.push)}, want false`);
  }
  if (!res || res.inApp !== true) {
    ok = false;
    why(`inApp ${JSON.stringify(res && res.inApp)}, want true`);
  }
  if (t.calls.includes("push")) {
    ok = false;
    why(`transport.push was called`);
  }
  return ok;
});

await r.crit("5 permission: Android with notifications not permitted gives no push and a reason naming the permission or its setting", async (why) => {
  freshState();
  const denied = await deliver(user(uid("pd"), { platform: "android", notificationsPermitted: false }), NOW, makeTransport());
  let ok = true;
  if (!denied || denied.push !== false) {
    ok = false;
    why(`android not permitted: push ${JSON.stringify(denied && denied.push)}`);
  }
  if (!denied || typeof denied.reason !== "string" || !/permission|permitted|disabled|settings/i.test(denied.reason)) {
    ok = false;
    why(`reason does not name the permission (permission, permitted, disabled or settings): ${JSON.stringify(denied && denied.reason)}`);
  }
  const allowed = await deliver(user(uid("pa"), { platform: "android", notificationsPermitted: true }), NOW, makeTransport());
  if (!allowed || allowed.push !== true) {
    ok = false;
    why(`android permitted: push ${JSON.stringify(allowed && allowed.push)}`);
  }
  return ok;
});

await r.crit("6 snooze: snoozedUntil holds the push until its instant (exclusive), resumeAt is the snooze end", async (why) => {
  freshState();
  const SNOOZE = "2026-09-04T06:30:00Z";
  let ok = true;
  const held = await deliver(user(uid("sn"), { snoozedUntil: SNOOZE }), NOW, makeTransport());
  if (!held || held.push !== false) {
    ok = false;
    why(`snoozed at 08:30 local: push ${JSON.stringify(held && held.push)}, want false`);
  }
  const resume = held && typeof held.resumeAt === "string" ? Date.parse(held.resumeAt) : NaN;
  if (resume !== Date.parse(SNOOZE)) {
    ok = false;
    why(`resumeAt ${JSON.stringify(held && held.resumeAt)} is not the snooze end`);
  }
  const justBefore = await deliver(user(uid("sb"), { snoozedUntil: SNOOZE }), "2026-09-04T06:29:59.999Z", makeTransport());
  if (!justBefore || justBefore.push !== false) {
    ok = false;
    why(`one millisecond before the snooze end (09:29:59.999 local): push ${JSON.stringify(justBefore && justBefore.push)}, want false`);
  }
  const atEnd = await deliver(user(uid("se"), { snoozedUntil: SNOOZE }), SNOOZE, makeTransport());
  if (!atEnd || atEnd.push !== true) {
    ok = false;
    why(`at the snooze end (09:30 local): push ${JSON.stringify(atEnd && atEnd.push)}, want true`);
  }
  return ok;
});

r.print();
