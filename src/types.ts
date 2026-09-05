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
  createdAt?: Date | string;
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
}

/** The thing the agent wants to say. */
export interface Candidate {
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
  /** Free-form payload; the gate never reads it. */
  payload?: unknown;
}

export interface EvaluateInput {
  user: UserState;
  candidate: Candidate;
  /** Injected clock for tests and replays. */
  now?: Date;
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
}

export interface Check {
  id: string;
  /** True when the check can never reject; it only adjusts timing or surfaces. */
  nonRejecting?: boolean;
  /** True to record what the check would have done without letting it stop evaluation. */
  shadow?: boolean;
  run(ctx: CheckContext): Promise<CheckOutcome> | CheckOutcome;
  /**
   * Budget-like checks consume one unit at commit time. Return false when the
   * unit was not available (a concurrent delivery took it). The gate calls
   * consume() in check order, once per decision.
   */
  consume?(ctx: CheckContext): Promise<boolean>;
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
  /** Unique per evaluation: userId, candidateId, the instant and a sequence number. commit() is idempotent on it. */
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
  del(key: string): Promise<void>;
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
