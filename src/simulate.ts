/**
 * One stream of candidates, two or more policies, every figure recomputed from the run.
 *
 * This adds no check and no store and does not touch the decision path: it runs the gate that
 * already exists once per policy over the same events and records what happened to each
 * candidate. The point is the difference between the columns, which is the only honest way this
 * repository can answer "what would installing this change for me" without asking anyone to
 * take a number on trust.
 *
 * The contracts a truthful simulation has to hold, each of which was wrong in 0.6.0 and is now
 * covered by `test/simulate-fidelity.test.ts`:
 *
 * - **One clock.** The store is built with the simulation's clock, so a TTL expires when the
 *   simulated week passes it rather than when the wall clock does. A run over a week takes
 *   milliseconds of real time, so a real-time TTL never expires and a window never reopens.
 * - **State is read again, never remembered.** A deferred or postponed candidate is re-evaluated
 *   against the newest snapshot of that user at or before the moment it runs, not against the
 *   snapshot it was deferred with. A decision is permission for an instant, not a standing one.
 * - **Evaluation time and delivery time are different instants.** A non-rejecting check may move
 *   a send to a later moment. The person is disturbed then, so quiet hours and daily volume are
 *   counted then, and the send is re-evaluated then. The budget unit stays on the day the gate
 *   spent it, because that is the day its key names.
 * - **Deferral terminates.** A `retryAt` that is missing, in the past or equal to now is a broken
 *   deferral and is recorded rather than re-queued; the expiry window is measured from the
 *   candidate's first sighting rather than from its latest hop; and there is a hard attempt cap
 *   behind both.
 * - **Three numbers stay apart**: allowed is not sent (`commit` can still refuse, and a transport
 *   can fail), deferred is not rejected, and the no-gate baseline is not a policy.
 *
 * Nothing here reads a wall clock. Every event carries its own instant, the scheduler runs on
 * those same instants, the store is driven by them, and the simulated transport draws from a
 * seeded generator, so a replay gives the same result on any machine on any day.
 */
import { createGate } from "./gate.js";
import { compilePolicy } from "./policy.js";
import { budgetKey, localClock, quietAt } from "./checks.js";
import { explain } from "./explain.js";
import { MemoryStore } from "./stores.js";
import type { Candidate, Check, Decision, EvaluateInput, Policy, QuietSchedule, QuietWindow, UserState } from "./types.js";

/** What became of one candidate under one policy. */
export type SimOutcome =
  | "sent"
  | "held"
  | "deferred"
  | "expired"
  | "lostAtCommit"
  | "spentNotDelivered"
  /** Allowed and committed, then refused when its postponed delivery moment came round. */
  | "stoppedAtDelivery";

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
  /** When the send actually landed. Equal to `at` unless a check postponed it. */
  deliveredAt?: string;
  /** The recipient's own local day of the delivery, which is the day they felt the volume. */
  localDay?: string;
  /** Whether the delivery landed inside that user's own quiet window, as it stood then. */
  inQuietHours?: boolean;
  /** Whether it landed inside the fixed night window, which is a coarser, comparable figure. */
  nightOfDelivery?: boolean;
  priority?: string;
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
  stoppedAtDelivery: number;
  deferredAtLeastOnce: number;
  sentAfterDeferral: number;
  /** Sends a non-rejecting check moved to a later moment, which is neither a hold nor a drop. */
  sentAtALaterMoment: number;
  /**
   * Sends that landed inside the recipient's **own** quiet hours, as that window stood at the
   * moment of delivery. A fixed curfew would punish the user who asked for none and would miss
   * one whose window runs 18:00 to 09:00.
   */
  sentInQuietHours: number;
  /** Of those, the ones the documented priority floor lets through on purpose. */
  sentInQuietHoursByFloor: number;
  /** Sends inside a fixed 22:00 to 08:00 local window, which is nobody's stated preference. */
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
  /**
   * Budget units spent, per user and local day, snapshotted from the store at the moment of each
   * commit rather than read back at the end of the run. Reading at the end would report zeros for
   * the first days of a week, because the daily key carries a two-day TTL and the simulated clock
   * runs past it.
   */
  budget: Array<{ userId: string; localDay: string; used: number }>;
}

/** The kinds of difference two policies can have about one candidate. */
export type SimDifference = "outcome" | "reason" | "deliveryTime";

export interface SimTimelineRow {
  candidateId: string;
  userId: string;
  at: string;
  /** Month-day and time in the recipient's own zone, which is the clock that judges a message. */
  localTime: string;
  type: string;
  priority: string;
  /** One cell per policy, in the order the policies were given. */
  cells: Array<{ outcome: SimOutcome; check?: string; sentence?: string; retryAt?: string; deliveredAt?: string }>;
  /** Empty when every policy did the same thing at the same moment for the same reason. */
  differences: SimDifference[];
}

export interface SimResult {
  seed: number;
  events: number;
  runs: SimRun[];
  timeline: SimTimelineRow[];
  /** Every candidate the policies did not treat identically, whatever kind the difference is. */
  disagreements: SimTimelineRow[];
  /** How many candidates differ in each way. A candidate can appear in more than one. */
  differenceCounts: Record<SimDifference, number>;
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
  /**
   * State the stream carries without a candidate attached, such as a consent being withdrawn.
   * The snapshot used at any instant is the newest one at or before it, from either source.
   */
  stateUpdates?: Array<{ user: UserState; at: Date }>;
  /** Seeds the simulated transport, and nothing else. */
  seed?: number;
  /** Fraction of simulated sends the fake transport fails. 0 keeps the run about the policy. */
  transportFailureRate?: number;
  /** How long a deferred candidate stays worth sending, measured from its first sighting. */
  expirySeconds?: number;
  /** The local window counted as night in `sentAtNight`. */
  night?: { start: number; end: number };
  /** Backstop against a policy that defers for ever. Reached is recorded, never silent. */
  maxAttempts?: number;
}

export const DEFAULT_NIGHT = { start: 22, end: 8 };
export const DEFAULT_EXPIRY_SECONDS = 4 * 60 * 60;
export const DEFAULT_MAX_ATTEMPTS = 20;

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
function localOf(timezone: string | undefined, at: Date): { hour: number; minutes: number; day: string; text: string } {
  const clock = localClock(at, timezone ?? "UTC");
  const hour = Math.floor(clock.minutes / 60);
  const minute = clock.minutes % 60;
  return { hour, minutes: clock.minutes, day: clock.day, text: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

const inNight = (hour: number, night: { start: number; end: number }) =>
  night.start <= night.end ? hour >= night.start && hour < night.end : hour >= night.start || hour < night.end;

const insideOwnQuietHours = (quiet: QuietWindow | QuietSchedule | null | undefined, day: string, minutes: number): boolean =>
  quiet ? quietAt(quiet, day, minutes) !== null : false;

/**
 * Counts over final outcomes, one row per candidate, using what each record wrote down about
 * itself at the time. Nothing is recomputed here from a later snapshot of the user, because a
 * person who changed time zone on Thursday was not in that zone on Monday.
 */
function countsOf(records: SimRecord[], night: { start: number; end: number }): SimCounts {
  const finals = new Map<string, SimRecord>();
  for (const r of records) finals.set(r.candidateId, r);
  const deferredIds = new Set(records.filter((r) => r.outcome === "deferred").map((r) => r.candidateId));
  const perUserDay = new Map<string, number>();
  const stopped = new Map<string, { count: number; example: string }>();
  let sentAtNight = 0;
  let sentInQuietHours = 0;
  let sentInQuietHoursByFloor = 0;

  for (const r of finals.values()) {
    if (r.outcome === "sent") {
      if (r.inQuietHours) {
        sentInQuietHours += 1;
        if (r.priority === "critical") sentInQuietHoursByFloor += 1;
      }
      if (r.nightOfDelivery) sentAtNight += 1;
      const key = `${r.userId}:${r.localDay ?? ""}`;
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
    stoppedAtDelivery: count("stoppedAtDelivery"),
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

/** Work the scheduler is holding: a deferral to re-evaluate, or a postponed delivery to make. */
interface Pending {
  kind: "retry" | "deliver";
  candidate: Candidate;
  userId: string;
  due: Date;
  attempt: number;
  firstSeen: Date;
}

interface Runner {
  label: string;
  gate: ReturnType<typeof createGate>;
  store: MemoryStore;
  records: SimRecord[];
  pending: Pending[];
  budget: Map<string, { userId: string; localDay: string; used: number }>;
  send: () => boolean;
}

export async function simulate(options: SimOptions): Promise<SimResult> {
  const seed = options.seed ?? 1;
  const failureRate = options.transportFailureRate ?? 0;
  const expirySeconds = options.expirySeconds ?? DEFAULT_EXPIRY_SECONDS;
  const night = options.night ?? DEFAULT_NIGHT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const { events, policies } = options;
  if (!events.length) throw new Error("simulate: no events to run");
  if (!policies.length) throw new Error("simulate: no policies to run");

  // Identity contract: a candidate id is how a candidate is followed across policies and across
  // attempts, so two candidates sharing one would silently collapse into a single row.
  const seenIds = new Set<string>();
  for (const event of events) {
    // `EvaluateInput.now` is optional because the library may read the current instant. A
    // simulation cannot: without one the event would sit at the epoch, a lifetime before every
    // TTL on the simulated clock, and it would be counted as an ordinary send.
    if (!(event.now instanceof Date) || Number.isNaN(event.now.getTime())) {
      throw new Error(`simulate: candidate "${event.candidate.id}" has no usable instant; every event needs its own \`now\`, because a simulation has no current time to fall back on`);
    }
    if (seenIds.has(event.candidate.id)) {
      throw new Error(`simulate: duplicate candidate id "${event.candidate.id}"; ids identify a candidate across policies and attempts, so they must be unique within a stream`);
    }
    seenIds.add(event.candidate.id);
  }

  const ordered = [...events].sort((a, b) => (a.now?.getTime() ?? 0) - (b.now?.getTime() ?? 0));
  const states = [
    ...ordered.map((e) => ({ user: e.user, at: e.now ?? new Date(0) })),
    ...(options.stateUpdates ?? []),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const runs: SimRun[] = [];
  for (const entry of policies) {
    runs.push(await runOne(entry, ordered, states, { seed, failureRate, expirySeconds, night, maxAttempts }));
  }

  const byCandidate = runs.map((run) => {
    const finals = new Map<string, SimRecord>();
    for (const r of run.records) finals.set(r.candidateId, r);
    return finals;
  });

  const differenceCounts: Record<SimDifference, number> = { outcome: 0, reason: 0, deliveryTime: 0 };
  const timeline: SimTimelineRow[] = ordered.map((event) => {
    const at = event.now ?? new Date(0);
    const local = localOf(event.user.timezone, at);
    const finals = byCandidate.map((m) => m.get(event.candidate.id));
    const cells = finals.map((record) => {
      if (!record) return { outcome: "held" as SimOutcome };
      const check = record.rejectedBy ?? record.deferredBy;
      return {
        outcome: record.outcome,
        ...(check ? { check } : {}),
        ...(record.sentence ? { sentence: record.sentence } : {}),
        ...(record.retryAt ? { retryAt: record.retryAt } : {}),
        ...(record.deliveredAt ? { deliveredAt: record.deliveredAt } : {}),
      };
    });
    // The kinds are reported so that one candidate is counted once for the thing that actually
    // separates the policies: when the outcomes already differ, saying that the reason differs too
    // is noise, and it would put every ordinary disagreement in all three columns.
    const differences: SimDifference[] = [];
    if (new Set(cells.map((c) => c.outcome)).size > 1) differences.push("outcome");
    else {
      if (new Set(cells.map((c) => c.check ?? "")).size > 1) differences.push("reason");
      if (new Set(cells.map((c) => c.deliveredAt ?? "")).size > 1) differences.push("deliveryTime");
    }
    for (const kind of differences) differenceCounts[kind] += 1;
    return {
      candidateId: event.candidate.id,
      userId: event.user.id,
      at: iso(at),
      localTime: `${local.day.slice(5)} ${local.text}`,
      type: event.candidate.type,
      priority: event.candidate.priority ?? "normal",
      cells,
      differences,
    };
  });

  return {
    seed,
    events: events.length,
    runs,
    timeline,
    disagreements: timeline.filter((row) => row.differences.length > 0),
    differenceCounts,
  };
}

async function runOne(
  entry: SimPolicy,
  ordered: EvaluateInput[],
  states: Array<{ user: UserState; at: Date }>,
  options: { seed: number; failureRate: number; expirySeconds: number; night: { start: number; end: number }; maxAttempts: number },
): Promise<SimRun> {
  // A transport per run, seeded identically, so one run's failures cannot move another's.
  const random = mulberry32(options.seed);
  const send = () => random() >= options.failureRate;

  // The newest snapshot of each user at or before the instant being processed. The queue runs in
  // instant order, so this pointer only ever moves forwards: state is read again at every step,
  // and a decision made at 08:00 is never permission to send at 09:00.
  const current = new Map<string, UserState>();
  let stateIndex = 0;
  const advanceStateTo = (at: Date) => {
    while (stateIndex < states.length && (states[stateIndex]?.at.getTime() ?? 0) <= at.getTime()) {
      const state = states[stateIndex];
      stateIndex += 1;
      if (state) current.set(state.user.id, state.user);
    }
  };
  const snapshotAt = (userId: string, at: Date): UserState | undefined => {
    advanceStateTo(at);
    return current.get(userId);
  };

  if (!entry.policy && !entry.checks) return baselineRun(entry.label, ordered, send, options.night);

  // One clock for the gate, the scheduler and the store, so a TTL expires when the simulated
  // week passes it. The store's own constructor takes it; nothing in the library changed for this.
  let now = ordered[0]?.now ?? new Date(0);
  const store = new MemoryStore(() => now.getTime());
  const compiled = entry.policy ? compilePolicy(entry.policy) : { checks: entry.checks ?? [] };
  const gate = createGate({ ...compiled, store });
  // A postponed delivery is re-evaluated against the person's state, not against the payment the
  // candidate itself already made: the gate commits at evaluation, so asking a budget again at the
  // delivery moment would refuse the send on the strength of its own spend, which is a hold the
  // library would never produce. Every check that consumes is therefore dropped for that second
  // look, and every check that only reads state is kept, which is the whole point of looking again.
  const deliveryChecks = compiled.checks.filter((c) => typeof c.consume !== "function");
  const deliveryGate = deliveryChecks.length ? createGate({ ...compiled, checks: deliveryChecks, store }) : null;

  const runner: Runner = { label: entry.label, gate, store, records: [], pending: [], budget: new Map(), send };

  /** What the store now says this user has spent on this local day, kept as it happens. */
  const snapshotBudget = async (userId: string, user: UserState, at: Date) => {
    const key = budgetKey(userId, at, user.timezone);
    const used = Number((await store.get(`pg:${key}`)) ?? 0);
    if (used <= 0) return;
    const localDay = key.slice(key.lastIndexOf(":") + 1);
    const id = `${userId}:${localDay}`;
    const seen = runner.budget.get(id);
    if (!seen || used > seen.used) runner.budget.set(id, { userId, localDay, used });
  };

  /** Write the delivery facts on the record at the moment it happens, never afterwards. */
  const markDelivered = (record: SimRecord, user: UserState, at: Date, priority: string) => {
    const local = localOf(user.timezone, at);
    record.deliveredAt = iso(at);
    record.localDay = local.day;
    record.inQuietHours = insideOwnQuietHours(user.quietHours, local.day, local.minutes);
    record.nightOfDelivery = inNight(local.hour, options.night);
    record.priority = priority;
  };

  const evaluate = async (candidate: Candidate, user: UserState, at: Date, attempt: number, firstSeen: Date): Promise<void> => {
    now = at;
    const input: EvaluateInput = { user, candidate, now: at };
    const decision: Decision = await gate.evaluate(input);
    const record: SimRecord = {
      candidateId: candidate.id,
      userId: user.id,
      at: iso(at),
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
      const due = decision.retryAt;
      const deadline = firstSeen.getTime() + options.expirySeconds * 1000;
      const broken = !due || due.getTime() <= at.getTime();
      const capped = attempt >= options.maxAttempts;
      if (broken || capped || due.getTime() > deadline) {
        record.outcome = "expired";
        const why = record.reason ?? "deferred";
        if (broken) record.reason = `${why} (no usable retryAt: a deferral must name a later instant)`;
        else if (capped) record.reason = `${why} (gave up after ${attempt} attempts)`;
        else record.reason = `${why} (past the point where sending it was still worth anything)`;
      } else {
        record.outcome = "deferred";
        runner.pending.push({ kind: "retry", candidate, userId: user.id, due, attempt: attempt + 1, firstSeen });
      }
      runner.records.push(record);
      return;
    }

    if (!decision.allowed) {
      runner.records.push(record);
      return;
    }

    if (!(await gate.commit(decision, input))) {
      record.outcome = "lostAtCommit";
      record.rejectedBy = "commit";
      record.reason = "a budget was exhausted at commit";
      runner.records.push(record);
      return;
    }
    // The unit is spent here, under this instant's local-day key, whatever happens next.
    await snapshotBudget(user.id, user, at);

    if (decision.deliverAt && decision.deliverAt.getTime() > at.getTime()) {
      // Allowed and paid for now, to be delivered later. The send is not recorded until then.
      runner.pending.push({ kind: "deliver", candidate, userId: user.id, due: decision.deliverAt, attempt, firstSeen });
      record.outcome = "deferred";
      record.deferredBy = record.deferredBy ?? "adaptiveTiming";
      runner.records.push(record);
      return;
    }

    record.outcome = send() ? "sent" : "spentNotDelivered";
    if (record.outcome === "sent") markDelivered(record, user, at, candidate.priority ?? "normal");
    runner.records.push(record);
  };

  /**
   * A postponed delivery. The unit was taken at evaluation, so this cannot be refunded, but it can
   * still be refused: the person's state is read again at the moment they would be disturbed.
   * A new `deliverAt` from this second evaluation is deliberately ignored rather than obeyed,
   * because a check that keeps moving a delivery would otherwise never let it land.
   */
  const deliver = async (item: Pending): Promise<void> => {
    now = item.due;
    const user = snapshotAt(item.userId, item.due);
    const record: SimRecord = {
      candidateId: item.candidate.id,
      userId: item.userId,
      at: iso(item.due),
      attempt: item.attempt,
      outcome: "stoppedAtDelivery",
      deliverAt: iso(item.due),
    };
    if (!user) {
      record.reason = "no state on record for this user at the delivery moment";
      runner.records.push(record);
      return;
    }
    if (!deliveryGate) {
      record.outcome = runner.send() ? "sent" : "spentNotDelivered";
      if (record.outcome === "sent") markDelivered(record, user, item.due, item.candidate.priority ?? "normal");
      runner.records.push(record);
      return;
    }
    const decision = await deliveryGate.evaluate({ user, candidate: item.candidate, now: item.due });
    record.sentence = explain(decision).summary;
    if (!decision.allowed || decision.deferredBy) {
      record.rejectedBy = decision.rejectedBy ?? decision.deferredBy ?? "delivery";
      record.reason = decision.reason ?? "no longer allowed at the delivery moment";
      runner.records.push(record);
      return;
    }
    record.outcome = runner.send() ? "sent" : "spentNotDelivered";
    if (record.outcome === "sent") markDelivered(record, user, item.due, item.candidate.priority ?? "normal");
    runner.records.push(record);
  };

  // One queue, in instant order: the next stream event or the next due piece of pending work,
  // whichever comes first. Ordering matters because budgets are per user and local day.
  let index = 0;
  for (;;) {
    const nextEvent = ordered[index];
    let dueIndex = -1;
    for (const [i, p] of runner.pending.entries()) {
      const best = dueIndex < 0 ? undefined : runner.pending[dueIndex];
      if (!best || p.due.getTime() < best.due.getTime()) dueIndex = i;
    }
    const nextPending = dueIndex < 0 ? undefined : runner.pending[dueIndex];
    if (!nextEvent && !nextPending) break;

    const takePending =
      nextPending !== undefined && (!nextEvent || nextPending.due.getTime() <= (nextEvent.now?.getTime() ?? 0));
    if (takePending && nextPending) {
      runner.pending.splice(dueIndex, 1);
      if (nextPending.kind === "deliver") await deliver(nextPending);
      else {
        const user = snapshotAt(nextPending.userId, nextPending.due);
        if (user) await evaluate(nextPending.candidate, user, nextPending.due, nextPending.attempt, nextPending.firstSeen);
        else {
          // No snapshot at or before this instant, which the contract at the top of this file says
          // is the only state a retry may use. Recorded rather than guessed at, the same way a
          // delivery with no state on record is recorded.
          runner.records.push({
            candidateId: nextPending.candidate.id,
            userId: nextPending.userId,
            at: iso(nextPending.due),
            attempt: nextPending.attempt,
            outcome: "expired",
            reason: "no state on record for this user at the retry moment",
          });
        }
      }
      continue;
    }
    if (nextEvent) {
      index += 1;
      const at = nextEvent.now ?? new Date(0);
      await evaluate(nextEvent.candidate, snapshotAt(nextEvent.user.id, at) ?? nextEvent.user, at, 1, at);
    }
  }

  return {
    label: entry.label,
    records: runner.records,
    counts: countsOf(runner.records, options.night),
    budget: [...runner.budget.values()].sort((a, b) => a.userId.localeCompare(b.userId) || a.localDay.localeCompare(b.localDay)),
  };
}

/** Every candidate is sent. What a product does before this library is installed. */
function baselineRun(label: string, ordered: EvaluateInput[], send: () => boolean, night: { start: number; end: number }): SimRun {
  const records: SimRecord[] = ordered.map((e) => {
    const at = e.now ?? new Date(0);
    const local = localOf(e.user.timezone, at);
    const sent = send();
    return {
      candidateId: e.candidate.id,
      userId: e.user.id,
      at: iso(at),
      attempt: 1,
      outcome: sent ? ("sent" as SimOutcome) : ("spentNotDelivered" as SimOutcome),
      ...(sent
        ? {
            deliveredAt: iso(at),
            localDay: local.day,
            inQuietHours: insideOwnQuietHours(e.user.quietHours, local.day, local.minutes),
            nightOfDelivery: inNight(local.hour, night),
            priority: e.candidate.priority ?? "normal",
          }
        : {}),
    };
  });
  return { label, records, counts: countsOf(records, night), budget: [] };
}
