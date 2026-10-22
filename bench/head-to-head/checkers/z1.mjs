// Checker for Z1 (daily check-in nudge: decide, recordDismissal, optOut). usage: node z1.mjs <dir containing bot.mjs>
// Every case runs against fresh state: a new temp STATE_DIR and fresh user ids. Multi-process cases use procz.mjs.
// Derivation of the expected instants (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   2026-09-04T09:00:00Z = 12:00 on 4 Sep, Europe/Istanbul (UTC+3, no DST)
//   2026-09-03T18:00:00Z = 03:00 on 4 Sep, Asia/Tokyo (UTC+9, no DST)
//   2026-09-04T03:00:00Z = 12:00 on 4 Sep, Asia/Tokyo
//   2026-09-04T23:00:00Z = 16:00 on 4 Sep, America/Los_Angeles (PDT, UTC-7; DST runs 8 Mar to 1 Nov 2026)
//   2026-09-05T01:00:00Z = 18:00 on 4 Sep, America/Los_Angeles (the UTC date is already 5 Sep, the local date is 4 Sep)
//   2026-09-05T19:00:00Z = 12:00 on 5 Sep, America/Los_Angeles (PDT, UTC-7: 19:00 minus 7 hours)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, load } from "./lib.mjs";
import { runProc } from "./procz.mjs";

const dir = process.argv[2];
const bot = await load(dir).catch(() => null);

const NOW = "2026-09-04T09:00:00Z";
const DAY = 24 * 60 * 60 * 1000;
const ON = { proactiveEnabled: true };
const CHECKIN = { id: "c1", type: "checkin" };
let seq = 0;
const uid = (tag) => `${tag}-${++seq}`;
const user = (id, over = {}) => ({
  id,
  timezone: "Europe/Istanbul",
  deviceTimezone: undefined,
  consents: { marketing: true },
  createdAt: new Date(Date.parse(NOW) - 60 * DAY).toISOString(),
  ...over,
});
// Every call gets a fresh candidate id unless the caller passes one (the concurrency block shares one id on purpose).
const decideArgs = (u, at, type = "checkin", flags = ON, id = uid("cand")) => ({
  user: u,
  candidate: { id, type },
  now: { $date: at },
  flags,
});
const isRefusal = (res) => res && typeof res === "object" && res.send === false && typeof res.reason === "string" && res.reason.trim().length > 0;

const roots = [];
function freshState() {
  const d = mkdtempSync(join(tmpdir(), "z1-"));
  roots.push(d);
  const state = join(d, "state");
  process.env.STATE_DIR = state;
  return state;
}
const decide = (u, at, type = "checkin", flags = ON) =>
  bot.decide({ user: u, candidate: { id: uid("cand"), type }, now: new Date(at), flags });

const r = new Report();

await r.crit("1 marketing: a check-in is sent only when consents.marketing is true", async (why) => {
  freshState();
  const cases = [
    ["marketing true", { marketing: true }, true],
    ["marketing false", { marketing: false }, false],
    ["consents missing", undefined, false],
    ["consents empty", {}, false],
    ["only analytics true", { analytics: true }, false],
  ];
  let ok = true;
  for (const [label, consents, want] of cases) {
    const res = await decide(user(uid("m"), { consents }), NOW);
    if (!res || res.send !== want) {
      ok = false;
      why(`${label}: send ${JSON.stringify(res && res.send)}, want ${want}`);
    } else if (!want && !isRefusal(res)) {
      ok = false;
      why(`${label}: refused without a non-empty reason`);
    }
  }
  return ok;
});

await r.crit("2 opt-out: after optOut the next decision is refused, others are not, and it survives a new process", async (why) => {
  const state = freshState();
  const u2 = uid("o2");
  const u3 = uid("o3");
  await bot.optOut(u2, "checkin");
  const a = await decide(user(u2), NOW);
  if (!isRefusal(a)) {
    why(`in-process decision after optOut: ${JSON.stringify(a)}`);
    return false;
  }
  const b = await decide(user(u3), NOW);
  if (!b || b.send !== true) {
    why(`another user was affected: ${JSON.stringify(b)}`);
    return false;
  }
  const [c] = await runProc(dir, state, [{ fn: "decide", args: [decideArgs(user(u2), NOW)] }]);
  if (!isRefusal(c)) {
    why(`second process allowed the opted-out user: ${JSON.stringify(c)}`);
    return false;
  }
  return true;
});

await r.crit("3 zone: a missing or UTC timezone uses deviceTimezone, and no usable zone means not sent", async (why) => {
  freshState();
  let ok = true;
  const tokyo = [
    ["timezone missing", { timezone: undefined, deviceTimezone: "Asia/Tokyo" }],
    ["timezone UTC", { timezone: "UTC", deviceTimezone: "Asia/Tokyo" }],
  ];
  for (const [label, over] of tokyo) {
    const early = await decide(user(uid("tk"), over), "2026-09-03T18:00:00Z");
    const noon = await decide(user(uid("tk"), over), "2026-09-04T03:00:00Z");
    if (!early || early.send !== false) {
      ok = false;
      why(`${label}: sent at 03:00 Tokyo (${JSON.stringify(early && early.send)})`);
    }
    if (!noon || noon.send !== true) {
      ok = false;
      why(`${label}: not sent at 12:00 Tokyo (${JSON.stringify(noon && noon.send)})`);
    }
  }
  const none = [
    ["no zone at all", { timezone: undefined, deviceTimezone: undefined }],
    ["timezone UTC and no device zone", { timezone: "UTC", deviceTimezone: undefined }],
  ];
  for (const [label, over] of none) {
    const res = await decide(user(uid("nz"), over), NOW);
    if (!res || res.send !== false) {
      ok = false;
      why(`${label}: sent at 12:00 UTC (${JSON.stringify(res && res.send)})`);
    }
  }
  return ok;
});

await r.crit("4 cap: one check-in per user per local day, counted on the local day, exactly one under 2 processes x 12 calls", async (why) => {
  freshState();
  const la = user(uid("la"), { timezone: "America/Los_Angeles" });
  const first = await decide(la, "2026-09-04T23:00:00Z");
  const same = await decide(la, "2026-09-05T01:00:00Z");
  const next = await decide(la, "2026-09-05T19:00:00Z");
  let ok = true;
  if (!first || first.send !== true) {
    ok = false;
    why(`16:00 PDT 4 Sep not sent (${JSON.stringify(first && first.send)})`);
  }
  if (!same || same.send !== false) {
    ok = false;
    why(`18:00 PDT 4 Sep (UTC date 5 Sep) sent again (${JSON.stringify(same && same.send)})`);
  }
  if (!next || next.send !== true) {
    ok = false;
    why(`12:00 PDT 5 Sep not sent (${JSON.stringify(next && next.send)})`);
  }
  for (let rep = 1; rep <= 3; rep++) {
    const state = freshState();
    const u = user(uid(`cc${rep}`));
    const plan = Array.from({ length: 12 }, () => ({ fn: "decide", args: [decideArgs(u, NOW, "checkin", ON, "cc-shared")] }));
    const [p1, p2] = await Promise.all([runProc(dir, state, plan, true), runProc(dir, state, plan, true)]);
    const sends = [...p1, ...p2].filter((x) => x && x.send === true).length;
    if (sends !== 1) {
      ok = false;
      why(`repeat ${rep}: ${sends} sends across 2 processes x 12 calls, want 1`);
    }
  }
  return ok;
});

await r.crit("5 dismissals: three dismissals of checkin stop the check-in, not a tip, and a user without dismissals still gets it", async (why) => {
  freshState();
  const u5 = uid("d5");
  const u6 = uid("d6");
  await bot.recordDismissal(u5, "checkin", new Date("2026-09-02T09:00:00Z"));
  await bot.recordDismissal(u5, "checkin", new Date("2026-09-02T10:00:00Z"));
  await bot.recordDismissal(u5, "checkin", new Date("2026-09-02T11:00:00Z"));
  let ok = true;
  const c5 = await decide(user(u5), NOW);
  if (!isRefusal(c5)) {
    ok = false;
    why(`checkin after three dismissals: ${JSON.stringify(c5)}`);
  }
  const t5 = await decide(user(u5), NOW, "tip");
  if (!t5 || t5.send !== true) {
    ok = false;
    why(`tip after checkin dismissals: ${JSON.stringify(t5)}`);
  }
  const c6 = await decide(user(u6), NOW);
  if (!c6 || c6.send !== true) {
    ok = false;
    why(`control user without dismissals: ${JSON.stringify(c6)}`);
  }
  return ok;
});

await r.crit("6 kill switch: proactiveEnabled false stops sending at once, true resumes in the same process", async (why) => {
  freshState();
  const off = await decide(user(uid("k1")), NOW, "checkin", { proactiveEnabled: false });
  if (!isRefusal(off)) {
    why(`flag false: ${JSON.stringify(off)}`);
    return false;
  }
  const on = await decide(user(uid("k2")), NOW, "checkin", { proactiveEnabled: true });
  if (!on || on.send !== true) {
    why(`flag true after false: ${JSON.stringify(on)}`);
    return false;
  }
  return true;
});

r.print();
