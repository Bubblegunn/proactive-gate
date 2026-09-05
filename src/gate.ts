import { budgetKey, dismissalKey, DAY_SECONDS } from "./checks.js";
import { MemoryStore } from "./stores.js";
import type {
  Candidate,
  Check,
  CheckContext,
  Decision,
  EvaluateInput,
  GateOptions,
  OutcomeEvent,
  Store,
  Surface,
  TraceEntry,
  UserState,
} from "./types.js";

class PrefixedStore implements Store {
  constructor(private readonly inner: Store, private readonly prefix: string) {}
  get(key: string) { return this.inner.get(this.prefix + key); }
  set(key: string, value: string, ttl?: number) { return this.inner.set(this.prefix + key, value, ttl); }
  incr(key: string, ttl?: number) { return this.inner.incr(this.prefix + key, ttl); }
  del(key: string) { return this.inner.del(this.prefix + key); }
}

export interface Gate {
  /** Run every check in order. Never throws for a check failure; see the trace. */
  evaluate(input: EvaluateInput): Promise<Decision>;
  /**
   * Call right before you actually send. Atomically consumes one unit of the
   * user's daily budget when a dailyBudget check is configured, and returns
   * false if the budget was exhausted by a concurrent delivery in the meantime.
   */
  commit(decision: Decision, input: EvaluateInput): Promise<boolean>;
  /** Tell the gate what happened after delivery, so cooldowns can learn. */
  record(user: Pick<UserState, "id">, candidate: Pick<Candidate, "type">, event: OutcomeEvent, at?: Date): Promise<void>;
  /** Snapshot of the current counters for a user, for debugging and UIs. */
  inspect(user: UserState, now?: Date): Promise<{ budgetUsed: number; dismissals: Record<string, number> }>;
  readonly checks: readonly Check[];
}

export function createGate(options: GateOptions): Gate {
  const store = new PrefixedStore(options.store ?? new MemoryStore(), options.keyPrefix ?? "pg:");
  const onStoreError = options.onStoreError ?? "open";
  const checks = [...options.checks];
  const budgetCheck = checks.find((c) => c.id === "dailyBudget") as (Check & { limit?: number }) | undefined;

  const evaluate = async (input: EvaluateInput): Promise<Decision> => {
    const now = input.now ?? new Date();
    const priority = input.candidate.priority ?? "normal";
    const trace: TraceEntry[] = [];
    let surfaces: Surface[] = pickSurfaces(input.user, input.candidate);
    let deliverAt: Date | undefined;

    const finish = (partial: Partial<Decision>): Decision => {
      const decision: Decision = {
        allowed: false,
        userId: input.user.id,
        candidateId: input.candidate.id,
        surfaces: [],
        trace,
        evaluatedAt: now,
        ...partial,
      };
      options.onDecision?.(decision);
      return decision;
    };

    for (const check of checks) {
      const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces };
      const started = performance.now();
      let outcome;
      try {
        outcome = await check.run(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (onStoreError === "closed") {
          trace.push({ id: check.id, outcome: "reject", reason: `check threw (${message}); failing closed`, ms: elapsed(started) });
          return finish({ rejectedBy: check.id, reason: `check "${check.id}" failed and the gate fails closed: ${message}` });
        }
        trace.push({ id: check.id, outcome: "skip", reason: `check threw (${message}); failing open`, ms: elapsed(started) });
        continue;
      }
      if (check.nonRejecting && outcome.kind === "reject") {
        // A non-rejecting check that tries to reject is a bug in the check, not a decision about the user.
        trace.push({ id: check.id, outcome: "skip", reason: `non-rejecting check returned reject (${outcome.reason}); ignored`, ms: elapsed(started) });
        continue;
      }
      trace.push({ id: check.id, outcome: outcome.kind, ...(("reason" in outcome && outcome.reason) ? { reason: outcome.reason } : {}), ms: elapsed(started) });
      if (outcome.kind === "reject") {
        return finish({ rejectedBy: check.id, reason: outcome.reason });
      }
      if (outcome.kind === "adjust") {
        if (outcome.deliverAt) deliverAt = outcome.deliverAt;
        if (outcome.surfaces) surfaces = outcome.surfaces;
      }
    }
    return finish({ allowed: true, surfaces, ...(deliverAt ? { deliverAt } : {}) });
  };

  const commit = async (decision: Decision, input: EvaluateInput): Promise<boolean> => {
    if (!decision.allowed) return false;
    if (!budgetCheck) return true;
    const now = input.now ?? new Date();
    const limit = readLimit(budgetCheck);
    try {
      const used = await store.incr(budgetKey(input.user.id, now, input.user.timezone), 2 * DAY_SECONDS);
      return limit === undefined || used <= limit;
    } catch {
      return onStoreError === "open";
    }
  };

  const record: Gate["record"] = async (user, candidate, event, at = new Date()) => {
    if (event !== "dismissed") return;
    const key = dismissalKey(user.id, candidate.type);
    const raw = await store.get(key);
    const stamps: number[] = raw ? JSON.parse(raw) : [];
    const keepFrom = at.getTime() - 90 * DAY_SECONDS * 1000;
    const next = [...stamps.filter((t) => t >= keepFrom), at.getTime()];
    await store.set(key, JSON.stringify(next), 90 * DAY_SECONDS);
  };

  const inspect: Gate["inspect"] = async (user, now = new Date()) => {
    const budgetUsed = Number((await store.get(budgetKey(user.id, now, user.timezone))) ?? 0);
    const dismissals: Record<string, number> = {};
    for (const type of user.mutedTypes ?? []) {
      const raw = await store.get(dismissalKey(user.id, type));
      dismissals[type] = raw ? (JSON.parse(raw) as number[]).length : 0;
    }
    return { budgetUsed, dismissals };
  };

  return { evaluate, commit, record, inspect, checks };
}

function pickSurfaces(user: UserState, candidate: Candidate): Surface[] {
  const wanted = candidate.surfaces ?? ["feed"];
  if (!user.surfaces) return wanted;
  const allowed = new Set(user.surfaces);
  return wanted.filter((s) => allowed.has(s));
}

const elapsed = (started: number) => Math.round((performance.now() - started) * 1000) / 1000;

/** dailyBudget() closes over its limit; expose it through a well-known property for commit(). */
function readLimit(check: Check & { limit?: number }): number | undefined {
  return typeof check.limit === "number" ? check.limit : undefined;
}
