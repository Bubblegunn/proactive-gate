// Checker for X1 (notify: channel preferences and order, quiet hours, daily cap for non-security, fallback on
// throw, concurrency across processes, restart). usage: node x1.mjs <dir containing bot.mjs>
// Every criterion runs against fresh state (a new temp STATE_DIR). Deliveries and attempts are counted from the
// log file the worker writes (one line per deliver call), never from the bot's return values alone.
//
// Expected clock readings. Each one was derived from the fixed offset and re-checked with a separate
// Intl.DateTimeFormat script (not copied from any reference):
//   Europe/Istanbul is UTC+3 with no daylight saving. Quiet hours are 22:00 to 08:00 local (end exclusive).
//     2026-09-04T09:00:00Z = 12:00 on 4 Sep (daytime). 2026-09-04T18:59:00Z = 21:59 (delivered).
//     2026-09-04T19:00:00Z = 22:00 (quiet). 2026-09-05T04:59:00Z = 07:59 (quiet).
//     2026-09-05T05:00:00Z = 08:00 (delivered). 2026-09-05T00:00:00Z = 03:00 on 5 Sep (security delivered).
//     2026-09-05T06:00:00Z = 09:00 on 5 Sep (a new local day).
//   America/New_York: EST (UTC-5) until 2026-03-08 07:00Z, EDT (UTC-4) until 2026-11-01 06:00Z, EST after.
//     2026-03-08T11:59:00Z = 07:59 EDT (quiet); 2026-03-08T12:00:00Z = 08:00 EDT (delivered).
//     2026-11-01T12:59:00Z = 07:59 EST (quiet); 2026-11-01T13:00:00Z = 08:00 EST (delivered).
//     2026-11-01T05:30:00Z = 01:30 EDT and 2026-11-01T06:30:00Z = 01:30 EST: both quiet.
//   America/Los_Angeles is PDT (UTC-7) on 3 and 4 Sep 2026. 2026-09-03T23:00:00Z = 16:00 on 3 Sep,
//     2026-09-04T00:00:00Z = 17:00 on 3 Sep, 2026-09-04T02:00:00Z = 19:00 on 3 Sep, 2026-09-04T03:00:00Z = 20:00 on 3 Sep
//     (all one local day although the UTC date changes), 2026-09-04T16:00:00Z = 09:00 on 4 Sep (new local day).
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Report } from "./lib.mjs";

const dir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "worker5.mjs");
const IST = "Europe/Istanbul";
const NY = "America/New_York";
const LA = "America/Los_Angeles";
const DAY = "2026-09-04T09:00:00Z";
const ACT = "activity";
const made = [];
const r = new Report();

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "x1-"));
  made.push(d);
  return { state: join(d, "state"), log: join(d, "sends.log") };
};

// Runs one worker process with the plan. Resolves with the parsed result array, or null when the process
// was killed, timed out, or printed no result.
function runWorker(ctx, plan, conc = false) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, dir, ctx.state, ctx.log, JSON.stringify(plan)], {
      env: { ...process.env, STATE_DIR: ctx.state, CONC: conc ? "1" : "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("error", () => resolve(null));
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/RESULT(.*)/);
      if (!m) return resolve(null);
      try {
        resolve(JSON.parse(m[1]));
      } catch {
        resolve(null);
      }
    });
  });
}

const readLog = (log) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0) : []);
const U = (id, timezone, preferences = {}) => ({ id, timezone, preferences });
const N = (id, category, channels = ["email", "push", "sms"]) => ({ id, category, channels });

const blocked = (g, re) =>
  !!g && typeof g === "object" && g.delivered === false && g.channel === null && typeof g.reason === "string" && re.test(g.reason);
const WANT = {
  ok: (g) => !!g && typeof g === "object" && g.delivered === true && typeof g.channel === "string" && g.reason === null,
  quiet: (g) => blocked(g, /quiet hours/i),
  cap: (g) => blocked(g, /daily cap/i),
  optout: (g) => blocked(g, /opted out/i),
  failed: (g) => blocked(g, /failed/i),
};

// cases: {label, user, notif, now, want, channel?, failChannels?, attempts?}. All cases run in one worker
// process, in list order, on one state. attempts (when given) is the exact list of channels deliver was called on.
async function runCases(cases, note) {
  const ctx = fresh();
  const plan = cases.map((c) => ({
    fn: "notify",
    user: c.user,
    notification: c.notif,
    now: c.now,
    failChannels: c.failChannels ?? [],
  }));
  const res = await runWorker(ctx, plan);
  if (!Array.isArray(res) || res.length !== plan.length) {
    note("the worker gave no complete result array");
    return false;
  }
  const lines = readLog(ctx.log);
  let ok = true;
  cases.forEach((c, k) => {
    const g = res[k];
    if (!WANT[c.want](g)) {
      ok = false;
      note(`${c.label}: expected ${c.want}, got ${JSON.stringify(g)}`);
    } else if (c.channel && g.channel !== c.channel) {
      ok = false;
      note(`${c.label}: channel ${g.channel}, expected ${c.channel}`);
    }
    if (c.attempts) {
      const got = lines.filter((l) => l.startsWith(`${c.user.id}|${c.notif.id}|`)).map((l) => l.split("|")[2]);
      if (JSON.stringify(got) !== JSON.stringify(c.attempts)) {
        ok = false;
        note(`${c.label}: attempts ${JSON.stringify(got)}, expected ${JSON.stringify(c.attempts)}`);
      }
    }
  });
  return ok;
}

// quiet-hours case helper: an ok case is delivered on email (first listed channel, no preference set)
const Q = (id, timezone, now, want, category = ACT) => ({
  label: `${id} ${timezone} ${now} ${category}`,
  user: U(id, timezone),
  notif: N(`n-${id}`, category),
  now,
  want,
  channel: want === "ok" ? "email" : undefined,
  attempts: want === "ok" ? ["email"] : [],
});

// ---------- criteria ----------

await r.crit("1 order: a switched-off channel is skipped, the list order is kept, all channels off is opted out", async (note) =>
  runCases(
    [
      { label: "email off goes to push", user: U("p1", IST, { email: false }), notif: N("m1", ACT), now: DAY, want: "ok", channel: "push", attempts: ["push"] },
      { label: "email and push off go to sms", user: U("p2", IST, { email: false, push: false }), notif: N("m2", ACT), now: DAY, want: "ok", channel: "sms", attempts: ["sms"] },
      { label: "all off is opted out", user: U("p3", IST, { email: false, push: false, sms: false }), notif: N("m3", ACT), now: DAY, want: "optout", attempts: [] },
      { label: "missing key means allowed", user: U("p4", IST, {}), notif: N("m4", ACT, ["email"]), now: DAY, want: "ok", channel: "email", attempts: ["email"] },
      { label: "list order sms before email", user: U("p5", IST, {}), notif: N("m5", ACT, ["sms", "email"]), now: DAY, want: "ok", channel: "sms", attempts: ["sms"] },
    ],
    note,
  ),
);

await r.crit("2 quiet hours: 22:00 to 08:00 in the user's own zone (Istanbul, New York DST edges), security exempt", async (note) =>
  runCases(
    [
      Q("ist-a", IST, "2026-09-04T18:59:00Z", "ok"),
      Q("ist-b", IST, "2026-09-04T19:00:00Z", "quiet"),
      Q("ist-c", IST, "2026-09-05T04:59:00Z", "quiet"),
      Q("ist-d", IST, "2026-09-05T05:00:00Z", "ok"),
      Q("ist-e", IST, "2026-09-04T19:00:00Z", "quiet", "marketing"),
      Q("ist-f", IST, "2026-09-05T00:00:00Z", "ok", "security"),
      Q("ny-a", NY, "2026-03-08T11:59:00Z", "quiet"),
      Q("ny-b", NY, "2026-03-08T12:00:00Z", "ok"),
      Q("ny-c", NY, "2026-11-01T12:59:00Z", "quiet"),
      Q("ny-d", NY, "2026-11-01T13:00:00Z", "ok"),
      Q("ny-e", NY, "2026-11-01T05:30:00Z", "quiet"),
      Q("ny-f", NY, "2026-11-01T06:30:00Z", "quiet"),
    ],
    note,
  ),
);

await r.crit("3 daily cap: 3 per local day for non-security, security neither counted nor stopped, UTC midnight does not reset", async (note) =>
  runCases(
    [
      { label: "cap-a 1", user: U("cap-a", IST), notif: N("ca1", ACT), now: DAY, want: "ok" },
      { label: "cap-a 2", user: U("cap-a", IST), notif: N("ca2", ACT), now: DAY, want: "ok" },
      { label: "cap-a 3", user: U("cap-a", IST), notif: N("ca3", ACT), now: DAY, want: "ok" },
      { label: "cap-a 4 blocked", user: U("cap-a", IST), notif: N("ca4", ACT), now: DAY, want: "cap", attempts: [] },
      { label: "cap-a security not stopped", user: U("cap-a", IST), notif: N("ca5", "security"), now: DAY, want: "ok" },
      { label: "cap-a 5 still blocked", user: U("cap-a", IST), notif: N("ca6", ACT), now: DAY, want: "cap", attempts: [] },
      { label: "cap-a next local day", user: U("cap-a", IST), notif: N("ca7", ACT), now: "2026-09-05T06:00:00Z", want: "ok" },
      { label: "cap-s security x5", user: U("cap-s", IST), notif: N("cs1", "security"), now: DAY, want: "ok" },
      { label: "cap-s security x2", user: U("cap-s", IST), notif: N("cs2", "security"), now: DAY, want: "ok" },
      { label: "cap-s security x3", user: U("cap-s", IST), notif: N("cs3", "security"), now: DAY, want: "ok" },
      { label: "cap-s security x4", user: U("cap-s", IST), notif: N("cs4", "security"), now: DAY, want: "ok" },
      { label: "cap-s security x5b", user: U("cap-s", IST), notif: N("cs5", "security"), now: DAY, want: "ok" },
      { label: "cap-s activity 1", user: U("cap-s", IST), notif: N("cs6", ACT), now: DAY, want: "ok" },
      { label: "cap-s activity 2", user: U("cap-s", IST), notif: N("cs7", ACT), now: DAY, want: "ok" },
      { label: "cap-s activity 3", user: U("cap-s", IST), notif: N("cs8", ACT), now: DAY, want: "ok" },
      { label: "cap-s activity 4 blocked", user: U("cap-s", IST), notif: N("cs9", ACT), now: DAY, want: "cap" },
      { label: "cap-m marketing 1", user: U("cap-m", IST), notif: N("cm1", "marketing"), now: DAY, want: "ok" },
      { label: "cap-m marketing 2", user: U("cap-m", IST), notif: N("cm2", "marketing"), now: DAY, want: "ok" },
      { label: "cap-m marketing 3", user: U("cap-m", IST), notif: N("cm3", "marketing"), now: DAY, want: "ok" },
      { label: "cap-m activity after 3 marketing", user: U("cap-m", IST), notif: N("cm4", ACT), now: DAY, want: "cap" },
      { label: "cap-la 16:00 PDT", user: U("cap-la", LA), notif: N("cl1", ACT), now: "2026-09-03T23:00:00Z", want: "ok" },
      { label: "cap-la 17:00 PDT", user: U("cap-la", LA), notif: N("cl2", ACT), now: "2026-09-04T00:00:00Z", want: "ok" },
      { label: "cap-la 19:00 PDT", user: U("cap-la", LA), notif: N("cl3", ACT), now: "2026-09-04T02:00:00Z", want: "ok" },
      { label: "cap-la 20:00 PDT blocked (same local day)", user: U("cap-la", LA), notif: N("cl4", ACT), now: "2026-09-04T03:00:00Z", want: "cap" },
      { label: "cap-la 09:00 PDT next day", user: U("cap-la", LA), notif: N("cl5", ACT), now: "2026-09-04T16:00:00Z", want: "ok" },
    ],
    note,
  ),
);

await r.crit("4 fallback: a throw moves to the next channel, failed notifications do not use the cap, switched-off channels are not attempted", async (note) => {
  const cases = [
    { label: "email throws, push delivers", user: U("f1", IST), notif: N("g1", ACT, ["email", "push"]), now: DAY, failChannels: ["email"], want: "ok", channel: "push", attempts: ["email", "push"] },
    { label: "every channel throws", user: U("f2", IST), notif: N("g2", ACT, ["email", "push"]), now: DAY, failChannels: ["email", "push"], want: "failed", attempts: ["email", "push"] },
    { label: "switched-off email not attempted, push throws once", user: U("f3", IST, { email: false }), notif: N("g3", ACT, ["email", "push"]), now: DAY, failChannels: ["push"], want: "failed", attempts: ["push"] },
    { label: "single channel throws", user: U("f5", IST), notif: N("g5", ACT, ["sms"]), now: DAY, failChannels: ["sms"], want: "failed", attempts: ["sms"] },
  ];
  for (let k = 1; k <= 5; k++) cases.push({ label: `failed notification ${k}`, user: U("f4", IST), notif: N(`gf${k}`, ACT, ["email", "push"]), now: DAY, failChannels: ["email", "push"], want: "failed" });
  for (let k = 1; k <= 3; k++) cases.push({ label: `after failures, delivery ${k}`, user: U("f4", IST), notif: N(`h${k}`, ACT, ["email"]), now: DAY, want: "ok" });
  cases.push({ label: "after failures, 4th blocked", user: U("f4", IST), notif: N("h4", ACT, ["email"]), now: DAY, want: "cap" });
  return runCases(cases, note);
});

await r.crit("5 concurrency: 2 processes x 12 concurrent calls per user, 5 users, 3 repeats: exactly 3 deliveries per user", async (note) => {
  const users = ["k1", "k2", "k3", "k4", "k5"];
  let ok = true;
  for (let rep = 0; rep < 3; rep++) {
    const ctx = fresh();
    const plans = [0, 1].map((p) => {
      const items = [];
      for (const uid of users)
        for (let i = 0; i < 12; i++)
          items.push({ fn: "notify", user: U(uid, IST), notification: N(`c${rep}-${p}-${uid}-${i}`, ACT, ["email"]), now: DAY, failChannels: [] });
      return items;
    });
    const results = await Promise.all(plans.map((plan) => runWorker(ctx, plan, true)));
    if (results.some((res, p) => !Array.isArray(res) || res.length !== plans[p].length)) {
      note(`repeat ${rep}: a process gave no complete result array`);
      return false;
    }
    const lines = readLog(ctx.log);
    for (const uid of users) {
      const deliveries = lines.filter((l) => l.startsWith(`${uid}|`)).length;
      if (deliveries !== 3) {
        ok = false;
        note(`repeat ${rep} user ${uid}: ${deliveries} deliveries in the log, expected 3`);
      }
      let sent = 0;
      results.forEach((res, p) =>
        plans[p].forEach((item, idx) => {
          if (item.user.id !== uid) return;
          if (WANT.ok(res[idx])) sent++;
          else if (!WANT.cap(res[idx])) {
            ok = false;
            note(`repeat ${rep} user ${uid}: unexpected result ${JSON.stringify(res[idx])}`);
          }
        }),
      );
      if (sent !== 3) {
        ok = false;
        note(`repeat ${rep} user ${uid}: ${sent} results delivered, expected 3`);
      }
    }
  }
  return ok;
});

await r.crit("6 restart and reasons: state survives a new process; opted out, quiet hours, daily cap and failed each carry their word", async (note) => {
  const ctx = fresh();
  const first = await runWorker(ctx, [
    { fn: "notify", user: U("r", IST), notification: N("r1", ACT, ["email"]), now: DAY, failChannels: [] },
    { fn: "notify", user: U("r", IST), notification: N("r2", ACT, ["email"]), now: DAY, failChannels: [] },
  ]);
  const second = await runWorker(ctx, [
    { fn: "notify", user: U("r", IST), notification: N("r3", ACT, ["email"]), now: DAY, failChannels: [] },
    { fn: "notify", user: U("r", IST), notification: N("r4", ACT, ["email"]), now: DAY, failChannels: [] },
    { fn: "notify", user: U("o", IST, { email: false }), notification: N("o1", ACT, ["email"]), now: DAY, failChannels: [] },
    { fn: "notify", user: U("q", IST), notification: N("q1", ACT, ["email"]), now: "2026-09-04T19:00:00Z", failChannels: [] },
    { fn: "notify", user: U("f", IST), notification: N("f1", ACT, ["email"]), now: DAY, failChannels: ["email"] },
  ]);
  if (!Array.isArray(first) || first.length !== 2 || !Array.isArray(second) || second.length !== 5) {
    note("a process gave no complete result array");
    return false;
  }
  let ok = true;
  first.forEach((g, k) => {
    if (!WANT.ok(g)) {
      ok = false;
      note(`process 1 call ${k + 1}: expected ok, got ${JSON.stringify(g)}`);
    }
  });
  const wants = ["ok", "cap", "optout", "quiet", "failed"];
  wants.forEach((w, k) => {
    if (!WANT[w](second[k])) {
      ok = false;
      note(`process 2 call ${k + 1}: expected ${w}, got ${JSON.stringify(second[k])}`);
    }
  });
  const lines = readLog(ctx.log);
  const rLines = lines.filter((l) => l.startsWith("r|")).length;
  if (rLines !== 3) {
    ok = false;
    note(`user r deliveries: ${rLines}, expected 3 (two in process 1, one in process 2)`);
  }
  if (lines.some((l) => l.startsWith("o|") || l.startsWith("q|"))) {
    ok = false;
    note("opted-out or quiet-hours user reached deliver");
  }
  return ok;
});

for (const d of made) rmSync(d, { recursive: true, force: true });
r.print();
