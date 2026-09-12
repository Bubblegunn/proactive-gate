/**
 * One stream of candidates, two or more policies, every figure recomputed from the run.
 *
 * This adds no check and no store and does not touch the decision path: it runs the gate that
 * already exists once per policy over the same events and records what happened to each
 * candidate. The point is the difference between the columns, which is the only honest way this
 * repository can answer "what would installing this change for me" without asking anyone to
 * take a number on trust.
 *
 * Three distinctions the output keeps apart, because collapsing them is how a simulation lies:
 *
 * - **allowed is not sent.** `evaluate` says a message may go, `commit` takes the budget unit
 *   and can still refuse when a concurrent delivery took the last one, and only then does a
 *   transport run. `lostAtCommit` and `spentNotDelivered` are counted apart from `sent`.
 * - **deferred is not rejected.** A deferral carries `retryAt`, and the candidate is
 *   re-evaluated from scratch at that instant against the same store, so consent, the clock and
 *   the budget are read again. An old allowed decision is never a standing permission to send.
 *   A deferral nobody could still act on is counted as `expired` rather than quietly dropped.
 * - **no gate is not a policy.** The baseline bypasses the gate entirely: every candidate is
 *   sent. A policy with no checks is not expressible, and a rival built to lose would measure
 *   nothing. The baseline is what a product does before this library is installed.
 *
 * Nothing here reads a wall clock. Every event carries its own `now`, the deferral scheduler
 * runs on those same instants, and the simulated transport draws from a seeded generator, so a
 * replay gives the same result on any machine on any day.
 */
import { createGate } from "./gate.js";
import { budgetKey, localClock, quietAt } from "./checks.js";
import { explain } from "./explain.js";
import { MemoryStore } from "./stores.js";
import type { Candidate, Check, Decision, EvaluateInput, Policy, Store, UserState } from "./types.js";

/** What became of one candidate under one policy. */
export type SimOutcome = "sent" | "held" | "deferred" | "expired" | "lostAtCommit" | "spentNotDelivered";

export interface SimRecord {
  candidateId: string;
  userId: string;
  /** The instant this attempt was evaluated at, which for a retry is the deferral's own time. */
  at: string;
  /** 1 for the first evaluation, 2 and up for re-evaluations after a deferral. */
  attempt: number;
  outcome: SimOutcome;
  rejectedBy?: string;
  deferredBy?: string;
  retryAt?: string;
  /** Set when a non-rejecting check asked for the send to happen at a later moment. */
  deliverAt?: string;
  /** The check's own reason, as the library words it. */
  reason?: string;
  /** The whole decision as one sentence, from `explain()`. */
  sentence?: string;
}

export interface SimCounts {
  candidates: number;
  /**
   * Every count below is over final outcomes, one per candidate: a candidate deferred and then
   * sent is one send, not a deferral and a send. `deferredAtLeastOnce` and `sentAfterDeferral`
   * are how the holding shows up, and they are the argument that a deferral is not a drop.
   */
  sent: number;
  held: number;
  expired: number;
  lostAtCommit: number;
  spentNotDelivered: number;
  deferredAtLeastOnce: number;
  sentAfterDeferral: number;
  /** Sends a non-rejecting check moved to a later moment, which is neither a hold nor a drop. */
  sentAtALaterMoment: number;
  /**
   * Sends that landed inside the recipient's **own** quiet hours. This is the number that says
   * whether a stated preference was honoured; a fixed curfew would punish `hana`, who asked for
   * no quiet hours at all, and would miss a user whose window is 18:00 to 09:00.
   */
  sentInQuietHours: number;
  /** Of those, the ones the documented priority floor lets through on purpose. */
  sentInQuietHoursByFloor: number;
  /** Sends inside a fixed 22:00 to 08:00 local window, which is nobody's preference. */
  sentAtNight: number;
  /** The most sends one person received in one of their own local days. */
  busiestUserDay: number;
  /** How many candidates each check stopped, deferrals included, highest first. */
  stoppedBy: Array<{ check: string; count: number; example: string }>;
}

export interface SimRun {
  label: string;
  records: SimRecord[];
  counts: SimCounts;
  /** Budget units spent, read back out of the store rather than counted in a local variable. */
  budget: Array<{ userId: string; localDay: string; used: number }>;
}

export interface SimTimelineRow {
  candidateId: string;
  userId: string;
  at: string;
  /** Month-day and time in the recipient's own zone, which is the clock that judges a message. */
  localTime: string;
  type: string;
  priority: string;
  /** One cell per policy, in the order the policies were given. */
  cells: Array<{ outcome: SimOutcome; check?: string; sentence?: string; retryAt?: string }>;
}

export interface SimResult {
  seed: number;
  events: number;
  runs: SimRun[];
  timeline: SimTimelineRow[];
  /** The candidates the policies disagreed about: the whole argument, in one list. */
  disagreements: SimTimelineRow[];
}

/** A policy to run. Leave both `policy` and `checks` out for the no-gate baseline. */
export interface SimPolicy {
  label: string;
  policy?: Policy;
  checks?: Check[];
}

export interface SimOptions {
  events: EvaluateInput[];
  policies: SimPolicy[];
  /** Seeds the simulated transport, and nothing else. */
  seed?: number;
  /** Fraction of simulated sends the fake transport fails. 0 keeps the run about the policy. */
  transportFailureRate?: number;
  /** How long a deferred candidate stays worth sending before this scheduler drops it. */
  expirySeconds?: number;
  /** The local window counted as night in `sentAtNight`. */
  night?: { start: number; end: number };
}

export const DEFAULT_NIGHT = { start: 22, end: 8 };
export const DEFAULT_EXPIRY_SECONDS = 4 * 60 * 60;

/** Small deterministic PRNG, so a seed is the whole definition of a run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString();

/** The recipient's own clock, which is the only one a notification is judged by. */
function localOf(timezone: string | undefined, at: Date): { hour: number; minute: number; day: string; text: string } {
  const clock = localClock(at, timezone ?? "UTC");
  const hour = Math.floor(clock.minutes / 60);
  const minute = clock.minutes % 60;
  return { hour, minute, day: clock.day, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

const inNight = (hour: number, night: { start: number; end: number }) =>
  night.start <= night.end ? hour >= night.start && hour < night.end : hour >= night.start || hour < night.end;

function countsOf(records: SimRecord[], events: EvaluateInput[], night: { start: number; end: number }): SimCounts {
  const zones = new Map(events.map((e) => [e.user.id, e.user.timezone]));
  const quiet = new Map(events.map((e) => [e.user.id, e.user.quietHours]));
  const floor = new Map(events.map((e) => [e.candidate.id, e.candidate.priority ?? "normal"]));
  const perUserDay = new Map<string, number>();
  const stopped = new Map<string, { count: number; example: string }>();
  // One row per candidate, the last attempt, because that is what became of it. Counting every
  // attempt would report a candidate that was held until morning as both a deferral and a send.
  const finals = new Map<string, SimRecord>();
  for (const r of records) finals.set(r.candidateId, r);
  const deferredIds = new Set(records.filter((r) => r.outcome === "deferred").map((r) => r.candidateId));
  let sentAtNight = 0;
  let sentInQuietHours = 0;
  let sentInQuietHoursByFloor = 0;
  for (const r of finals.values()) {
    if (r.outcome === "sent") {
      const at = new Date(r.at);
      const local = localOf(zones.get(r.userId), at);
      if (inNight(local.hour, night)) sentAtNight += 1;
      const window = quiet.get(r.userId);
      if (window && quietAt(window, local.day, local.hour * 60 + local.minute)) {
        sentInQuietHours += 1;
        if (floor.get(r.candidateId) === "critical") sentInQuietHoursByFloor += 1;
      }
      const key = `${r.userId}:${local.day}`;
      perUserDay.set(key, (perUserDay.get(key) ?? 0) + 1);
      continue;
    }
    const by = r.rejectedBy ?? r.deferredBy;
    if (!by) continue;
    const seen = stopped.get(by);
    if (seen) seen.count += 1;
    else stopped.set(by, { count: 1, example: r.reason ?? r.sentence ?? "" });
  }
  const finalRows = [...finals.values()];
  const count = (outcome: SimOutcome) => finalRows.filter((r) => r.outcome === outcome).length;
  return {
    candidates: finals.size,
    sent: count("sent"),
    held: count("held"),
    expired: count("expired"),
    lostAtCommit: count("lostAtCommit"),
    spentNotDelivered: count("spentNotDelivered"),
    deferredAtLeastOnce: deferredIds.size,
    sentAfterDeferral: finalRows.filter((r) => r.outcome === "sent" && r.attempt > 1).length,
    sentAtALaterMoment: finalRows.filter((r) => r.outcome === "sent" && r.deliverAt).length,
    sentInQuietHours,
    sentInQuietHoursByFloor,
    sentAtNight,
    busiestUserDay: perUserDay.size ? Math.max(...perUserDay.values()) : 0,
    stoppedBy: [...stopped.entries()]
      .map(([check, v]) => ({ check, count: v.count, example: v.example }))
      .sort((a, b) => b.count - a.count || a.check.localeCompare(b.check)),
  };
}

/**
 * One stream through one gate, with a scheduler for deferrals that belongs to this simulation
 * rather than to the library: the library never runs a queue. The queue is drained per user just
 * before that user's next event and again at the end, because budgets are keyed per user and
 * local day, so each user's own order is what keeps their counter honest.
 */
async function runGate(
  label: string,
  gate: ReturnType<typeof createGate>,
  store: Store,
  events: EvaluateInput[],
  send: () => boolean,
  expirySeconds: number,
  night: { start: number; end: number },
): Promise<SimRun> {
  const records: SimRecord[] = [];
  const pending: Array<{ user: UserState; candidate: Candidate; due: Date; attempt: number }> = [];

  const evaluateOnce = async (user: UserState, candidate: Candidate, now: Date, attempt: number): Promise<void> => {
    const input: EvaluateInput = { user, candidate, now };
    const decision: Decision = await gate.evaluate(input);
    const record: SimRecord = {
      candidateId: candidate.id,
      userId: user.id,
      at: iso(now),
      attempt,
      outcome: "held",
      ...(decision.rejectedBy ? { rejectedBy: decision.rejectedBy } : {}),
      ...(decision.deferredBy ? { deferredBy: decision.deferredBy } : {}),
      ...(decision.retryAt ? { retryAt: iso(decision.retryAt) } : {}),
      ...(decision.deliverAt ? { deliverAt: iso(decision.deliverAt) } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
      sentence: explain(decision).summary,
    };

    if (decision.deferredBy) {
      const due = decision.retryAt ?? now;
      const stillWorthIt = due.getTime() <= now.getTime() + expirySeconds * 1000;
      record.outcome = stillWorthIt ? "deferred" : "expired";
      if (stillWorthIt) pending.push({ user, candidate, due, attempt: attempt + 1 });
      records.push(record);
      return;
    }
    if (!decision.allowed) {
      records.push(record);
      return;
    }
    if (!(await gate.commit(decision, input))) {
      record.outcome = "lostAtCommit";
      record.rejectedBy = "commit";
      record.reason = "a budget was exhausted at commit";
      records.push(record);
      return;
    }
    record.outcome = send() ? "sent" : "spentNotDelivered";
    records.push(record);
  };

  /** Re-evaluate every deferral for this user due by `upTo`; both null drains what is left. */
  const drain = async (userId: string | null, upTo: Date | null): Promise<void> => {
    for (;;) {
      const index = pending.findIndex(
        (p) => (userId === null || p.user.id === userId) && (upTo === null || p.due.getTime() <= upTo.getTime()),
      );
      if (index < 0) return;
      const [item] = pending.splice(index, 1);
      if (!item) return;
      await evaluateOnce(item.user, item.candidate, item.due, item.attempt);
    }
  };

  for (const event of events) {
    const now = event.now ?? new Date(0);
    await drain(event.user.id, now);
    await evaluateOnce(event.user, event.candidate, now, 1);
  }
  await drain(null, null);

  // Budget rows come out of the store, one per user and per local day, because that is how the
  // key is shaped (spec/SPEC.md 5.1). One number per user would report a counter that has just
  // rolled over and hide what the day before spent.
  const zones = new Map(events.map((e) => [e.user.id, e.user.timezone]));
  const wanted = new Map<string, { userId: string; localDay: string; key: string }>();
  for (const r of records) {
    const key = budgetKey(r.userId, new Date(r.at), zones.get(r.userId));
    if (!wanted.has(key)) wanted.set(key, { userId: r.userId, localDay: key.slice(key.lastIndexOf(":") + 1), key });
  }
  const budget: SimRun["budget"] = [];
  for (const row of [...wanted.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.localDay.localeCompare(b.localDay))) {
    const used = Number((await store.get(`pg:${row.key}`)) ?? 0);
    if (used > 0) budget.push({ userId: row.userId, localDay: row.localDay, used });
  }

  return { label, records, counts: countsOf(records, events, night), budget };
}

/** Every candidate is sent. What a product does before this library is installed. */
function runBaseline(label: string, events: EvaluateInput[], send: () => boolean, night: { start: number; end: number }): SimRun {
  const records: SimRecord[] = events.map((e) => ({
    candidateId: e.candidate.id,
    userId: e.user.id,
    at: iso(e.now ?? new Date(0)),
    attempt: 1,
    outcome: send() ? ("sent" as SimOutcome) : ("spentNotDelivered" as SimOutcome),
  }));
  return { label, records, counts: countsOf(records, events, night), budget: [] };
}

/** The last attempt is what became of a candidate; earlier attempts are how it got there. */
function finalOf(run: SimRun, candidateId: string): SimRecord | undefined {
  const attempts = run.records.filter((r) => r.candidateId === candidateId);
  return attempts.length ? attempts[attempts.length - 1] : undefined;
}

export async function simulate(options: SimOptions): Promise<SimResult> {
  const seed = options.seed ?? 1;
  const failureRate = options.transportFailureRate ?? 0;
  const expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  const night = options.night ?? DEFAULT_NIGHT;
  const { events, policies } = options;
  if (!events.length) throw new Error("simulate: no events to run");
  if (!policies.length) throw new Error("simulate: no policies to run");

  const runs: SimRun[] = [];
  for (const entry of policies) {
    // A transport per run, seeded identically, so one run's failures cannot move another's.
    const random = mulberry32(seed);
    const send = () => random() >= failureRate;
    if (!entry.policy && !entry.checks) {
      runs.push(runBaseline(entry.label, events, send, night));
      continue;
    }
    const store: Store = new MemoryStore();
    const gate = entry.policy
      ? createGate({ policy: entry.policy, store })
      : createGate({ checks: entry.checks ?? [], store });
    runs.push(await runGate(entry.label, gate, store, events, send, expirySeconds, night));
  }

  const timeline: SimTimelineRow[] = events.map((event) => {
    const at = event.now ?? new Date(0);
    const local = localOf(event.user.timezone, at);
    return {
      candidateId: event.candidate.id,
      userId: event.user.id,
      at: iso(at),
      localTime: `${local.day.slice(5)} ${local.text}`,
      type: event.candidate.type,
      priority: event.candidate.priority ?? "normal",
      cells: runs.map((run) => {
        const record = finalOf(run, event.candidate.id);
        if (!record) return { outcome: "held" as SimOutcome };
        const check = record.rejectedBy ?? record.deferredBy;
        return {
          outcome: record.outcome,
          ...(check ? { check } : {}),
          ...(record.sentence ? { sentence: record.sentence } : {}),
          ...(record.retryAt ? { retryAt: record.retryAt } : {}),
        };
      }),
    };
  });

  return {
    seed,
    events: events.length,
    runs,
    timeline,
    disagreements: timeline.filter((row) => new Set(row.cells.map((c) => c.outcome)).size > 1),
  };
}
