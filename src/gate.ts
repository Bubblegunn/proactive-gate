import { budgetKey, dismissalKey, DAY_SECONDS } from "./checks.js";
import { compilePolicy } from "./policy.js";
import { MemoryStore } from "./stores.js";
import type {
  Candidate,
  Check,
  CheckContext,
  CheckOutcome,
  Decision,
  EvaluateInput,
  GateHooks,
  GateOptions,
  OutcomeEvent,
  Policy,
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
   * Call right before you actually send. Consumes one unit of every budget-like
   * check, in order, and returns false if a unit was taken by a concurrent
   * delivery in the meantime. Idempotent on decision.id: a second call returns
   * the first result without consuming again.
   */
  commit(decision: Decision, input: EvaluateInput): Promise<boolean>;
  /** Tell the gate what happened after delivery, so cooldowns can learn. */
  record(user: Pick<UserState, "id">, candidate: Pick<Candidate, "type">, event: OutcomeEvent, at?: Date): Promise<void>;
  /** Snapshot of the current counters for a user, for debugging and UIs. */
  inspect(user: UserState, now?: Date): Promise<{ budgetUsed: number; dismissals: Record<string, number> }>;
  readonly checks: readonly Check[];
}

/** createGate accepts explicit checks or a JSON policy (see spec/schema/policy.schema.json). */
export interface PolicyGateOptions {
  policy: Policy;
  store?: Store;
  onDecision?: (decision: Decision) => void;
  hooks?: GateHooks;
}

const COMMIT_TTL = 2 * DAY_SECONDS;

export function createGate(options: GateOptions | PolicyGateOptions): Gate {
  if ("policy" in options && "checks" in options) throw new Error("createGate takes either checks or policy, not both");
  const resolved: GateOptions = "policy" in options
    ? { ...compilePolicy(options.policy), ...(options.store ? { store: options.store } : {}), ...(options.onDecision ? { onDecision: options.onDecision } : {}), ...(options.hooks ? { hooks: options.hooks } : {}) }
    : options;
  const store = new PrefixedStore(resolved.store ?? new MemoryStore(), resolved.keyPrefix ?? "pg:");
  const onStoreError = resolved.onStoreError ?? "open";
  const hooks = resolved.hooks ?? {};
  const checks = [...resolved.checks];
  let sequence = 0;
  const consumers = checks.filter((c): c is Check & { consume: NonNullable<Check["consume"]> } => typeof c.consume === "function");

  const callHook = async <K extends keyof GateHooks>(name: K, ctx: CheckContext | null, check: Check | null, ...rest: unknown[]) => {
    const hook = hooks[name] as ((...args: unknown[]) => void | Promise<void>) | undefined;
    if (!hook) return;
    try {
      await hook(...(ctx ? [ctx, check, ...rest] : rest));
    } catch (error) {
      if (name !== "error" && ctx && check) await callHook("error", ctx, check, error);
    }
  };

  const evaluate = async (input: EvaluateInput): Promise<Decision> => {
    const now = input.now ?? new Date();
    const priority = input.candidate.priority ?? "normal";
    const trace: TraceEntry[] = [];
    const shadowed: string[] = [];
    const nearLimit: Decision["nearLimit"] = [];
    let surfaces: Surface[] = pickSurfaces(input.user, input.candidate);
    let deliverAt: Date | undefined;

    const finish = async (partial: Partial<Decision>): Promise<Decision> => {
      const decision: Decision = {
        id: `${input.user.id}:${input.candidate.id}:${now.toISOString()}#${++sequence}`,
        allowed: false,
        userId: input.user.id,
        candidateId: input.candidate.id,
        surfaces: [],
        shadowed,
        nearLimit,
        trace,
        evaluatedAt: now,
        ...partial,
      };
      resolved.onDecision?.(decision);
      await callHook("finally", null, null, decision);
      return decision;
    };

    for (const check of checks) {
      const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces };
      await callHook("before", ctx, check);
      const started = performance.now();
      let outcome: CheckOutcome;
      try {
        outcome = await check.run(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await callHook("error", ctx, check, error);
        if (onStoreError === "closed") {
          trace.push({ id: check.id, outcome: "reject", reason: `check threw (${message}); failing closed`, ms: elapsed(started) });
          return finish({ rejectedBy: check.id, reason: `check "${check.id}" failed and the gate fails closed: ${message}` });
        }
        trace.push({ id: check.id, outcome: "skip", reason: `check threw (${message}); failing open`, ms: elapsed(started) });
        continue;
      }
      const ms = elapsed(started);
      await callHook("after", ctx, check, outcome, ms);
      if (check.nonRejecting && (outcome.kind === "reject" || outcome.kind === "defer")) {
        // A non-rejecting check that tries to stop evaluation is a bug in the check, not a decision about the user.
        trace.push({ id: check.id, outcome: "skip", reason: `non-rejecting check returned ${outcome.kind} (${outcome.reason}); ignored`, ms });
        continue;
      }
      const stops = outcome.kind === "reject" || outcome.kind === "defer";
      const entry: TraceEntry = { id: check.id, outcome: outcome.kind, ms };
      if ("reason" in outcome && outcome.reason) entry.reason = outcome.reason;
      if (stops && check.shadow) entry.shadow = true;
      trace.push(entry);
      if (outcome.kind === "pass" && outcome.nearLimit) nearLimit.push({ check: check.id, ...outcome.nearLimit });
      if (stops && check.shadow) {
        shadowed.push(check.id);
        continue;
      }
      if (outcome.kind === "reject") return finish({ rejectedBy: check.id, reason: outcome.reason });
      if (outcome.kind === "defer") return finish({ deferredBy: check.id, retryAt: outcome.retryAt, reason: outcome.reason });
      if (outcome.kind === "adjust") {
        if (outcome.deliverAt) deliverAt = outcome.deliverAt;
        if (outcome.surfaces) surfaces = outcome.surfaces;
      }
    }
    return finish({ allowed: true, surfaces, ...(deliverAt ? { deliverAt } : {}) });
  };

  const commit = async (decision: Decision, input: EvaluateInput): Promise<boolean> => {
    if (!decision.allowed) return false;
    if (!consumers.length) return true;
    const now = input.now ?? decision.evaluatedAt;
    const priority = input.candidate.priority ?? "normal";
    const marker = `commit:${decision.id}`;
    try {
      const seen = await store.get(marker);
      if (seen !== null) return seen === "1";
      let ok = true;
      for (const check of consumers) {
        const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces: decision.surfaces };
        if (!(await check.consume(ctx))) { ok = false; break; }
      }
      await store.set(marker, ok ? "1" : "0", COMMIT_TTL);
      return ok;
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
