// Checker for Y5 (createSender(config) -> { trySend }: at most 3 reminders per user per local calendar day).
// usage: node y5.mjs <dir containing bot.mjs>
//
// The reference answers come from a small function in this file (refAnswers): per user and local day, a call is sent
// while fewer than 3 have been sent that day. Local days come from Intl.DateTimeFormat (en-CA date parts).
// Expected clock readings, cross-checked with Intl outside this file:
//   Europe/Istanbul is UTC+3 all year: 2026-09-04T21:00Z = 00:00 on 5 Sep; 2026-03-07T21:00Z = 00:00 on 8 Mar.
//   America/New_York is EST (UTC-5) until 2026-03-08 07:00Z, then EDT (UTC-4): 2026-03-08T05:00Z = 00:00 EST on 8 Mar,
//   2026-03-09T03:59:59Z = 23:59:59 EDT on 8 Mar, 2026-03-09T04:00Z = 00:00 EDT on 9 Mar. The 8 Mar day is 23 hours.
// Sqlite cases run a second process (worker-y5.mjs) to prove the state survives a restart and is shared.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "worker-y5.mjs");
const r = new Report();
const IST = "Europe/Istanbul";
const NY = "America/New_York";
const CAP = 3;
const made = [];

let bot = null;
let loadError = null;
try {
  bot = await load(dir);
} catch (e) {
  loadError = e;
}
const needBot = () => {
  if (!bot) throw loadError;
  return bot;
};

const fmts = new Map();
function localDay(iso, tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  const p = {};
  for (const x of fmts.get(tz).formatToParts(new Date(iso))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

// Reference: script is [user, timezone, iso] rows. Returns the expected sent flags in order.
function refAnswers(script) {
  const counts = new Map();
  return script.map(([user, tz, iso]) => {
    const key = `${user}|${localDay(iso, tz)}`;
    const n = counts.get(key) ?? 0;
    if (n < CAP) {
      counts.set(key, n + 1);
      return true;
    }
    return false;
  });
}

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "y5-"));
  made.push(d);
  return d;
};

// Runs one worker process with the given config and calls. Resolves with the RESULT array, or rejects.
function runWorker(config, calls, conc = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, dir, JSON.stringify({ config, calls, conc })], {
      env: { ...process.env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker timeout"));
    }, 120000);
    child.on("close", () => {
      clearTimeout(timer);
      const m = out.match(/RESULT(.*)/);
      if (!m) return reject(new Error("worker printed no result"));
      try {
        resolve(JSON.parse(m[1]));
      } catch {
        reject(new Error("worker result is not JSON"));
      }
    });
  });
}

const sentOf = (res) => res && typeof res === "object" && res.sent === true;
const refusedOf = (res) => res && typeof res === "object" && res.sent === false;

// The fixed 30-call script: user a (Istanbul), users b and c (New York), with the 8 March DST day and midnight edges.
const SCRIPT = [
  ["a", IST, "2026-03-07T20:59:59Z"], ["a", IST, "2026-03-07T21:00:00Z"], ["a", IST, "2026-03-07T21:30:00Z"],
  ["a", IST, "2026-03-07T22:00:00Z"], ["a", IST, "2026-03-07T23:00:00Z"], ["a", IST, "2026-03-08T09:00:00Z"],
  ["a", IST, "2026-03-08T10:00:00Z"], ["a", IST, "2026-03-08T11:00:00Z"], ["a", IST, "2026-03-08T20:59:59Z"],
  ["a", IST, "2026-03-08T21:00:00Z"], ["a", IST, "2026-03-08T21:30:00Z"],
  ["b", NY, "2026-03-08T04:59:59Z"], ["b", NY, "2026-03-08T05:00:00Z"], ["b", NY, "2026-03-08T06:30:00Z"],
  ["b", NY, "2026-03-08T12:00:00Z"], ["b", NY, "2026-03-08T16:00:00Z"], ["b", NY, "2026-03-08T23:59:00Z"],
  ["b", NY, "2026-03-09T03:59:59Z"], ["b", NY, "2026-03-09T04:00:00Z"], ["b", NY, "2026-03-09T04:01:00Z"],
  ["b", NY, "2026-03-09T12:00:00Z"],
  ["c", NY, "2026-03-07T12:00:00Z"], ["c", NY, "2026-03-07T18:00:00Z"], ["c", NY, "2026-03-07T23:00:00Z"],
  ["c", NY, "2026-03-08T04:30:00Z"], ["c", NY, "2026-03-08T05:30:00Z"], ["c", NY, "2026-03-08T13:00:00Z"],
  ["c", NY, "2026-03-09T03:00:00Z"], ["c", NY, "2026-03-09T04:00:00Z"], ["c", NY, "2026-03-09T16:00:00Z"],
];

// Runs the script through one sender object, in order, and returns the sent flags.
async function playScript(sender) {
  const got = [];
  for (const [user, tz, iso] of SCRIPT) {
    const res = await sender.trySend({ user: { id: user, timezone: tz }, now: new Date(iso) });
    got.push(res && res.sent === true);
  }
  return got;
}

// ---------- criteria ----------

await r.crit("1 equivalence: the 30-call script gives the same answers with store memory and store sqlite, equal to the reference", async (note) => {
  const b = needBot();
  const expected = refAnswers(SCRIPT);
  const mem = await playScript(b.createSender({ store: "memory" }));
  const path = join(fresh(), "equiv.db");
  const sql = await playScript(b.createSender({ store: "sqlite", path }));
  let ok = true;
  if (expected.filter(Boolean).length === 0 || expected.filter((x) => !x).length === 0) {
    ok = false;
    note("internal: the script must contain both sent and refused calls");
  }
  for (let i = 0; i < SCRIPT.length; i++) {
    if (mem[i] !== expected[i]) {
      ok = false;
      note(`memory call ${i} (${SCRIPT[i][0]} ${SCRIPT[i][2]}): ${mem[i]}, expected ${expected[i]}`);
    }
    if (sql[i] !== expected[i]) {
      ok = false;
      note(`sqlite call ${i} (${SCRIPT[i][0]} ${SCRIPT[i][2]}): ${sql[i]}, expected ${expected[i]}`);
    }
  }
  return ok;
});

await r.crit("2 memory: a new sender starts empty, and two memory senders do not share state", async (note) => {
  const b = needBot();
  const s1 = b.createSender({ store: "memory" });
  const s2 = b.createSender({ store: "memory" });
  const T = { user: { id: "x", timezone: IST }, now: new Date("2026-09-04T09:00:00Z") };
  const seq1 = [];
  for (let i = 0; i < 4; i++) seq1.push((await s1.trySend(T)).sent);
  const seq2 = [];
  for (let i = 0; i < 4; i++) seq2.push((await s2.trySend(T)).sent);
  const fresh3 = await b.createSender({ store: "memory" }).trySend(T);
  let ok = true;
  if (JSON.stringify(seq1) !== JSON.stringify([true, true, true, false])) {
    ok = false;
    note(`first sender: ${JSON.stringify(seq1)}, expected [true,true,true,false]`);
  }
  if (JSON.stringify(seq2) !== JSON.stringify([true, true, true, false])) {
    ok = false;
    note(`second sender shares state with the first: ${JSON.stringify(seq2)}`);
  }
  if (!fresh3 || fresh3.sent !== true) {
    ok = false;
    note(`a new sender did not start empty: ${JSON.stringify(fresh3)}`);
  }
  return ok;
});

await r.crit("3 sqlite sharing and restart: two senders in one process share a file, and a new process sees earlier sends", async (note) => {
  const b = needBot();
  const path = join(fresh(), "shared.db");
  const s1 = b.createSender({ store: "sqlite", path });
  const s2 = b.createSender({ store: "sqlite", path });
  const P = { user: { id: "p", timezone: IST }, now: new Date("2026-09-04T09:00:00Z") };
  const got = [];
  got.push((await s1.trySend(P)).sent);
  got.push((await s1.trySend(P)).sent);
  got.push((await s2.trySend(P)).sent);
  got.push((await s2.trySend(P)).sent);
  got.push((await s1.trySend(P)).sent);
  let ok = true;
  if (JSON.stringify(got) !== JSON.stringify([true, true, true, false, false])) {
    ok = false;
    note(`two senders on one file: ${JSON.stringify(got)}, expected [true,true,true,false,false]`);
  }
  const restart = await runWorker({ store: "sqlite", path }, [
    { user: { id: "p", timezone: IST }, now: "2026-09-04T10:00:00Z" },
    { user: { id: "q", timezone: IST }, now: "2026-09-04T10:00:00Z" },
  ]);
  if (!Array.isArray(restart) || restart.length !== 2) {
    ok = false;
    note(`restart process gave no two-result array: ${JSON.stringify(restart)}`);
  } else {
    if (!refusedOf(restart[0])) {
      ok = false;
      note(`restarted process for p: ${JSON.stringify(restart[0])}, expected sent false`);
    }
    if (!sentOf(restart[1])) {
      ok = false;
      note(`restarted process for q: ${JSON.stringify(restart[1])}, expected sent true`);
    }
  }
  return ok;
});

await r.crit("4 sqlite concurrency: 2 processes x 12 concurrent calls per user, 5 users, 3 repeats: exactly 3 sent per user each time", async (note) => {
  const USERS = ["c1", "c2", "c3", "c4", "c5"];
  const NOW = "2026-09-04T09:00:00Z";
  let ok = true;
  for (let rep = 0; rep < 3; rep++) {
    const path = join(fresh(), `race${rep}.db`);
    const config = { store: "sqlite", path };
    const calls = [];
    for (const u of USERS) for (let k = 0; k < 12; k++) calls.push({ user: { id: u, timezone: IST }, now: NOW });
    const runs = await Promise.all([runWorker(config, calls, true), runWorker(config, calls, true)]);
    const sent = Object.fromEntries(USERS.map((u) => [u, 0]));
    runs.forEach((res, p) => {
      if (!Array.isArray(res) || res.length !== calls.length) {
        ok = false;
        note(`repeat ${rep} process ${p}: no complete result array`);
        return;
      }
      res.forEach((got, idx) => {
        if (sentOf(got)) sent[calls[idx].user.id]++;
        else if (!refusedOf(got)) {
          ok = false;
          note(`repeat ${rep}: unexpected ${JSON.stringify(got)}`);
        }
      });
    });
    for (const u of USERS) {
      if (sent[u] !== CAP) {
        ok = false;
        note(`repeat ${rep} user ${u}: ${sent[u]} sent, expected ${CAP}`);
      }
    }
    // The file itself must say the day is full: one more call for each user is refused in a new process.
    const after = await runWorker(config, USERS.map((u) => ({ user: { id: u, timezone: IST }, now: NOW })));
    if (!Array.isArray(after) || after.some((x) => !refusedOf(x))) {
      ok = false;
      note(`repeat ${rep}: a later process still sent: ${JSON.stringify(after)}`);
    }
  }
  return ok;
});

// Day-boundary script: Istanbul midnight (21:00Z) and the New York DST day of 8 March 2026 (23 hours).
const DAYS = [
  ["d1", IST, "2026-09-04T20:59:59Z", true],
  ["d1", IST, "2026-09-04T20:59:59Z", true],
  ["d1", IST, "2026-09-04T20:59:59Z", true],
  ["d1", IST, "2026-09-04T20:59:59Z", false],
  ["d1", IST, "2026-09-04T20:59:59Z", false],
  ["d1", IST, "2026-09-04T21:00:00Z", true],
  ["d1", IST, "2026-09-04T21:00:00Z", true],
  ["d1", IST, "2026-09-04T21:00:00Z", true],
  ["d1", IST, "2026-09-04T21:00:00Z", false],
  ["n1", NY, "2026-03-08T05:00:00Z", true],
  ["n1", NY, "2026-03-08T12:00:00Z", true],
  ["n1", NY, "2026-03-09T03:59:59Z", true],
  ["n1", NY, "2026-03-09T03:59:59Z", false],
  ["n1", NY, "2026-03-09T04:00:00Z", true],
  ["n1", NY, "2026-03-09T04:00:00Z", true],
  ["n1", NY, "2026-03-09T04:00:00Z", true],
  ["n1", NY, "2026-03-09T04:00:00Z", false],
];

async function checkDays(note, sender, label) {
  let ok = true;
  for (let i = 0; i < DAYS.length; i++) {
    const [user, tz, iso, want] = DAYS[i];
    const res = await sender.trySend({ user: { id: user, timezone: tz }, now: new Date(iso) });
    if (!res || res.sent !== want) {
      ok = false;
      note(`${label} call ${i} (${user} ${iso}): ${JSON.stringify(res)}, expected sent ${want}`);
    }
  }
  return ok;
}

await r.crit("5 local day: Istanbul midnight is 21:00Z, the New York DST day is 23 hours, refused calls record nothing", async (note) => {
  const b = needBot();
  const memOk = await checkDays(note, b.createSender({ store: "memory" }), "memory");
  const sqlOk = await checkDays(note, b.createSender({ store: "sqlite", path: join(fresh(), "days.db") }), "sqlite");
  return memOk && sqlOk;
});

await r.crit("6 bad config: an unknown store value throws an Error naming store, memory ignores a path", async (note) => {
  const b = needBot();
  let ok = true;
  // Only the frozen prompt's "any other store value" is pinned. The prompt does not say what a missing store or an
  // empty string does, so neither is checked here.
  const bad = [{ store: "redis" }, { store: "postgres" }];
  for (const cfg of bad) {
    try {
      await Promise.resolve().then(() => b.createSender(cfg));
      ok = false;
      note(`createSender(${JSON.stringify(cfg)}) did not throw`);
    } catch (e) {
      if (!(e instanceof Error) || !/store/i.test(e.message)) {
        ok = false;
        note(`createSender(${JSON.stringify(cfg)}) threw "${e && e.message}", expected an Error mentioning store`);
      }
    }
  }
  try {
    const s = b.createSender({ store: "memory", path: "/nonexistent-dir-y5/x.db" });
    const res = await s.trySend({ user: { id: "m", timezone: IST }, now: new Date("2026-09-04T09:00:00Z") });
    if (!res || res.sent !== true) {
      ok = false;
      note(`memory with a path: ${JSON.stringify(res)}, expected sent true`);
    }
  } catch (e) {
    ok = false;
    note(`memory with a path threw: ${e && e.message}`);
  }
  return ok;
});

for (const d of made) rmSync(d, { recursive: true, force: true });
r.print();
