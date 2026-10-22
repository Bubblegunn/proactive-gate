/** Priority of a candidate message. Higher priorities may bypass some checks. */
export type Priority = "low" | "normal" | "high" | "critical";

export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/** Where a delivery may land. Free-form so callers can add their own. */
export type Surface = "feed" | "push" | "chat" | "voice" | "email" | (string & {});

/** A quiet window in local time, "HH:MM" to "HH:MM". `start` after `end` crosses midnight. */
export type QuietWindow = { start: string; end: string };

/** Weekday keys for a quiet-hours schedule, Sunday first to match `Date#getUTCDay`. */
export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/**
 * Quiet hours that differ by day. A working week is not Monday to Friday everywhere,
 * and a holiday is not a weekday at all, so the window is resolved per day: a calendar
 * date first, then the weekday, then the default. `null` at any level means the day has
 * no quiet hours.
 *
 * There is no bundled holiday calendar and there will not be one: the dates a caller
 * observes are the caller's to supply, and a bundled calendar goes stale silently.
 */
export type QuietSchedule = {
  default?: QuietWindow | null;
  days?: Partial<Record<Weekday, QuietWindow | null>>;
  dates?: Record<string, QuietWindow | null>;
};

/** Everything the gate knows about the person it might interrupt. */
export interface UserState {
  id: string;
  /** Has the user agreed to proactive behaviour at all? */
  consent: boolean;
  /** Is proactive behaviour switched on for this profile right now? */
  proactiveEnabled?: boolean;
  /** Operating mode of the assistant for this user, e.g. "normal", "focus", "vacation". */
  mode?: string;
  /** Global pause until this instant. */
  snoozedUntil?: Date | string | null;
  /** Candidate types the user has muted. */
  mutedTypes?: string[];
  /** How much the user wants to hear from the assistant. */
  intensity?: "low" | "normal" | "high";
  /** IANA time zone, required for quiet hours. */
  timezone?: string;
  /**
   * Quiet hours in local time, "HH:MM". May cross midnight.
   *
   * One window applies every day. A schedule gives a window per weekday, and per
   * calendar date for the days a weekday cannot express, such as a public holiday:
   *
   * ```ts
   * quietHours: {
   *   default: { start: "22:00", end: "08:00" },
   *   days: { fri: { start: "18:00", end: "00:00" }, sat: { start: "00:00", end: "20:00" } },
   *   dates: { "2026-12-25": { start: "00:00", end: "23:59" } },
   * }
   * ```
   *
   * `null` for a weekday or a date means no quiet hours that day, which is how you
   * carve a working day out of a default. A date beats a weekday, a weekday beats
   * the default. Dates are the user's local calendar dates, "YYYY-MM-DD".
   */
  quietHours?: QuietWindow | QuietSchedule | null;
  /** When the user joined. Drives the trust ramp. */
  createdAt?: Date | string | null;
  /** Surfaces the user allows, in preference order. Defaults to the candidate's surfaces. */
  surfaces?: Surface[];
  /** Named consents a preset can require, e.g. { ad: true, night: false }. */
  consents?: Record<string, boolean>;
  /** Last message the user sent to the assistant; drives inbound-window presets. */
  lastInboundAt?: Date | string | null;
  /** True when the user is a minor under the applicable rules. */
  minor?: boolean;
  /** True when a soft opt-in for existing customers applies. */
  existingCustomer?: boolean;
  /**
   * IANA zone the device reports. When it is a valid zone it is the user's effective zone, ahead of
   * `timezone`, for quiet hours, windows and budget days (SPEC 9.2).
   */
  deviceTimezone?: string;
  /**
   * True when the caller's consent lookup failed, so `consent` is unknown rather than false.
   * `consent({ failMode })` then decides per surface (SPEC 9.3).
   */
  consentUnknown?: boolean;
  /** Crisis-support quiet period. While it is after `now`, only `kind: "support"` candidates pass (crisisQuiet). */
  crisisUntil?: Date | string | null;
  /**
   * Delivery and dismissal counts per local hour of day, keyed "0" to "23" in the user's effective zone.
   * deadHours reads them ahead of the counters that `gate.record` writes.
   */
  hourStats?: Record<string, { acted: number; dismissed: number }>;
  /** Pricing or service tier, used to pick a budget limit from `tiers`. */
  tier?: string;
  /** Explicit per-user daily limit. It overrides every tier and the check's own limit when it is a finite number of at least 0. */
  dailyLimit?: number;
}

/** The thing the agent wants to say. */
export interface Candidate {
  /**
   * Names the message in traces and logs. Reusing one does not merge two sends or hide a
   * budget unit, because decision ids are unique per evaluation. To make one event deliver at
   * most once, set `dedupeKey` and enable the `dedupe` check.
   */
  id: string;
  /** A stable category such as "reminder", "insight", "follow_up". Used by mute and cooldown. */
  type: string;
  priority?: Priority;
  /** Surfaces this candidate can be delivered on, in preference order. */
  surfaces?: Surface[];
  /** Channel or chat the message goes to; rate limits keyed by channel read it. */
  channel?: string;
  /** The caller's own signal that the user is busy right now; boundedDeferral reads it. */
  busy?: boolean;
  /** Caller-estimated probability the user accepts this message; utilityFloor reads it. */
  pAccept?: number;
  /** Caller-estimated probability the user needs it; utilityFloor reads it, default 1. */
  pNeed?: number;
  /**
   * Identity of the underlying event, not of this attempt. `dedupe` claims it once
   * per window, so a webhook redelivered by an at-least-once transport, or the same
   * event picked up by two workers, produces one message rather than two.
   *
   * Derive it from what makes the event the same event: `order:42:shipped`, not a
   * fresh UUID per attempt and not the message text, which usually carries a
   * timestamp and so differs on every retry.
   */
  dedupeKey?: string;
  /** The person asked for this message. trustRamp lets a requested candidate through during the ramp. */
  requested?: boolean;
  /** "commitment" for something the person set up, such as a reminder they asked for; "support" for crisis support. */
  kind?: string;
  /** True for a message the user's own action caused, such as a receipt. Exempt from consent when the consent check allows it. */
  transactional?: boolean;
  /** The instant after which the candidate is stale. freshness rejects it at or after this instant. */
  freshUntil?: Date | string | null;
  /** When the underlying content was created. freshness can reject content older than `maxAgeSeconds`. */
  createdAt?: Date | string | null;
  /** Caller-supplied evidence about the candidate. silence reads it; the gate never does. */
  evidence?: { dataPoints?: number; confidence?: number; newSinceLast?: boolean };
  /** Free-form payload; the gate never reads it. */
  payload?: unknown;
}

export interface EvaluateInput {
  user: UserState;
  candidate: Candidate;
  /** Injected clock for tests and replays. */
  now?: Date;
  /** Operations flags, such as a kill switch that the caller flips at runtime. Every check reads them as `ctx.flags`. */
  flags?: Record<string, boolean>;
}

/** What a single check may say. */
export type CheckOutcome =
  | { kind: "pass"; reason?: string; nearLimit?: { used: number; limit: number } }
  | { kind: "reject"; reason: string }
  | { kind: "adjust"; reason: string; deliverAt?: Date; surfaces?: Surface[] }
  | { kind: "skip"; reason: string }
  | { kind: "defer"; reason: string; retryAt: Date };

export interface CheckContext {
  user: UserState;
  candidate: Candidate;
  now: Date;
  priority: Priority;
  store: Store;
  /** Surfaces still on the table after earlier checks. */
  surfaces: Surface[];
  /** Operations flags the caller passed to evaluate. Absent when the caller passed none. */
  flags?: Record<string, boolean>;
}

export interface Check {
  id: string;
  /** True when the check can never reject; it only adjusts timing or surfaces. */
  nonRejecting?: boolean;
  /** True to record what the check would have done without letting it stop evaluation. */
  shadow?: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome> | CheckOutcome;
  /**
   * Called only after this check rejected the candidate. Returns the earliest instant at which
   * this check would stop rejecting it, or null when the check cannot say. It reads no store
   * and never changes a decision; the gate ignores a throw, a null and an instant that is not
   * after `now`.
   */
  nextAllowedAt?(ctx: CheckContext): Promise<Date | null> | Date | null;
  /**
   * Budget-like checks consume one unit at commit time. Return false when the
   * unit was not available (a concurrent delivery took it). The gate calls
   * consume() in check order, once per decision.
   */
  consume?(ctx: CheckContext): Promise<boolean>;
  /**
   * Synchronous sibling of `run`, used by `gate.evaluateSync`. A check that reads the store must offer it, since
   * the store is then read synchronously; a pure check does not need it when `run` returns a non-Promise.
   */
  runSync?(ctx: CheckContext): CheckOutcome;
  /** Synchronous sibling of `consume`, used by `gate.commitSync`. */
  consumeSync?(ctx: CheckContext): boolean;
  /**
   * Gives back the unit that `consume` took, when `gate.release` is called after a committed send that failed.
   * It runs only for a decision that `commit` allowed, at most once per check and decision (the gate claims each check
   * separately), and must never take a counter below zero.
   *
   * A wrapper that forwards `consume` must forward `release`, `runSync` and `consumeSync` too: a wrapper without
   * `release` makes `gate.release` return false for every decision that consumed through it. `cnMinorMode` shows the
   * shape (src/presets.ts).
   */
  release?(ctx: CheckContext): Promise<void>;
}

export interface TraceEntry {
  id: string;
  outcome: CheckOutcome["kind"];
  reason?: string;
  ms: number;
  /** Present when the check ran in shadow mode and would have stopped evaluation. */
  shadow?: boolean;
}

export interface Decision {
  /**
   * Unique per evaluation: userId, candidateId, the instant, then a token for the gate instance
   * and a sequence number. Reusing `candidate.id` does not make two evaluations share an id, so
   * two gates sharing one store never merge their commits; a reused candidate id does not hide a
   * budget unit. commit() is idempotent on this id: a second commit of the same decision returns
   * the first result. To make one event deliver at most once, set `dedupeKey` and enable `dedupe`.
   */
  id: string;
  allowed: boolean;
  userId: string;
  candidateId: string;
  /** Surfaces to route to when allowed. Empty when rejected or deferred. */
  surfaces: Surface[];
  /** Set when a non-rejecting check asked for a later delivery. */
  deliverAt?: Date;
  /** The check that rejected, when rejected. */
  rejectedBy?: string;
  /** The check that deferred, when deferred. */
  deferredBy?: string;
  /** When to evaluate again, when deferred. */
  retryAt?: Date;
  /**
   * Earliest instant at which the check that denied this candidate would stop denying it: the
   * end of quiet hours, the snooze end, or the reset of a daily, weekly or monthly budget. A
   * lower bound, not a promise: a later check can still deny at that instant, so evaluate again
   * then. Absent when allowed, when the denying check cannot say, and when a shadowed check
   * would have denied. For a deferred decision it equals `retryAt`.
   */
  nextAllowedAt?: Date;
  /** Human-readable reason, when rejected or deferred. */
  reason?: string;
  /** Checks in shadow mode that would have rejected or deferred. */
  shadowed: string[];
  /** Budget checks that passed close to their limit. */
  nearLimit: Array<{ check: string; used: number; limit: number }>;
  /** Every check that ran, in order, with what it said. */
  trace: TraceEntry[];
  evaluatedAt: Date;
}

/** Outcome events the gate learns from. */
export type OutcomeEvent = "delivered" | "dismissed" | "acted" | "ignored";

/**
 * Minimal key-value contract. MemoryStore ships with the package; wrap a Redis
 * client with RedisStore. Every method may throw; the gate decides per check
 * whether a store failure fails open or closed.
 */
export interface Store {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Atomic increment. Returns the new value. */
  incr(key: string, ttlSeconds?: number): Promise<number>;
  /**
   * Optional. Atomic increment by `delta` (INCRBY semantics; a negative delta decrements). The TTL, when
   * given, is attached only when the call creates the key, as `incr` does. Without it, `gate.release`
   * returns false and budget refunds are not possible (SPEC 5.9).
   */
  incrBy?(key: string, delta: number, ttlSeconds?: number): Promise<number>;
  del(key: string): Promise<void>;
}

/**
 * A store that also answers synchronously, for `gate.evaluateSync`, `gate.commitSync` and `gate.decideSync`.
 * `MemoryStore` implements it. The methods have the same semantics as their async counterparts.
 */
export interface SyncStore extends Store {
  getSync(key: string): string | null;
  setSync(key: string, value: string, ttlSeconds?: number): void;
  incrSync(key: string, ttlSeconds?: number): number;
  incrBySync?(key: string, delta: number, ttlSeconds?: number): number;
  delSync(key: string): void;
}

/** Observation points. Hooks never change a decision; a throwing hook is reported to `error` and ignored. */
export interface GateHooks {
  before?(ctx: CheckContext, check: Check): void | Promise<void>;
  after?(ctx: CheckContext, check: Check, outcome: CheckOutcome, ms: number): void | Promise<void>;
  error?(ctx: CheckContext, check: Check, error: unknown): void | Promise<void>;
  finally?(decision: Decision): void | Promise<void>;
}

export interface GateOptions {
  checks: Check[];
  store?: Store;
  /**
   * What to do when a store-backed check throws. "open" lets the candidate
   * through and records the failure in the trace; "closed" rejects.
   * Default "open": a Redis outage should not silence every user.
   */
  onStoreError?: "open" | "closed";
  /** Receives every decision. Wire this to your logger. */
  onDecision?: (decision: Decision) => void;
  /** Key prefix for everything the gate writes to the store. */
  keyPrefix?: string;
  /** Observation hooks, e.g. one OpenTelemetry span per check. */
  hooks?: GateHooks;
  /**
   * Insert the `inboundConsent` check right after the check whose id is "consent" (first in the list
   * when there is none). Does nothing when the list already holds an `inboundConsent` check. The
   * stops are written with `gate.inbound.handle`. Default off.
   */
  inboundConsent?: boolean;
}

/** A policy document: the same checks as data. See spec/schema/policy.schema.json. */
export interface Policy {
  specVersion: string;
  onStoreError?: "open" | "closed";
  keyPrefix?: string;
  checks: PolicyEntry[];
}

export type PolicyEntry =
  | ({ id: string; shadow?: boolean } & Record<string, unknown>)
  | ({ preset: string; shadow?: boolean } & Record<string, unknown>);
