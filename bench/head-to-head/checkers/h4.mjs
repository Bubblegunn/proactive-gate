// Checker for H4 (deliver: per-user daily cap of 5, idempotent per eventId, crash-safe, local midnight).
// usage: node h4.mjs <dir containing bot.mjs>
// Every case runs against fresh state (a new temp STATE_DIR) and counts sends from the log file that the
// worker writes, never from the bot's return values.
//
// Derivation of the expected instants (all users are in Europe/Istanbul, UTC+3, no daylight saving since 2016):
//   2026-09-04T09:00:00Z = 12:00 on 4 Sep local        (a normal mid-day instant)
//   2026-09-04T00:00:00Z = 03:00 on 4 Sep local        (UTC midnight is not local midnight)
//   2026-09-04T20:00:00Z = 23:00 on 4 Sep local
//   2026-09-04T20:59:59Z = 23:59:59 on 4 Sep local     (last second of the local day)
//   2026-09-04T21:00:00Z = 00:00 on 5 Sep local        (first instant of the next local day)
//   2026-09-06T09:00:00Z = 12:00 on 6 Sep local        (two days after the first instant)
// The cross-check of these clock readings was made with Intl.DateTimeFormat outside this file.
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Report } from "./lib.mjs";

const dir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "worker4.mjs");
const TZ = "Europe/Istanbul";
const T0 = "2026-09-04T09:00:00Z";
const T2D = "2026-09-06T09:00:00Z";
const made = [];

const r = new Report();

// Starts one worker process per plan. plans[i] = {entries, crashEventId?, seq?}. Resolves with one entry per
// process: the parsed RESULT array, or null when the process was killed or printed no result.
function runWorkers(botdir, stateDir, logFile, plans, opts = {}) {
  return Promise.all(
    plans.map(
      (p) =>
        new Promise((resolve) => {
          const args = [worker, botdir, stateDir, logFile, JSON.stringify(p.entries)];
          if (p.crashEventId !== undefined) args.push(p.crashEventId);
          const seq = p.seq ?? opts.seq ?? false;
          const child = spawn(process.execPath, args, {
            env: { ...process.env, STATE_DIR: stateDir, SEQ: seq ? "1" : "0" },
          });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", () => {});
          const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
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
        }),
    ),
  );
}

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "h4-"));
  made.push(d);
  return { state: join(d, "state"), log: join(d, "sends.log") };
};

// Lines the worker appended, as "userId|eventId". A missing file means no sends.
const sendLines = (log) => {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter((l) => l.length > 0);
};
const sentFor = (log, userId) => sendLines(log).filter((l) => l.startsWith(userId + "|"));

const user = (id) => ({ id, timezone: TZ });
const entry = (id, eventId, now) => ({ user: user(id), eventId, now });
const isSent = (res) => res && typeof res === "object" && res.sent === true && res.reason === null;
const isRefusal = (res, re) =>
  res && typeof res === "object" && res.sent === false && typeof res.reason === "string" && re.test(res.reason);

// ---------- criteria ----------

await r.crit("1 concurrent cap: 50 processes, 4 users, 3 events each per process, 5 sends per user and day", async (note) => {
  const { state, log } = fresh();
  const users = ["u1", "u2", "u3", "u4"];
  const plans = [];
  for (let k = 0; k < 50; k++) {
    const entries = [];
    for (const u of users) for (let i = 0; i < 3; i++) entries.push(entry(u, `w${k}-${u}-${i}`, T0));
    plans.push({ entries });
  }
  const results = await runWorkers(dir, state, log, plans);
  let ok = true;
  results.forEach((res, k) => {
    if (!Array.isArray(res) || res.length !== 12) {
      ok = false;
      note(`process ${k} gave no 12-result array`);
    }
  });
  if (!ok) return false;
  for (const u of users) {
    const lines = sentFor(log, u).length;
    if (lines !== 5) {
      ok = false;
      note(`user ${u}: ${lines} log lines, expected 5`);
    }
    let trueCount = 0;
    results.forEach((res, k) => {
      plans[k].entries.forEach((e, idx) => {
        if (e.user.id !== u) return;
        const got = res[idx];
        if (isSent(got)) trueCount++;
        else if (!isRefusal(got, /daily cap/i)) {
          ok = false;
          note(`user ${u} entry ${e.eventId}: refusal without "daily cap": ${JSON.stringify(got)}`);
        }
      });
    });
    if (trueCount !== 5) {
      ok = false;
      note(`user ${u}: ${trueCount} results sent true, expected 5`);
    }
  }
  return ok;
});

await r.crit("2 concurrent redelivery: 10 processes deliver one new event at once, one send", async (note) => {
  const { state, log } = fresh();
  const plans = Array.from({ length: 10 }, () => ({ entries: [entry("x", "E1", T0)] }));
  const results = await runWorkers(dir, state, log, plans);
  const lines = sentFor(log, "x").filter((l) => l === "x|E1").length;
  if (lines !== 1) note(`E1 log lines: ${lines}, expected 1`);
  let trues = 0;
  let others = 0;
  for (const res of results) {
    if (!Array.isArray(res)) {
      note("a process gave no result");
      return false;
    }
    if (isSent(res[0])) trues++;
    else if (isRefusal(res[0], /already delivered/i)) others++;
    else note(`unexpected result ${JSON.stringify(res[0])}`);
  }
  if (trues !== 1) note(`sent true results: ${trues}, expected 1`);
  if (others !== 9) note(`"already delivered" refusals: ${others}, expected 9`);
  return lines === 1 && trues === 1 && others === 9;
});

await r.crit("3 redelivery later: same instant and two days later, no new send, reason already delivered", async (note) => {
  const { state, log } = fresh();
  await runWorkers(dir, state, log, [{ entries: [entry("x", "E1", T0)] }]);
  const before = sendLines(log).length;
  const results = await runWorkers(dir, state, log, [
    { entries: [entry("x", "E1", T0)] },
    { entries: [entry("x", "E1", T2D)] },
  ]);
  let ok = true;
  if (sendLines(log).length !== before) {
    ok = false;
    note(`log grew from ${before} to ${sendLines(log).length}`);
  }
  results.forEach((res, k) => {
    if (!Array.isArray(res) || !isRefusal(res[0], /already delivered/i)) {
      ok = false;
      note(`redelivery ${k}: ${JSON.stringify(res)}`);
    }
  });
  return ok;
});

await r.crit("4 crash mid-send: killed process leaves one log line, a later redelivery sends nothing", async (note) => {
  const { state, log } = fresh();
  const crashed = await runWorkers(dir, state, log, [{ entries: [entry("c", "C1", T0)], crashEventId: "C1" }]);
  if (crashed[0] !== null) note("the crashing process still returned a result");
  const lines = sentFor(log, "c").filter((l) => l === "c|C1").length;
  if (lines !== 1) note(`C1 log lines after crash: ${lines}, expected 1`);
  const again = await runWorkers(dir, state, log, [{ entries: [entry("c", "C1", T0)] }]);
  const after = sentFor(log, "c").filter((l) => l === "c|C1").length;
  if (after !== 1) note(`C1 log lines after redelivery: ${after}, expected 1`);
  const res = again[0] && again[0][0];
  if (!isRefusal(res, /already delivered/i)) note(`redelivery result: ${JSON.stringify(res)}`);
  return lines === 1 && after === 1 && isRefusal(res, /already delivered/i);
});

await r.crit("5 interrupted send counts: after the crash on C1, four more sends and two daily cap refusals", async (note) => {
  const { state, log } = fresh();
  await runWorkers(dir, state, log, [{ entries: [entry("c", "C1", T0)], crashEventId: "C1" }]);
  const six = ["C2", "C3", "C4", "C5", "C6", "C7"].map((id) => entry("c", id, T0));
  const [res] = await runWorkers(dir, state, log, [{ entries: six, seq: true }]);
  if (!Array.isArray(res) || res.length !== 6) {
    note("the six-event process gave no six-result array");
    return false;
  }
  const lines = sentFor(log, "c").length;
  if (lines !== 5) note(`user c log lines for the day: ${lines}, expected 5 (C1 plus four)`);
  let ok = lines === 5;
  res.forEach((got, idx) => {
    const want = idx < 4 ? "sent" : "cap";
    if (want === "sent" && !isSent(got)) {
      ok = false;
      note(`${six[idx].eventId}: expected sent, got ${JSON.stringify(got)}`);
    }
    if (want === "cap" && !isRefusal(got, /daily cap/i)) {
      ok = false;
      note(`${six[idx].eventId}: expected daily cap, got ${JSON.stringify(got)}`);
    }
  });
  return ok;
});

await r.crit("6 local midnight: user m resets at 00:00 Istanbul, UTC midnight does not reset user n", async (note) => {
  const { state, log } = fresh();
  const m = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => entry("m", id, "2026-09-04T20:59:59Z"));
  m.push(entry("m", "m7", "2026-09-04T21:00:00Z"));
  const n1 = ["n1", "n2", "n3"].map((id) => entry("n", id, "2026-09-04T00:00:00Z"));
  const n2 = ["n4", "n5", "n6", "n7"].map((id) => entry("n", id, "2026-09-04T20:00:00Z"));
  const [res] = await runWorkers(dir, state, log, [{ entries: [...m, ...n1, ...n2], seq: true }]);
  if (!Array.isArray(res) || res.length !== m.length + n1.length + n2.length) {
    note("the sequential process gave no complete result array");
    return false;
  }
  let ok = true;
  const mRes = res.slice(0, 7);
  mRes.forEach((got, idx) => {
    const want = idx < 5 || idx === 6 ? "sent" : "cap";
    if (want === "sent" && !isSent(got)) {
      ok = false;
      note(`m${idx + 1}: expected sent, got ${JSON.stringify(got)}`);
    }
    if (want === "cap" && !isRefusal(got, /daily cap/i)) {
      ok = false;
      note(`m${idx + 1}: expected daily cap, got ${JSON.stringify(got)}`);
    }
  });
  const nSent = res.slice(10).filter(isSent).length;
  if (nSent !== 2) {
    ok = false;
    note(`user n: ${nSent} of the four evening events sent, expected 2`);
  }
  if (sentFor(log, "m").length !== 6) {
    ok = false;
    note(`user m log lines: ${sentFor(log, "m").length}, expected 6`);
  }
  return ok;
});

for (const d of made) rmSync(d, { recursive: true, force: true });
r.print();
