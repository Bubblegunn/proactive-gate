// Checker for Y6 (one policy, three programs: decide.mjs, decide.py, main.go; each reads policy.json at run time).
// usage: node y6.mjs <work folder>   (the folder holds the agent's programs and policy.json)
//
// The checker writes cases.json (60 generated cases) and directed.json (edge cases), runs the three programs on them with
// the policy in place, and compares every outcome with a reference written in this file. For the policy swap and the
// null-rule policies it overwrites policy.json and restores the original bytes at the end.
//
// Clock readings for the directed cases were cross-checked with Intl.DateTimeFormat (outside this file):
//   Europe/Istanbul UTC+3: 2026-03-07T19:00Z = 22:00, 18:59Z = 21:59, 04:00Z = 07:00, 21:00Z = 00:00 on 8 Mar.
//   Asia/Kolkata UTC+5:30: 2026-03-07T16:30Z = 22:00, 16:29Z = 21:59, 2026-03-08T01:30Z = 07:00, 01:29Z = 06:59.
//   Asia/Kathmandu UTC+5:45: 2026-03-07T16:15Z = 22:00, 16:14Z = 21:59, 2026-03-08T01:15Z = 07:00, 01:14Z = 06:59,
//     18:15Z = 00:00 on 8 Mar.
//   America/New_York on 2026-11-01: 05:30Z = 01:30 EDT (first pass), 06:30Z = 01:30 EST (second pass),
//     11:59Z = 06:59 EST (quiet), 12:00Z = 07:00 EST (not quiet).
//   America/New_York on 2026-03-08 (spring forward at 07:00Z): 10:59Z = 06:59 EDT (quiet), 11:00Z = 07:00 EDT (not quiet).
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Report } from "./lib.mjs";

const work = process.argv[2];
const POLICY_PATH = join(work, "policy.json");
const original = existsSync(POLICY_PATH) ? readFileSync(POLICY_PATH) : null;
const r = new Report();

const POLICY_A = { quietHours: { start: "22:00", end: "07:00" }, dailyCap: 3, requireConsent: true };
const POLICY_B = { quietHours: { start: "08:00", end: "18:00" }, dailyCap: 2, requireConsent: false };
const POLICY_N1 = { quietHours: null, dailyCap: 2, requireConsent: true };
const POLICY_N2 = { quietHours: { start: "22:00", end: "07:00" }, dailyCap: null, requireConsent: false };

const PROGRAMS = [
  { name: "node", cmd: process.execPath, args: ["decide.mjs"] },
  { name: "python", cmd: "python3", args: ["decide.py"] },
  { name: "go", cmd: "go", args: ["run", "."] },
];

const fmts = new Map();
function local(when, tz) {
  if (!fmts.has(tz)) {
    fmts.set(
      tz,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }),
    );
  }
  const p = {};
  for (const x of fmts.get(tz).formatToParts(new Date(when))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

const hm = (s) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};
// start inclusive, end exclusive; a window whose start is after its end crosses midnight
function inQuiet(minute, q) {
  const s = hm(q.start);
  const e = hm(q.end);
  return s < e ? minute >= s && minute < e : minute >= s || minute < e;
}

// Reference: the first rule that applies decides; sent calls count toward the user's day in the case's timezone.
function refOutcomes(cases, policy) {
  const counts = new Map();
  return cases.map((c, index) => {
    const { day, minute } = local(c.at, c.timezone);
    let outcome;
    if (policy.requireConsent && !c.consent) outcome = "consent";
    else if (policy.quietHours && c.priority !== "critical" && inQuiet(minute, policy.quietHours)) outcome = "quiet";
    else {
      const key = `${c.userId}|${day}`;
      const n = counts.get(key) ?? 0;
      if (policy.dailyCap !== null && n >= policy.dailyCap) outcome = "cap";
      else {
        outcome = "sent";
        counts.set(key, n + 1);
      }
    }
    return { index, outcome };
  });
}

// ---------- generated cases: 60 over four users, 7 to 10 March 2026 (includes the New York spring forward) ----------
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const USERS = [
  { id: "u-ist", tz: "Europe/Istanbul" },
  { id: "u-ny", tz: "America/New_York" },
  { id: "u-kol", tz: "Asia/Kolkata" },
  { id: "u-ktm", tz: "Asia/Kathmandu" },
];
const WINDOW_START = Date.UTC(2026, 2, 7);
const WINDOW_END = Date.UTC(2026, 2, 11);
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");

// Quiet-hour boundary instants per user (local 22:00 and local 07:00), found by scanning each minute of the window.
const boundaries = USERS.map((u) => {
  const list = [];
  for (let ms = WINDOW_START; ms < WINDOW_END; ms += 60000) {
    const { minute } = local(ms, u.tz);
    if (minute === 22 * 60 || minute === 7 * 60) list.push(ms);
  }
  return list;
});

const rng = mulberry32(20261021);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const randomMs = () => WINDOW_START + Math.floor((rng() * (WINDOW_END - WINDOW_START)) / 60000) * 60000;
const CASES = [];
function add(user, ms) {
  CASES.push({
    userId: user.id,
    timezone: user.tz,
    consent: rng() >= 0.1,
    at: iso(ms),
    priority: rng() < 0.25 ? "critical" : "normal",
  });
}
USERS.forEach((u, i) => {
  for (let k = 0; k < 3; k++) add(u, pick(boundaries[i]));
});
for (const u of USERS) {
  const base = randomMs();
  for (const offset of [0, 20, 45, 70]) add(u, base + offset * 60000);
}
for (let k = 0; k < 32; k++) add(USERS[Math.floor(rng() * USERS.length)], randomMs());

// Directed edge cases (fixed literals). Each row: [userId, timezone, consent, at, priority].
const DIRECTED_ROWS = [
  ["d01", "Europe/Istanbul", true, "2026-03-07T04:00:00Z", "normal"],
  ["d02", "Europe/Istanbul", true, "2026-03-07T03:59:00Z", "normal"],
  ["d03", "Europe/Istanbul", true, "2026-03-07T18:59:00Z", "normal"],
  ["d04", "Europe/Istanbul", true, "2026-03-07T19:00:00Z", "normal"],
  ["d05", "Europe/Istanbul", true, "2026-03-07T19:00:00Z", "critical"],
  ["d06", "Europe/Istanbul", false, "2026-03-07T20:00:00Z", "normal"],
  ["d07", "Europe/Istanbul", true, "2026-03-07T21:00:00Z", "normal"],
  ["d08", "America/New_York", true, "2026-11-01T05:30:00Z", "normal"],
  ["d09", "America/New_York", true, "2026-11-01T06:30:00Z", "normal"],
  ["d10", "America/New_York", true, "2026-11-01T06:30:00Z", "critical"],
  ["d11", "Asia/Kolkata", true, "2026-03-07T16:29:00Z", "normal"],
  ["d12", "Asia/Kolkata", true, "2026-03-07T16:30:00Z", "normal"],
  ["d13", "Asia/Kolkata", true, "2026-03-08T01:29:00Z", "normal"],
  ["d14", "Asia/Kolkata", true, "2026-03-08T01:30:00Z", "normal"],
  ["d15", "Asia/Kathmandu", true, "2026-03-07T16:14:00Z", "normal"],
  ["d16", "Asia/Kathmandu", true, "2026-03-07T16:15:00Z", "normal"],
  ["d17", "Asia/Kathmandu", true, "2026-03-08T01:14:00Z", "normal"],
  ["d18", "Asia/Kathmandu", true, "2026-03-08T01:15:00Z", "normal"],
  ["d19", "Asia/Kathmandu", true, "2026-03-07T18:15:00Z", "normal"],
  ["d20", "Europe/Istanbul", false, "2026-03-08T12:00:00Z", "critical"],
  ["cap1", "Europe/Istanbul", true, "2026-03-08T06:00:00Z", "normal"],
  ["cap1", "Europe/Istanbul", true, "2026-03-08T07:00:00Z", "normal"],
  ["cap1", "Europe/Istanbul", true, "2026-03-08T08:00:00Z", "normal"],
  ["cap1", "Europe/Istanbul", true, "2026-03-08T09:00:00Z", "normal"],
  ["d21", "America/New_York", true, "2026-03-08T10:59:00Z", "normal"],
  ["d22", "America/New_York", true, "2026-03-08T11:00:00Z", "normal"],
  ["d23", "America/New_York", true, "2026-11-01T11:59:00Z", "normal"],
  ["d24", "America/New_York", true, "2026-11-01T12:00:00Z", "normal"],
];
const DIRECTED = DIRECTED_ROWS.map(([userId, timezone, consent, at, priority]) => ({ userId, timezone, consent, at, priority }));

const REF_A = refOutcomes(CASES, POLICY_A);
const REF_B = refOutcomes(CASES, POLICY_B);

// ---------- helpers ----------
const setPolicy = (obj) => writeFileSync(POLICY_PATH, JSON.stringify(obj));
const writeCases = (name, list) => writeFileSync(join(work, name), JSON.stringify(list));

function runProgram(prog, caseFile) {
  return spawnSync(prog.cmd, [...prog.args, caseFile], {
    cwd: work,
    encoding: "utf8",
    timeout: 240000,
    env: { ...process.env, GOFLAGS: "-mod=mod", GOPROXY: "https://proxy.golang.org,direct" },
  });
}

// Parsed outcome array, or null (with a note) when the program failed or printed something else.
function outcomesFrom(prog, caseFile, note) {
  const res = runProgram(prog, caseFile);
  if (res.error) {
    note(`${prog.name}: ${res.error.code || res.error.message}`);
    return null;
  }
  if (res.status !== 0) {
    note(`${prog.name} exited ${res.status}: ${String(res.stderr).slice(0, 160)}`);
    return null;
  }
  try {
    const value = JSON.parse(res.stdout);
    if (!Array.isArray(value)) throw new Error("not an array");
    return value;
  } catch {
    note(`${prog.name}: stdout is not a JSON array`);
    return null;
  }
}

function sameOutcomes(note, name, got, want) {
  if (!got) return false;
  if (got.length !== want.length) {
    note(`${name}: ${got.length} entries, expected ${want.length}`);
    return false;
  }
  let ok = true;
  let shown = 0;
  want.forEach((w, i) => {
    const g = got[i];
    if (!g || g.index !== i || g.outcome !== w.outcome) {
      ok = false;
      if (shown++ < 4) note(`${name} case ${i}: ${JSON.stringify(g)}, expected ${w.outcome}`);
    }
  });
  if (!ok && shown > 4) note(`${name}: ${shown} mismatches in total`);
  return ok;
}

try {
  // ---------- criteria ----------

  const ALL_OUTCOMES = ["sent", "consent", "quiet", "cap"];

  await r.crit("1 node: decide.mjs matches the reference for policy A on the 60 generated cases", async (note) => {
    setPolicy(POLICY_A);
    writeCases("cases.json", CASES);
    for (const o of ALL_OUTCOMES) {
      if (!REF_A.some((x) => x.outcome === o)) note(`internal: the generated cases contain no "${o}" outcome`);
    }
    return sameOutcomes(note, "node", outcomesFrom(PROGRAMS[0], "cases.json", note), REF_A);
  });

  await r.crit("2 python: decide.py matches the reference for policy A on the 60 generated cases", async (note) => {
    setPolicy(POLICY_A);
    writeCases("cases.json", CASES);
    return sameOutcomes(note, "python", outcomesFrom(PROGRAMS[1], "cases.json", note), REF_A);
  });

  await r.crit("3 go: main.go matches the reference for policy A on the 60 generated cases", async (note) => {
    setPolicy(POLICY_A);
    writeCases("cases.json", CASES);
    return sameOutcomes(note, "go", outcomesFrom(PROGRAMS[2], "cases.json", note), REF_A);
  });

  await r.crit("4 policy is read at run time: with policy B swapped in, all three match the reference for policy B", async (note) => {
    setPolicy(POLICY_B);
    writeCases("cases.json", CASES);
    let ok = true;
    for (const prog of PROGRAMS) ok = sameOutcomes(note, prog.name, outcomesFrom(prog, "cases.json", note), REF_B) && ok;
    return ok;
  });

  await r.crit("5 edges: quiet start and end, the repeated hour, Kolkata and Kathmandu offsets, null quiet hours and null cap; all three agree", async (note) => {
    writeCases("directed.json", DIRECTED);
    let ok = true;
    const variants = [
      ["policy A", POLICY_A],
      ["policy with null quiet hours (N1)", POLICY_N1],
      ["policy with null cap (N2)", POLICY_N2],
    ];
    for (const [label, policy] of variants) {
      setPolicy(policy);
      const want = refOutcomes(DIRECTED, policy);
      for (const prog of PROGRAMS) {
        ok = sameOutcomes(note, `${prog.name} on ${label}`, outcomesFrom(prog, "directed.json", note), want) && ok;
      }
    }
    return ok;
  });

  await r.crit("6 policy errors: a missing or invalid policy.json makes each program exit non-zero and print policy on stderr", async (note) => {
    writeCases("cases.json", CASES);
    let ok = true;
    const check = (prog, label) => {
      const res = runProgram(prog, "cases.json");
      if (res.error) {
        ok = false;
        note(`${prog.name} with ${label}: ${res.error.code || res.error.message}`);
        return;
      }
      if (res.status === 0) {
        ok = false;
        note(`${prog.name} with ${label}: exit status 0, expected non-zero`);
      }
      if (!/policy/i.test(String(res.stderr))) {
        ok = false;
        note(`${prog.name} with ${label}: stderr does not mention policy`);
      }
    };
    rmSync(POLICY_PATH, { force: true });
    for (const prog of PROGRAMS) check(prog, "a missing policy.json");
    writeFileSync(POLICY_PATH, "{not json");
    for (const prog of PROGRAMS) check(prog, "invalid JSON in policy.json");
    return ok;
  });

  r.print();
} finally {
  if (original !== null) writeFileSync(POLICY_PATH, original);
  else rmSync(POLICY_PATH, { force: true });
}
