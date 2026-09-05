/** Priority of a candidate message. Higher priorities may bypass some checks. */
export type Priority = "low" | "normal" | "high" | "critical";

export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, critical: 3 };

/** Where a delivery may land. Free-form so callers can add their own. */
export type Surface = "feed" | "push" | "chat" | "voice" | "email" | (string & {});

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
  /** Quiet hours in local time, "HH:MM". May cross midnight. */
  quietHours?: { start: string; end: string } | null;
  /** When the user joined. Drives the trust ramp. */
  createdAt?: Date | string;
  /** Surfaces the user allows, in preference order. Defaults to the candidate's surfaces. */
  surfaces?: Surface[];
}

/** The thing the agent wants to say. */
export interface Candidate {
  id: string;
  /** A stable category such as "reminder", "insight", "follow_up". Used by mute and cooldown. */
  type: string;
  priority?: Priority;
  /** Surfaces this candidate can be delivered on, in preference order. */
  surfaces?: Surface[];
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
  | { kind: "pass" }
  | { kind: "reject"; reason: string }
  | { kind: "adjust"; reason: string; deliverAt?: Date; surfaces?: Surface[] }
  | { kind: "skip"; reason: string };

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
  run(ctx: CheckContext): Promise<CheckOutcome> | CheckOutcome;
}

export interface TraceEntry {
  id: string;
  outcome: CheckOutcome["kind"];
  reason?: string;
  ms: number;
}

export interface Decision {
  allowed: boolean;
  userId: string;
  candidateId: string;
  /** Surfaces to route to when allowed. Empty when rejected. */
  surfaces: Surface[];
  /** Set when a non-rejecting check asked for a later delivery. */
  deliverAt?: Date;
  /** The check that rejected, when rejected. */
  rejectedBy?: string;
  /** Human-readable reason, when rejected. */
  reason?: string;
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
}
