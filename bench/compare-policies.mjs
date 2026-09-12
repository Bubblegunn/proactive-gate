/**
 * One day of candidates, two policies, every figure recomputed from the run.
 *
 * Run: npm run bench:compare-policies
 *
 * This is the sibling of bench/compare.mjs and deliberately not the same comparison.
 * compare.mjs answers "why not a few if statements" by putting the gate next to
 * bench/naive.mjs, a hand-rolled policy with three real shortcuts in it. That is an honest
 * argument, but it is the wrong shape for this file: naive.mjs is a rival built to lose, and a
 * policy-versus-policy comparison where one side is broken on purpose measures nothing.
 *
 * So both policies here are the real library, and policy A is an honest starting point: the
 * five rules a careful team writes on day one. Consent, the profile switch, the operating
 * mode, quiet hours and a daily cap. Nothing in it is wrong. Policy B is the fuller policy
 * from bench/fixtures/policy.json, which adds the things you learn to want later: a snooze
 * that defers instead of rejecting, per-type mute, the intensity setting, a quiet-hours
 * priority floor, a trust ramp for new accounts and a cooldown that reads dismissals.
 *
 * What the comparison is therefore about: what the extra checks in B catch that A lets
 * through, what B holds rather than drops, and what each costs.
 *
 * Determinism. Every figure below comes from a real run and there is no constant in the output
 * path. Nothing reads a wall clock: each fixture line carries its own `now`, the deferral
 * scheduler runs on those same instants, and the simulated transport's failures come from a
 * seeded generator. Replaying gives the same semantic result on any machine on any day, which
 * test/compare-policies.test.mjs pins by running it twice and diffing.
 *
 * Allowed is not sent. `evaluate` says a message may go; `commit` takes the budget unit and can
 * still refuse when a concurrent delivery took the last one; only then does the transport run,
 * and a transport can fail. Those are three different numbers and this file keeps them apart.
 * The simulated transport is a stand-in for a push service, not a measurement of one, and a
 * successful simulated send does not mean a real user saw or wanted the message.
 */
import { readFile } from "node:fs/promises";
import { budgetKey, createGate, MemoryStore } from "proactive-gate";

const here = (p) => new URL(p, import.meta.url);

/**
 * Policy A: the honest first policy. Written as a policy document rather than composed checks
 * so that both sides of the comparison are the same kind of object.
 */
export const POLICY_A = {
  specVersion: "1.0.0",
  onStoreError: "open",
  checks: [
    { id: "consent" },
    { id: "enabled" },
    { id: "mode", allow: ["normal", "commute"] },
    { id: "quietHours" },
    { id: "dailyBudget", limit: 2 },
  ],
};

/** The dismissals both stores are seeded with, so the two policies start from one state. */
export const SEEDED_DISMISSALS = { user: "emre", type: "insight", daysAgo: [14, 9, 3], from: "2026-09-04T10:00:00Z" };

/** How long a deferred candidate stays worth sending before the demo scheduler drops it. */
export const DEFAULT_EXPIRY_SECONDS = 4 * 60 * 60;

/** Fraction of simulated sends the fake transport fails. A stand-in, not a measurement. */
export const DEFAULT_TRANSPORT_FAILURE_RATE = 0.15;

/** Seeded generator, so the transport fails on the same candidates on every machine. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A transport that accepts most sends and refuses some, deterministically.
 *
 * It is called only after `commit` has returned true, which is the real order: the budget unit
 * is spent before the message goes out. A refusal here therefore leaves a unit spent on a
 * message nobody received, and the run reports that separately rather than hiding it. The
 * library does not solve that; a real deployment needs its transport's own idempotency or an
 * outbox.
 */
export function createTransport({ seed = 1, failureRate = DEFAULT_TRANSPORT_FAILURE_RATE } = {}) {
  const random = mulberry32(seed);
  const attempts = [];
  return {
    attempts,
    async send(decision) {
      const ok = random() >= failureRate;
      attempts.push({ candidateId: decision.candidateId, userId: decision.userId, ok });
      return ok;
    },
  };
}

const dateOf = (value) => (value instanceof Date ? value : new Date(value));

/**
 * Runs one stream through one policy and records everything that happened.
 *
 * Deferrals are re-evaluated by a scheduler that belongs to this demo, not to the library:
 * the library never runs a queue. A deferred candidate is re-evaluated from scratch at its
 * `retryAt`, so consent, mute, the clock and the budget are all read again at that moment. An
 * old allowed decision is never treated as a standing permission to send.
 *
 * The queue is drained per user, just before the next event for that user and again at the
 * end of the stream. Budgets are keyed per user and local day, so preserving each user's own
 * order is what keeps the counters honest; the file's cross-user order is left alone.
 */
export async function runPolicy({ label, policy, lines, transport, expirySeconds = DEFAULT_EXPIRY_SECONDS }) {
  const store = new MemoryStore();
  const gate = createGate({ policy, store });

  // The same starting state for both policies: three dismissals this user really made.
  const from = Date.parse(SEEDED_DISMISSALS.from);
  for (const days of SEEDED_DISMISSALS.daysAgo) {
    await gate.record({ id: SEEDED_DISMISSALS.user }, { type: SEEDED_DISMISSALS.type }, "dismissed", new Date(from - days * 86400000));
  }

  const records = [];
  const pending = [];

  const evaluateOnce = async ({ user, candidate, now, attempt }) => {
    const input = { user, candidate, now };
    const decision = await gate.evaluate(input);
    const record = {
      candidateId: candidate.id,
      userId: user.id,
      at: now.toISOString(),
      attempt,
      allowed: decision.allowed,
      rejectedBy: decision.rejectedBy ?? null,
      deferredBy: decision.deferredBy ?? null,
      retryAt: decision.retryAt ? decision.retryAt.toISOString() : null,
      reason: decision.reason ?? null,
      shadowed: [...decision.shadowed],
      committed: false,
      sent: false,
      outcome: "rejected",
    };

    if (decision.deferredBy) {
      record.outcome = "deferred";
      const due = dateOf(decision.retryAt);
      const deadline = now.getTime() + expirySeconds * 1000;
      if (due.getTime() <= deadline) {
        pending.push({ user, candidate, due, firstSeen: now, attempt: attempt + 1 });
        record.scheduled = true;
      } else {
        // Held past the point where it is worth sending. Counted, not silently dropped.
        record.expired = true;
        record.scheduled = false;
      }
      records.push(record);
      return record;
    }

    if (!decision.allowed) {
      records.push(record);
      return record;
    }

    record.outcome = "allowed";
    record.committed = await gate.commit(decision, input);
    if (!record.committed) {
      // Allowed at evaluate, refused at commit: another delivery took the last unit.
      record.outcome = "lostAtCommit";
      record.rejectedBy = "commit";
      record.reason = "a budget was exhausted at commit";
      records.push(record);
      return record;
    }

    record.sent = await transport.send(decision);
    record.outcome = record.sent ? "sent" : "spentNotDelivered";
    records.push(record);
    return record;
  };

  /** Re-evaluate every deferral for this user that is due by `upTo`. */
  const drain = async (userId, upTo) => {
    for (;;) {
      const index = pending.findIndex((p) => (userId === null || p.user.id === userId) && (upTo === null || p.due.getTime() <= upTo.getTime()));
      if (index < 0) return;
      const [item] = pending.splice(index, 1);
      await evaluateOnce({ user: item.user, candidate: item.candidate, now: item.due, attempt: item.attempt });
    }
  };

  for (const line of lines) {
    const now = dateOf(line.now);
    await drain(line.user.id, now);
    await evaluateOnce({ user: line.user, candidate: line.candidate, now, attempt: 1 });
  }
  await drain(null, null);

  // Budget use over time, read back out of the store rather than counted in a local variable.
  //
  // One row per user and per local day, because that is how the key is shaped: spec/SPEC.md 5.1
  // fixes it as `budget:<userId>:<YYYY-MM-DD>` of the user's local day, behind the default `pg:`
  // prefix. Keying per day matters here rather than being pedantry: fatih's last event is 01:00
  // in Tokyo, which is already the next local day, so a single number per user would report a
  // counter that has just reset and hide the two units he spent the day before.
  const zones = new Map(lines.map((l) => [l.user.id, l.user.timezone]));
  const wanted = new Map();
  for (const r of records) {
    const key = budgetKey(r.userId, new Date(r.at), zones.get(r.userId));
    if (!wanted.has(key)) wanted.set(key, { userId: r.userId, localDay: key.slice(key.lastIndexOf(":") + 1), key });
  }
  const budget = [];
  for (const row of [...wanted.values()].sort((x, y) => x.userId.localeCompare(y.userId) || x.localDay.localeCompare(y.localDay))) {
    budget.push({ userId: row.userId, localDay: row.localDay, used: Number((await store.get(`pg:${row.key}`)) ?? 0) });
  }

  return { label, policy, records, budget, store, gate };
}

const countBy = (records, predicate) => records.filter(predicate).length;

/** Every figure the report prints, recomputed from the records of a real run. */
export function summarize(result) {
  const { records } = result;
  const firstAttempts = records.filter((r) => r.attempt === 1);
  const reasons = new Map();
  for (const r of records) {
    const by = r.rejectedBy;
    if (!by) continue;
    if (!reasons.has(by)) reasons.set(by, { check: by, count: 0, example: r.reason ?? "" });
    reasons.get(by).count += 1;
  }
  const deferrals = records
    .filter((r) => r.deferredBy)
    .map((r) => ({
      candidateId: r.candidateId,
      by: r.deferredBy,
      at: r.at,
      retryAt: r.retryAt,
      heldSeconds: r.retryAt ? Math.round((Date.parse(r.retryAt) - Date.parse(r.at)) / 1000) : null,
      expired: r.expired === true,
    }));

  return {
    candidates: firstAttempts.length,
    evaluations: records.length,
    allowed: countBy(records, (r) => r.allowed),
    rejected: countBy(records, (r) => !r.allowed && !r.deferredBy),
    deferred: countBy(records, (r) => Boolean(r.deferredBy)),
    reEvaluated: countBy(records, (r) => r.attempt > 1),
    expired: countBy(records, (r) => r.expired === true),
    lostAtCommit: countBy(records, (r) => r.outcome === "lostAtCommit"),
    sent: countBy(records, (r) => r.sent),
    spentNotDelivered: countBy(records, (r) => r.outcome === "spentNotDelivered"),
    shadowRejections: records.reduce((n, r) => n + r.shadowed.length, 0),
    reasons: [...reasons.values()].sort((x, y) => y.count - x.count || x.check.localeCompare(y.check)),
    deferrals,
    budget: result.budget,
  };
}

/** The final decision each candidate reached, for the diff between the two policies. */
export function finalOutcomes(result) {
  const byCandidate = new Map();
  for (const r of result.records) {
    const previous = byCandidate.get(r.candidateId);
    if (!previous || r.attempt > previous.attempt) byCandidate.set(r.candidateId, r);
  }
  return byCandidate;
}

/** What the gate decided, as opposed to what then happened to the message. */
const decisionOf = (record) => {
  if (!record) return "absent";
  if (record.allowed) return "allowed";
  return record.deferredBy ? "deferred" : "rejected";
};

/**
 * Candidates whose final outcome differs between the two policies, and why.
 *
 * The `cause` matters more than the count, and separating it is the difference between a
 * useful table and a misleading one. A candidate the two policies decided identically can
 * still end the day differently, because the simulated transport refused one of them. That is
 * a fact about the fake transport, not about either policy, and reporting it as a policy
 * difference would be inventing a result: it would move with the seed.
 *
 * cause "policy":    the gate itself decided differently, or a different check stopped it.
 * cause "transport": both policies decided the same way and delivery differed afterwards.
 */
export function diffOutcomes(a, b) {
  const left = finalOutcomes(a);
  const right = finalOutcomes(b);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changed = [];
  for (const id of ids) {
    const x = left.get(id);
    const y = right.get(id);
    const stoppedX = x ? x.rejectedBy ?? x.deferredBy ?? "" : "";
    const stoppedY = y ? y.rejectedBy ?? y.deferredBy ?? "" : "";
    const decidedDifferently = decisionOf(x) !== decisionOf(y) || stoppedX !== stoppedY;
    if (!decidedDifferently && x?.outcome === y?.outcome) continue;
    changed.push({
      candidateId: id,
      userId: x?.userId ?? y?.userId ?? "",
      cause: decidedDifferently ? "policy" : "transport",
      a: { outcome: x?.outcome ?? "absent", decision: decisionOf(x), by: stoppedX, reason: x?.reason ?? "" },
      b: { outcome: y?.outcome ?? "absent", decision: decisionOf(y), by: stoppedY, reason: y?.reason ?? "" },
    });
  }
  return changed;
}

/** Loads the stream and both policies, runs them against separate stores, and diffs them. */
export async function comparePolicies({
  lines,
  policyA = POLICY_A,
  policyB,
  seed = 1,
  failureRate = DEFAULT_TRANSPORT_FAILURE_RATE,
  expirySeconds = DEFAULT_EXPIRY_SECONDS,
} = {}) {
  const stream = lines ?? (await loadStream());
  const policyBDoc = policyB ?? (await loadPolicyB());
  // A separate transport per policy, seeded identically, so neither run consumes the other's
  // sequence of failures and the same candidate meets the same transport luck in both.
  const a = await runPolicy({ label: "A, the first policy you write", policy: policyA, lines: stream, transport: createTransport({ seed, failureRate }), expirySeconds });
  const b = await runPolicy({ label: "B, the policy from bench/fixtures/policy.json", policy: policyBDoc, lines: stream, transport: createTransport({ seed, failureRate }), expirySeconds });
  return { stream, a, b, summaryA: summarize(a), summaryB: summarize(b), changed: diffOutcomes(a, b) };
}

export async function loadStream() {
  const text = await readFile(here("fixtures/day.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line));
}

export async function loadPolicyB() {
  return JSON.parse(await readFile(here("fixtures/policy.json"), "utf8"));
}

/* ----------------------------- the printed report ----------------------------- */

const pad = (s, n) => String(s).padEnd(n);
const padStart = (s, n) => String(s).padStart(n);

export function formatReport(comparison) {
  const { stream, a, b, summaryA, summaryB, changed } = comparison;
  const users = new Set(stream.map((l) => l.user.id)).size;
  const out = [];

  out.push(`${stream.length} candidates, one day, ${users} users, two policies, a store each.`);
  out.push("");
  out.push(`A: ${a.label}`);
  out.push(`   ${a.policy.checks.map((c) => c.id ?? `preset:${c.preset}`).join(" ")}`);
  out.push(`B: ${b.label}`);
  out.push(`   ${b.policy.checks.map((c) => c.id ?? `preset:${c.preset}`).join(" ")}`);
  out.push("");

  const rows = [
    ["candidates", "candidates"],
    ["evaluations", "evaluations (re-tries included)"],
    ["allowed", "allowed by evaluate"],
    ["lostAtCommit", "of those, refused at commit"],
    ["sent", "delivered by the simulated transport"],
    ["spentNotDelivered", "budget spent, transport refused"],
    ["rejected", "rejected"],
    ["deferred", "deferred"],
    ["reEvaluated", "deferred and re-evaluated later"],
    ["expired", "deferred past its expiry, dropped"],
    ["shadowRejections", "shadow rejections recorded"],
  ];
  out.push(`${pad("", 38)}${padStart("A", 6)}${padStart("B", 6)}`);
  out.push("-".repeat(50));
  for (const [key, label] of rows) out.push(`${pad(label, 38)}${padStart(summaryA[key], 6)}${padStart(summaryB[key], 6)}`);
  out.push("");
  out.push("allowed, sent and delivered are three numbers. A message is allowed by evaluate,");
  out.push("the unit is taken at commit, and only then does the transport run and possibly fail.");
  out.push("A successful simulated send is not evidence a real person saw or wanted the message.");
  out.push("");

  for (const [name, summary] of [["A", summaryA], ["B", summaryB]]) {
    out.push(`why ${name} stopped things`);
    if (!summary.reasons.length) out.push("  nothing was stopped");
    for (const r of summary.reasons) out.push(`  ${pad(r.check, 20)}${padStart(r.count, 3)}  ${r.example}`);
    out.push("");
  }

  for (const [name, summary] of [["A", summaryA], ["B", summaryB]]) {
    out.push(`${name}: deferrals`);
    if (!summary.deferrals.length) out.push("  none; nothing in this policy defers");
    for (const d of summary.deferrals) {
      out.push(`  ${pad(d.candidateId, 4)}${pad(d.by, 10)}held ${padStart(d.heldSeconds ?? "?", 6)} s  until ${d.retryAt}${d.expired ? "  EXPIRED, dropped" : ""}`);
    }
    out.push("");
  }

  out.push("budget units used, per user and per local day, read back out of each store");
  out.push(`${pad("user", 10)}${pad("local day", 13)}${padStart("A", 4)}${padStart("B", 4)}`);
  out.push("-".repeat(31));
  const budgetB = new Map(summaryB.budget.map((x) => [`${x.userId}:${x.localDay}`, x.used]));
  const budgetA = new Map(summaryA.budget.map((x) => [`${x.userId}:${x.localDay}`, x.used]));
  for (const key of [...new Set([...budgetA.keys(), ...budgetB.keys()])].sort()) {
    const [userId, localDay] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    out.push(`${pad(userId, 10)}${pad(localDay, 13)}${padStart(budgetA.get(key) ?? 0, 4)}${padStart(budgetB.get(key) ?? 0, 4)}`);
  }
  out.push("");

  const byPolicy = changed.filter((c) => c.cause === "policy");
  const byTransport = changed.filter((c) => c.cause === "transport");

  const table = (title, rows) => {
    out.push(title);
    if (!rows.length) {
      out.push("  none");
      out.push("");
      return;
    }
    out.push("");
    out.push(`${pad("id", 5)}${pad("user", 8)}${pad("A", 31)}${pad("B", 31)}what stopped it`);
    out.push("-".repeat(120));
    for (const c of rows) {
      const left = `${c.a.outcome}${c.a.by ? ` (${c.a.by})` : ""}`;
      const right = `${c.b.outcome}${c.b.by ? ` (${c.b.by})` : ""}`;
      // Attribute the reason to the side that produced it, so a reason from A is never
      // printed as though it explained B.
      const why = [c.a.reason ? `A: ${c.a.reason}` : "", c.b.reason ? `B: ${c.b.reason}` : ""].filter(Boolean).join("   ");
      out.push(`${pad(c.candidateId, 5)}${pad(c.userId, 8)}${pad(left, 31)}${pad(right, 31)}${why}`);
    }
    out.push("");
  };

  table(`${byPolicy.length} candidates the two policies decided differently`, byPolicy);
  table(
    `${byTransport.length} more ended the day differently without either policy deciding differently`,
    byTransport,
  );
  if (byTransport.length) {
    out.push("Those last ones are the simulated transport, not the policies: both gates allowed");
    out.push("the message and committed the unit, and the fake transport refused one of them.");
    out.push("They move with the seed, so they say nothing about either policy.");
    out.push("");
  }
  out.push("Everything above was recomputed from this run. Nothing here is a stored statistic,");
  out.push("and neither policy was written to lose.");

  return out.join("\n");
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  console.log(formatReport(await comparePolicies()));
}
