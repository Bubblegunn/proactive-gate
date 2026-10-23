// Checker for X2 (guardedSend: opt-out, quiet hours 21:00-08:00, cap of 5 per agent and user per local day,
// append-only hash-chained audit file, verifyAudit, concurrency, restart). usage: node x2.mjs <dir containing bot.mjs>
// Every criterion runs against fresh state (a new temp STATE_DIR). Sends are counted from the log file the
// worker writes, and the chain is recomputed here with node:crypto, never taken from the bot.
//
// Expected clock readings. Each one was derived from the fixed offset and re-checked with a separate
// Intl.DateTimeFormat script (not copied from any reference):
//   Europe/Istanbul is UTC+3, no daylight saving. Quiet hours 21:00 to 08:00 local (end exclusive).
//     2026-09-04T09:00:00Z = 12:00 on 4 Sep (daytime). 2026-09-04T17:59:00Z = 20:59 (sent).
//     2026-09-04T18:00:00Z = 21:00 (quiet). 2026-09-04T19:00:00Z = 22:00 (quiet).
//     2026-09-05T04:59:00Z = 07:59 (quiet). 2026-09-05T05:00:00Z = 08:00 (sent).
//   America/New_York: EST (UTC-5) until 2026-03-08 07:00Z, EDT (UTC-4) until 2026-11-01 06:00Z, EST after.
//     2026-03-08T11:59:00Z = 07:59 EDT (quiet); 2026-03-08T12:00:00Z = 08:00 EDT (sent).
//     2026-11-01T12:59:00Z = 07:59 EST (quiet); 2026-11-01T13:00:00Z = 08:00 EST (sent).
//   America/Los_Angeles is PDT (UTC-7) on 3 and 4 Sep 2026. 2026-09-03T23:00:00Z = 16:00 on 3 Sep,
//     2026-09-04T00:00:00Z = 17:00 on 3 Sep, 2026-09-04T02:00:00Z = 19:00 on 3 Sep, 2026-09-04T03:00:00Z = 20:00 on 3 Sep,
//     2026-09-04T03:30:00Z = 20:30 on 3 Sep (sixth message: cap), 2026-09-04T16:00:00Z = 09:00 on 4 Sep (new day).
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
const ZEROS = "0".repeat(64);
const KEYS = ["seq", "at", "agentId", "userId", "messageId", "decision", "reason", "prevHash", "hash"];
const made = [];
const r = new Report();

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "x2-"));
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

const verify = async (ctx) => (await runWorker(ctx, [{ fn: "verifyAudit" }]))?.[0];
const auditPath = (ctx) => join(ctx.state, "audit.jsonl");
const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const lineList = (text) => text.split("\n").filter((l) => l.length > 0);
const recordsOf = (ctx) => lineList(readText(auditPath(ctx))).map((l) => JSON.parse(l));

// guardedSend call item
const G = (agentId, userId, timezone, msgId, now, optedOut = false) => ({
  fn: "guardedSend",
  agentId,
  user: { id: userId, timezone, optedOut },
  message: { id: msgId, text: "hello" },
  now,
});

// Independent recomputation: sha256 hex of prevHash followed by JSON.stringify of the record without hash,
// keys in the documented order.
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hashFor = (rec) =>
  sha256(
    rec.prevHash +
      JSON.stringify({
        seq: rec.seq,
        at: rec.at,
        agentId: rec.agentId,
        userId: rec.userId,
        messageId: rec.messageId,
        decision: rec.decision,
        reason: rec.reason,
        prevHash: rec.prevHash,
      }),
  );

// Returns null when records are seq 1..n in file order, each linked to the previous hash, and each hash matches.
function chainProblem(recs) {
  let prev = ZEROS;
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (rec.seq !== i + 1) return `position ${i + 1} holds seq ${rec.seq}`;
    if (rec.prevHash !== prev) return `record ${i + 1} prevHash does not link to the record before`;
    if (rec.hash !== hashFor(rec)) return `record ${i + 1} hash does not match its content`;
    prev = rec.hash;
  }
  return null;
}

// Return value: an allowed call needs sent === true; reason may be null, absent or anything else.
const SENT = (g) => !!g && typeof g === "object" && g.sent === true;
// Audit record: the reason must carry the keyword the prompt names (opted out, quiet hours, daily cap).
const KW = { opted: /opted out/i, quiet: /quiet hours/i, cap: /daily cap/i };
const auditHas = (rec, re) => !!rec && typeof rec.reason === "string" && re.test(rec.reason);
// Blocked call: sent === false, and a non-empty string reason from the return value OR the keyword in the audit
// record. The audit keyword is required by the prompt, so in practice it is always checked here as well.
const BLOCKED = (g, rec, re) =>
  !!g && typeof g === "object" && g.sent === false &&
  ((typeof g.reason === "string" && g.reason.length > 0) || auditHas(rec, re)) &&
  auditHas(rec, re);

// The eight mixed calls used by criteria 3 and 4. Decisions: allowed, blocked, blocked, then five allowed
// (the fifth is the agent's fifth message that day), then the sixth is blocked by the cap.
const eightCalls = () => [
  G("ch", "h1", IST, "q1", DAY),
  G("ch", "h2", IST, "q2", DAY, true),
  G("ch", "h1", IST, "q3", "2026-09-04T19:00:00Z"),
  G("ch", "h1", IST, "q4", DAY),
  G("ch", "h1", IST, "q5", DAY),
  G("ch", "h1", IST, "q6", DAY),
  G("ch", "h1", IST, "q7", DAY),
  G("ch", "h1", IST, "q8", DAY),
];
const EIGHT_DECISIONS = ["allowed", "blocked", "blocked", "allowed", "allowed", "allowed", "allowed", "blocked"];

// cases: {label, item, want}. All cases run in one worker process, in order, on one state.
async function runCases(cases, note) {
  const ctx = fresh();
  const res = await runWorker(ctx, cases.map((c) => c.item));
  if (!Array.isArray(res) || res.length !== cases.length) {
    note("the worker gave no complete result array");
    return false;
  }
  const recs = recordsOf(ctx);
  let ok = true;
  cases.forEach((c, k) => {
    const pass = c.want === "sent" ? SENT(res[k]) : BLOCKED(res[k], recs[k], KW[c.want]);
    if (!pass) {
      ok = false;
      note(`${c.label}: expected ${c.want}, got ${JSON.stringify(res[k])} with audit reason ${JSON.stringify(recs[k]?.reason ?? null)}`);
    }
  });
  return ok;
}

// ---------- criteria ----------

await r.crit("1 rules: opted out at noon; quiet hours 21:00 to 08:00 in the user's zone (Istanbul, New York DST); daily cap of 5 per agent and user", async (note) =>
  runCases(
    [
      { label: "opted out at noon", item: G("a1", "o1", IST, "k1", DAY, true), want: "opted" },
      { label: "Istanbul 20:59 sent", item: G("a1", "i1", IST, "k2", "2026-09-04T17:59:00Z"), want: "sent" },
      { label: "Istanbul 21:00 quiet", item: G("a1", "i1", IST, "k3", "2026-09-04T18:00:00Z"), want: "quiet" },
      { label: "Istanbul 07:59 quiet", item: G("a1", "i1", IST, "k4", "2026-09-05T04:59:00Z"), want: "quiet" },
      { label: "Istanbul 08:00 sent", item: G("a1", "i1", IST, "k5", "2026-09-05T05:00:00Z"), want: "sent" },
      { label: "New York 07:59 EDT quiet", item: G("a1", "ny1", NY, "k6", "2026-03-08T11:59:00Z"), want: "quiet" },
      { label: "New York 08:00 EDT sent", item: G("a1", "ny1", NY, "k7", "2026-03-08T12:00:00Z"), want: "sent" },
      { label: "New York 07:59 EST quiet", item: G("a1", "ny2", NY, "k8", "2026-11-01T12:59:00Z"), want: "quiet" },
      { label: "New York 08:00 EST sent", item: G("a1", "ny2", NY, "k9", "2026-11-01T13:00:00Z"), want: "sent" },
      { label: "cap c1 message 1", item: G("a2", "c1", IST, "c1", DAY), want: "sent" },
      { label: "cap c1 message 2", item: G("a2", "c1", IST, "c2", DAY), want: "sent" },
      { label: "cap c1 message 3", item: G("a2", "c1", IST, "c3", DAY), want: "sent" },
      { label: "cap c1 message 4", item: G("a2", "c1", IST, "c4", DAY), want: "sent" },
      { label: "cap c1 message 5", item: G("a2", "c1", IST, "c5", DAY), want: "sent" },
      { label: "cap c1 message 6 blocked", item: G("a2", "c1", IST, "c6", DAY), want: "cap" },
      { label: "cap c1 next local day", item: G("a2", "c1", IST, "c7", "2026-09-05T05:00:00Z"), want: "sent" },
      { label: "other agent has its own count", item: G("a3", "c1", IST, "c8", DAY), want: "sent" },
      { label: "LA 16:00 PDT", item: G("a4", "l1", LA, "l1", "2026-09-03T23:00:00Z"), want: "sent" },
      { label: "LA 17:00 PDT", item: G("a4", "l1", LA, "l2", "2026-09-04T00:00:00Z"), want: "sent" },
      { label: "LA 18:00 PDT", item: G("a4", "l1", LA, "l3", "2026-09-04T01:00:00Z"), want: "sent" },
      { label: "LA 19:00 PDT", item: G("a4", "l1", LA, "l4", "2026-09-04T02:00:00Z"), want: "sent" },
      { label: "LA 20:00 PDT", item: G("a4", "l1", LA, "l5", "2026-09-04T03:00:00Z"), want: "sent" },
      { label: "LA 20:30 PDT same local day blocked", item: G("a4", "l1", LA, "l6", "2026-09-04T03:30:00Z"), want: "cap" },
      { label: "LA 09:00 PDT next local day", item: G("a4", "l1", LA, "l7", "2026-09-04T16:00:00Z"), want: "sent" },
    ],
    note,
  ),
);

await r.crit("2 record shape: nine keys in order, seq 1 and 2, at equals now, decision and reason as specified, links", async (note) => {
  const ctx = fresh();
  const res = await runWorker(ctx, [G("sh-agent", "shape-u", IST, "sm1", DAY), G("sh-agent", "shape-u", IST, "sm2", "2026-09-04T19:00:00Z")]);
  if (!Array.isArray(res) || res.length !== 2) {
    note("the worker gave no two-result array");
    return false;
  }
  const lines = lineList(readText(auditPath(ctx)));
  if (lines.length !== 2) {
    note(`audit.jsonl has ${lines.length} lines, expected 2`);
    return false;
  }
  const [a, b] = lines.map((l) => JSON.parse(l));
  let ok = true;
  for (const [label, rec] of [["record 1", a], ["record 2", b]]) {
    if (JSON.stringify(Object.keys(rec)) !== JSON.stringify(KEYS)) {
      ok = false;
      note(`${label} keys ${JSON.stringify(Object.keys(rec))}`);
    }
  }
  if (a.seq !== 1 || b.seq !== 2) {
    ok = false;
    note(`seq values ${a.seq}, ${b.seq}, expected 1, 2`);
  }
  if (a.at !== new Date(DAY).toISOString() || b.at !== new Date("2026-09-04T19:00:00Z").toISOString()) {
    ok = false;
    note("at does not equal now.toISOString()");
  }
  if (a.decision !== "allowed" || a.reason !== null) {
    ok = false;
    note(`record 1 decision ${a.decision}, reason ${JSON.stringify(a.reason)}`);
  }
  if (b.decision !== "blocked" || typeof b.reason !== "string" || !/quiet hours/i.test(b.reason)) {
    ok = false;
    note(`record 2 decision ${b.decision}, reason ${JSON.stringify(b.reason)}`);
  }
  if (a.agentId !== "sh-agent" || a.userId !== "shape-u" || a.messageId !== "sm1" || b.messageId !== "sm2") {
    ok = false;
    note("agentId, userId or messageId not carried into the record");
  }
  if (a.prevHash !== ZEROS || b.prevHash !== a.hash) {
    ok = false;
    note("prevHash does not follow the chain rule");
  }
  return ok;
});

await r.crit("3 hash chain: 8 mixed calls, every prevHash and hash recomputed independently, first prevHash 64 zeros", async (note) => {
  const ctx = fresh();
  const res = await runWorker(ctx, eightCalls());
  if (!Array.isArray(res) || res.length !== 8) {
    note("the worker gave no eight-result array");
    return false;
  }
  const recs = recordsOf(ctx);
  if (recs.length !== 8) {
    note(`${recs.length} records for 8 calls`);
    return false;
  }
  let ok = true;
  recs.forEach((rec, i) => {
    if (rec.decision !== EIGHT_DECISIONS[i]) {
      ok = false;
      note(`call ${i + 1}: decision ${rec.decision}, expected ${EIGHT_DECISIONS[i]}`);
    }
  });
  const problem = chainProblem(recs);
  if (problem) {
    ok = false;
    note(problem);
  }
  return ok;
});

// Criterion 4 accepts both readings of brokenAt. The prompt says "seq is the first record whose seq, link or
// hash does not match what it should be". Reading A reports the position where the mismatch sits (the seq the
// record should have). Reading B reports the stored seq of the offending record. The two differ only when a
// record was moved or removed, so a deleted line 4 gives 4 (A) or 5 (B), and swapped lines 5 and 6 give 5 (A) or
// 6 (B). A flipped decision in record 3 is a hash mismatch with seq and position agreeing, so both readings give 3
// and that value is exact. A missing file is not specified by the prompt, so it is not checked. An empty file
// is a natural reading (ok, 0 records). Tail truncation removes a whole record from the end, which leaves a valid
// chain, so it is ok with 7 records.
await r.crit("4 verifyAudit: intact -> ok 8; flipped decision -> brokenAt 3; deleted line 4 -> brokenAt 4 or 5; swapped 5 and 6 -> brokenAt 5 or 6; tail cut -> ok 7; empty -> ok 0", async (note) => {
  const ctx = fresh();
  const res = await runWorker(ctx, eightCalls());
  if (!Array.isArray(res) || res.length !== 8) {
    note("the worker gave no eight-result array");
    return false;
  }
  const file = auditPath(ctx);
  const lines = lineList(readText(file));
  if (lines.length !== 8) {
    note(`${lines.length} records written for 8 calls`);
    return false;
  }
  let ok = true;
  const expectOk = (label, v, n) => {
    if (!(v && v.ok === true && v.records === n)) {
      ok = false;
      note(`${label}: expected ok with ${n} records, got ${JSON.stringify(v)}`);
    }
  };
  const expectBroken = (label, v, accepted) => {
    if (!(v && v.ok === false && accepted.includes(v.brokenAt))) {
      ok = false;
      note(`${label}: expected brokenAt ${accepted.join(" or ")}, got ${JSON.stringify(v)}`);
    }
  };
  const write = (arr) => writeFileSync(file, arr.length ? arr.join("\n") + "\n" : "");

  expectOk("intact file", await verify(ctx), 8);

  const flipped = [...lines];
  const rec3 = JSON.parse(flipped[2]);
  rec3.decision = rec3.decision === "allowed" ? "blocked" : "allowed";
  flipped[2] = JSON.stringify(rec3);
  write(flipped);
  expectBroken("decision of record 3 flipped on disk", await verify(ctx), [3]);

  write(lines.filter((_, i) => i !== 3));
  expectBroken("middle line 4 deleted", await verify(ctx), [4, 5]);

  const swapped = [...lines];
  [swapped[4], swapped[5]] = [swapped[5], swapped[4]];
  write(swapped);
  expectBroken("lines 5 and 6 swapped", await verify(ctx), [5, 6]);

  write(lines.slice(0, 7));
  expectOk("last line truncated", await verify(ctx), 7);

  write([]);
  expectOk("empty file", await verify(ctx), 0);
  return ok;
});

await r.crit("5 concurrency: 2 processes x 20 concurrent calls, 10 users, 40 records with seq 1..40 and an intact chain", async (note) => {
  const ctx = fresh();
  const plans = [0, 1].map((p) =>
    Array.from({ length: 20 }, (_, i) => G("cc", `u${(p * 20 + i) % 10}`, IST, `p${p}m${i}`, DAY)),
  );
  const results = await Promise.all(plans.map((plan) => runWorker(ctx, plan, true)));
  let ok = true;
  results.forEach((res, p) => {
    if (!Array.isArray(res) || res.length !== 20) {
      ok = false;
      note(`process ${p} gave no 20-result array`);
      return;
    }
    res.forEach((g, i) => {
      if (!SENT(g)) {
        ok = false;
        note(`process ${p} call ${i}: ${JSON.stringify(g)}`);
      }
    });
  });
  if (!ok) return false;
  const recs = recordsOf(ctx);
  if (recs.length !== 40) {
    note(`${recs.length} records, expected 40`);
    return false;
  }
  const seqs = recs.map((rec) => rec.seq).sort((x, y) => x - y);
  if (seqs.some((s, i) => s !== i + 1)) {
    note("seq values are not exactly 1..40 without gap or duplicate");
    ok = false;
  }
  const problem = chainProblem(recs);
  if (problem) {
    note(problem);
    ok = false;
  }
  const v = await verify(ctx);
  if (!(v && v.ok === true && v.records === 40)) {
    note(`verifyAudit: ${JSON.stringify(v)}`);
    ok = false;
  }
  return ok;
});

await r.crit("6 sends and restart: send runs once per allowed call only; a new process continues at seq n+1 with the right prevHash", async (note) => {
  const ctx = fresh();
  const p1 = await runWorker(ctx, [G("rs", "sa", IST, "x1", DAY), G("rs", "sb", IST, "x2", DAY, true), G("rs", "sa", IST, "x3", DAY)]);
  const p2 = await runWorker(ctx, [G("rs", "sa", IST, "x4", DAY), G("rs", "sa", IST, "x5", "2026-09-04T19:00:00Z")]);
  let ok = true;
  const recs = recordsOf(ctx);
  if (!Array.isArray(p1) || p1.length !== 3 || !SENT(p1[0]) || !BLOCKED(p1[1], recs[1], KW.opted) || !SENT(p1[2])) {
    ok = false;
    note(`process 1 results ${JSON.stringify(p1)}`);
  }
  if (!Array.isArray(p2) || p2.length !== 2 || !SENT(p2[0]) || !BLOCKED(p2[1], recs[4], KW.quiet)) {
    ok = false;
    note(`process 2 results ${JSON.stringify(p2)}`);
  }
  const sends = existsSync(ctx.log) ? lineList(readFileSync(ctx.log, "utf8")) : [];
  if (JSON.stringify(sends) !== JSON.stringify(["sa|x1", "sa|x3", "sa|x4"])) {
    ok = false;
    note(`send log ${JSON.stringify(sends)}, expected only the allowed messages`);
  }
  if (recs.length !== 5) {
    ok = false;
    note(`${recs.length} records for 5 calls`);
  } else {
    const want = ["allowed", "blocked", "allowed", "allowed", "blocked"];
    recs.forEach((rec, i) => {
      if (rec.decision !== want[i]) {
        ok = false;
        note(`record ${i + 1} decision ${rec.decision}, expected ${want[i]}`);
      }
    });
    const problem = chainProblem(recs);
    if (problem) {
      ok = false;
      note(problem);
    }
  }
  const v = await verify(ctx);
  if (!(v && v.ok === true && v.records === 5)) {
    ok = false;
    note(`verifyAudit: ${JSON.stringify(v)}`);
  }
  return ok;
});

for (const d of made) rmSync(d, { recursive: true, force: true });
r.print();
