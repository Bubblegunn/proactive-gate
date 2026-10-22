import { budgetKey, dismissalKey, DAY_SECONDS, effectiveZone, hourKeyFor, hourOfDay, inboundConsent as inboundConsentCheck } from "./checks.js";
import { createInboundConsent } from "./inbound.js";
import type { InboundConsent } from "./inbound.js";
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
  SyncStore,
  Surface,
  TraceEntry,
  UserState,
} from "./types.js";

/*
 * The gate's view of the caller's store: keys get the prefix, and each optional method exists only when the inner
 * store has it, so `store.incrBy` and `store.getSync` are the honest capability tests.
 */
class PrefixedStore implements Store {
  incrBy?: (key: string, delta: number, ttl?: number) => Promise<number>;
  getSync?: (key: string) => string | null;
  setSync?: (key: string, value: string, ttl?: number) => void;
  incrSync?: (key: string, ttl?: number) => number;
  incrBySync?: (key: string, delta: number, ttl?: number) => number;
  delSync?: (key: string) => void;
  constructor(private readonly inner: Store, private readonly prefix: string) {
    if (inner.incrBy) this.incrBy = (key, delta, ttl) => inner.incrBy!(this.prefix + key, delta, ttl);
    const sync = inner as Partial<SyncStore>;
    if (sync.getSync) this.getSync = (key) => sync.getSync!(this.prefix + key);
    if (sync.setSync) this.setSync = (key, value, ttl) => sync.setSync!(this.prefix + key, value, ttl);
    if (sync.incrSync) this.incrSync = (key, ttl) => sync.incrSync!(this.prefix + key, ttl);
    if (sync.incrBySync) this.incrBySync = (key, delta, ttl) => sync.incrBySync!(this.prefix + key, delta, ttl);
    if (sync.delSync) this.delSync = (key) => sync.delSync!(this.prefix + key);
  }
  get(key: string) { return this.inner.get(this.prefix + key); }
  set(key: string, value: string, ttl?: number) { return this.inner.set(this.prefix + key, value, ttl); }
  incr(key: string, ttl?: number) { return this.inner.incr(this.prefix + key, ttl); }
  del(key: string) { return this.inner.del(this.prefix + key); }
}

/**
 * The object `createGate` returns. `whenAllowed` and `inbound` are required members (see the CHANGELOG
 * entry under Unreleased): a hand-written Gate object, such as a test double, must provide both, or spread
 * a real gate so they come along. Gates from `createGate` have them.
 */
export interface Gate {
  /** Run every check in order. Never throws for a check failure; see the trace. */
  evaluate(input: EvaluateInput): Promise<Decision>;
  /**
   * Asks when the candidate could go out. Evaluates now; a refusal that carries `nextAllowedAt` is
   * evaluated again at that instant, up to `maxHops` times (default 12; a non-finite value means the
   * default, a fraction rounds down, a negative value means 0). Returns the first instant that allows
   * it with the allowing decision, or `{ at: null }` with the last refusal when a refusal has no instant
   * or the hops run out. It only evaluates and never consumes a budget, so commit is still called at
   * the instant the message is sent.
   *
   * Each evaluation is a full decision: `onDecision` and the `before`, `after` and `finally` hooks fire
   * once per evaluation, so one call fires them up to `maxHops + 1` times, and each evaluation gets its
   * own decision id. Callers that count decisions (metrics, audit) must count this, not the calls.
   * A `defer` check is followed like any other time-dependent refusal: a deferral that is a fixed
   * offset from `now` can run out of hops and return `at: null`.
   */
  whenAllowed(input: EvaluateInput, options?: { maxHops?: number }): Promise<{ at: Date | null; decision: Decision }>;
  /**
   * Call right before you actually send. Consumes one unit of every budget-like
   * check, in order, and returns false if a unit was taken by a concurrent
   * delivery in the meantime. Idempotent on decision.id: a second call returns
   * the first result without consuming again.
   */
  commit(decision: Decision, input: EvaluateInput): Promise<boolean>;
  /**
   * Gives back what a committed decision consumed, after the send failed, and returns true when this call refunded at
   * least one check. Every budget-like check gives back its unit, and the dedupe check releases its claim, so the same
   * event can be retried. False when the decision was not committed (or commit was refused), when the store has no
   * incrBy, when every check was already refunded, when a consumer has no `release` (a wrapper must forward it, see
   * Check.release), or when commit recorded nothing for it (no budget or dedupe check).
   * Each check is claimed separately with an atomic increment on `release:<decision id>:<check id>`, so concurrent calls
   * refund each check once. A store error throws; the failed check's claim is removed, so a retry refunds the checks that
   * are not done and never repeats one that is.
   * Read-your-writes: during a release at zero the counter can briefly read -1 before the clamp restores 0. The final
   * state is exact.
   * A unit spent by an earlier check in the same commit stays spent when a later check refuses (SPEC 10.1).
   *
   * Client API, not conformance (SPEC 10.1). Use it only for a send that failed after commit; see the crash trade-off there.
   */
  release(decision: Decision, input: EvaluateInput): Promise<boolean>;
  /**
   * `evaluate` with the store and the checks run synchronously. Runs the same decision logic as `evaluate`. Throws a
   * TypeError (its message says "synchronous") when the store has no synchronous methods or a check has no synchronous
   * path (a custom check whose run or consume returns a promise). Use it only where an async call is impossible (SPEC 10.2).
   */
  evaluateSync(input: EvaluateInput): Decision;
  // Note: a TypeError from the synchronous path escapes without running the finally hook or adding a trace entry; the
  // hooks before it have already fired. That is deliberate: it is a programming error, not a decision.
  /** `commit` synchronously, under the same rules as `evaluateSync`. */
  commitSync(decision: Decision, input: EvaluateInput): boolean;
  /** `evaluateSync`, then `commitSync` when the decision is allowed. */
  decideSync(input: EvaluateInput): { decision: Decision; committed: boolean };
  /** Tell the gate what happened after delivery, so cooldowns can learn. */
  /**
   * Tell the gate what happened after delivery. "dismissed" feeds the dismissal cooldown; "acted" and "dismissed"
   * also count the local hour, which deadHours reads (SPEC 9.11). The zone comes from the user's device or stored zone.
   */
  record(user: Pick<UserState, "id"> & Partial<Pick<UserState, "deviceTimezone" | "timezone">>, candidate: Pick<Candidate, "type">, event: OutcomeEvent, at?: Date): Promise<void>;
  /** Snapshot of the current counters for a user, for debugging and UIs. */
  inspect(user: UserState, now?: Date): Promise<{ budgetUsed: number; dismissals: Record<string, number> }>;
  /**
   * Records inbound STOP and START replies in this gate's own store, under its own keyPrefix, so they
   * are the keys the `inboundConsent` check reads. Use this rather than `createInboundConsent` with a
   * separate keyPrefix. Exists on every gate; only the check that reads it needs `inboundConsent: true`.
   */
  readonly inbound: InboundConsent;
  readonly checks: readonly Check[];
}

/** createGate accepts explicit checks or a JSON policy (see spec/schema/policy.schema.json). */
export interface PolicyGateOptions {
  policy: Policy;
  store?: Store;
  onDecision?: (decision: Decision) => void;
  hooks?: GateHooks;
  /** Adds the `inboundConsent` check after `consent`. See GateOptions.inboundConsent. */
  inboundConsent?: boolean;
}

const COMMIT_TTL = 2 * DAY_SECONDS;
const HOUR_COUNT_TTL = 90 * DAY_SECONDS;

/**
 * A token unique to one gate instance. Decision ids must not collide across
 * processes that share a store: a per-process counter alone gives every
 * worker the same `#1` for the same candidate and instant, and commit would
 * then mistake one worker's decision for another's.
 */
function instanceToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")).join("");
}

/** One step of the decision logic: a request for the driver to answer (see createGate). */
type Req =
  | { op: "hook"; name: keyof GateHooks; fn: (...args: unknown[]) => unknown; args: unknown[] }
  | { op: "run" | "hold" | "consume"; check: Check; ctx: CheckContext }
  | { op: "get"; key: string }
  | { op: "set"; key: string; value: string; ttl: number };
type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };
type Core<T> = Generator<Req, T, unknown>;

const isThenable = (value: unknown): boolean =>
  (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

const hasSyncMethods = (store: Store): boolean =>
  ["getSync", "setSync", "incrSync", "delSync"].every((method) => typeof (store as unknown as Record<string, unknown>)[method] === "function");

export function createGate(options: GateOptions | PolicyGateOptions): Gate {
  if ("policy" in options && "checks" in options) throw new Error("createGate takes either checks or policy, not both");
  const resolved: GateOptions = "policy" in options
    ? { ...compilePolicy(options.policy), ...(options.store ? { store: options.store } : {}), ...(options.onDecision ? { onDecision: options.onDecision } : {}), ...(options.hooks ? { hooks: options.hooks } : {}), ...(options.inboundConsent ? { inboundConsent: true } : {}) }
    : options;
  const store = new PrefixedStore(resolved.store ?? new MemoryStore(), resolved.keyPrefix ?? "pg:");
  const onStoreError = resolved.onStoreError ?? "open";
  const hooks = resolved.hooks ?? {};
  const checks = [...resolved.checks];
  if (resolved.inboundConsent && !checks.some((c) => c.id === "inboundConsent")) {
    // findIndex returns -1 when there is no consent check, and splice(0) then places it first.
    checks.splice(checks.findIndex((c) => c.id === "consent") + 1, 0, inboundConsentCheck());
  }
  const instance = instanceToken();
  let sequence = 0;
  const consumers = checks.filter((c): c is Check & { consume: NonNullable<Check["consume"]> } => typeof c.consume === "function");

  /*
   * The decision logic is written once, as generators that yield every store, check and hook call as a request.
   * `runAsync` answers each request with await; `runSync` answers with a direct call and refuses anything that
   * returns a promise. So evaluate and evaluateSync cannot drift apart: they run the same generator.
   */
  const callHook = (name: keyof GateHooks, ctx: CheckContext | null, check: Check | null, rest: unknown[]): Core<void> => hookStep(name, ctx, check, rest);

  function* hookStep(name: keyof GateHooks, ctx: CheckContext | null, check: Check | null, rest: unknown[]): Core<void> {
    const fn = hooks[name] as ((...args: unknown[]) => unknown) | undefined;
    if (!fn) return;
    try {
      yield { op: "hook", name, fn, args: ctx ? [ctx, check, ...rest] : rest };
    } catch (error) {
      if (name !== "error" && ctx && check) yield* hookStep("error", ctx, check, [error]);
    }
  }

  function* evaluateCore(input: EvaluateInput): Core<Decision> {
    const now = input.now ?? new Date();
    const priority = input.candidate.priority ?? "normal";
    const trace: TraceEntry[] = [];
    const shadowed: string[] = [];
    const nearLimit: Decision["nearLimit"] = [];
    let surfaces: Surface[] = pickSurfaces(input.user, input.candidate);
    let deliverAt: Date | undefined;

    function* finish(partial: Partial<Decision>): Core<Decision> {
      const decision: Decision = {
        id: `${input.user.id}:${input.candidate.id}:${now.toISOString()}#${instance}-${++sequence}`,
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
      yield* callHook("finally", null, null, [decision]);
      return decision;
    }

    function* holdFor(check: Check, ctx: CheckContext): Core<{ nextAllowedAt?: Date }> {
      if (!check.nextAllowedAt) return {};
      try {
        const at = (yield { op: "hold", check, ctx }) as Date | null;
        return at && at.getTime() > now.getTime() ? { nextAllowedAt: at } : {};
      } catch {
        return {};
      }
    }

    for (const check of checks) {
      const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces, ...(input.flags ? { flags: input.flags } : {}) };
      yield* callHook("before", ctx, check, []);
      const started = performance.now();
      let outcome: CheckOutcome;
      try {
        outcome = (yield { op: "run", check, ctx }) as CheckOutcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield* callHook("error", ctx, check, [error]);
        if (onStoreError === "closed") {
          trace.push({ id: check.id, outcome: "reject", reason: `check threw (${message}); failing closed`, ms: elapsed(started) });
          return yield* finish({ rejectedBy: check.id, reason: `check "${check.id}" failed and the gate fails closed: ${message}` });
        }
        trace.push({ id: check.id, outcome: "skip", reason: `check threw (${message}); failing open`, ms: elapsed(started) });
        continue;
      }
      const ms = elapsed(started);
      yield* callHook("after", ctx, check, [outcome, ms]);
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
      if (outcome.kind === "reject") {
        const hold = yield* holdFor(check, ctx);
        return yield* finish({ rejectedBy: check.id, reason: outcome.reason, ...hold });
      }
      if (outcome.kind === "defer") return yield* finish({ deferredBy: check.id, retryAt: outcome.retryAt, reason: outcome.reason, ...(outcome.retryAt.getTime() > now.getTime() ? { nextAllowedAt: outcome.retryAt } : {}) });
      if (outcome.kind === "adjust") {
        if (outcome.deliverAt) deliverAt = outcome.deliverAt;
        if (outcome.surfaces) surfaces = outcome.surfaces;
      }
    }
    return yield* finish({ allowed: true, surfaces, ...(deliverAt ? { deliverAt } : {}) });
  }

  function* commitCore(decision: Decision, input: EvaluateInput): Core<boolean> {
    if (!decision.allowed) return false;
    if (!consumers.length) return true;
    const now = input.now ?? decision.evaluatedAt;
    const priority = input.candidate.priority ?? "normal";
    const marker = `commit:${decision.id}`;
    try {
      const seen = (yield { op: "get", key: marker }) as string | null;
      if (seen !== null) return seen === "1";
      let ok = true;
      for (const check of consumers) {
        const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces: decision.surfaces, ...(input.flags ? { flags: input.flags } : {}) };
        if (!((yield { op: "consume", check, ctx }) as boolean)) { ok = false; break; }
      }
      yield { op: "set", key: marker, value: ok ? "1" : "0", ttl: COMMIT_TTL };
      return ok;
    } catch {
      return onStoreError === "open";
    }
  }

  const release = async (decision: Decision, input: EvaluateInput): Promise<boolean> => {
    // commit writes its marker only when it has consumers, so a gate without any has no record of a committed decision.
    if (!decision.allowed || !consumers.length || !store.incrBy) return false;
    // A consumer that cannot refund makes the whole release a no-op, decided before anything is written.
    if (consumers.some((check) => typeof check.release !== "function")) return false;
    if ((await store.get(`commit:${decision.id}`)) !== "1") return false;
    const now = input.now ?? decision.evaluatedAt;
    const priority = input.candidate.priority ?? "normal";
    let refunded = false;
    for (const check of consumers) {
      // One claim per check: a retry after a failed refund finishes the checks that are not done, and never repeats one that is.
      const claim = `release:${decision.id}:${check.id}`;
      if ((await store.incr(claim, COMMIT_TTL)) !== 1) continue;
      const ctx: CheckContext = { user: input.user, candidate: input.candidate, now, priority, store, surfaces: decision.surfaces, ...(input.flags ? { flags: input.flags } : {}) };
      try {
        await check.release!(ctx);
      } catch (error) {
        // The refund did not happen, so the claim is removed and a retry tries this check again.
        await store.del(claim);
        throw error;
      }
      refunded = true;
    }
    return refunded;
  };

  const evaluate: Gate["evaluate"] = (input) => runAsync(evaluateCore(input));
  const commit: Gate["commit"] = (decision, input) => runAsync(commitCore(decision, input));

  const requireSync = (): void => {
    if (!hasSyncMethods(store)) throw new TypeError("synchronous evaluation needs a store with synchronous methods; MemoryStore has them, this store does not, so use evaluate and commit");
  };
  const evaluateSync: NonNullable<Gate["evaluateSync"]> = (input) => {
    requireSync();
    return runSync(evaluateCore(input));
  };
  const commitSync: NonNullable<Gate["commitSync"]> = (decision, input) => {
    requireSync();
    // Every consumer must have a synchronous path before the first unit is spent, so a refusal spends nothing.
    for (const check of consumers) {
      if (typeof check.consumeSync !== "function") throw new TypeError(`check "${check.id}" has no consumeSync, so commitSync cannot run on the synchronous path (synchronous); no unit was spent`);
    }
    return runSync(commitCore(decision, input));
  };
  const decideSync: NonNullable<Gate["decideSync"]> = (input) => {
    const decision = evaluateSync(input);
    const committed = decision.allowed ? commitSync(decision, input) : false;
    return { decision, committed };
  };

  async function resolveAsync(req: Req): Promise<Settled> {
    try {
      switch (req.op) {
        case "hook": return { ok: true, value: await req.fn(...req.args) };
        case "run": return { ok: true, value: await req.check.run(req.ctx) };
        case "hold": return { ok: true, value: await req.check.nextAllowedAt!(req.ctx) };
        case "consume": return { ok: true, value: await req.check.consume!(req.ctx) };
        case "get": return { ok: true, value: await store.get(req.key) };
        case "set": await store.set(req.key, req.value, req.ttl); return { ok: true, value: undefined };
      }
    } catch (error) {
      return { ok: false, error };
    }
  }

  function resolveSync(req: Req): Settled {
    let value: unknown;
    try {
      switch (req.op) {
        case "hook": value = req.fn(...req.args); break;
        case "run": value = req.check.runSync ? req.check.runSync(req.ctx) : req.check.run(req.ctx); break;
        case "hold": value = req.check.nextAllowedAt!(req.ctx); break;
        case "consume": value = req.check.consumeSync ? req.check.consumeSync(req.ctx) : req.check.consume!(req.ctx); break;
        case "get": value = store.getSync!(req.key); break;
        case "set": store.setSync!(req.key, req.value, req.ttl); value = undefined; break;
      }
    } catch (error) {
      return { ok: false, error };
    }
    if (isThenable(value)) {
      // The promise is not ours to observe; attach a handler so its rejection cannot surface as an unhandled one.
      (value as PromiseLike<unknown>).then(undefined, () => {});
      const who = req.op === "hook" ? `hook "${req.name}"` : req.op === "get" || req.op === "set" ? `the store ${req.op}` : `check "${req.check.id}" (${req.op})`;
      throw new TypeError(`${who} returned a promise; the synchronous path needs synchronous code, so give the check runSync or consumeSync`);
    }
    return { ok: true, value };
  }
  async function runAsync<T>(gen: Core<T>): Promise<T> {
    let step = gen.next();
    while (!step.done) {
      const settled = await resolveAsync(step.value);
      step = settled.ok ? gen.next(settled.value) : gen.throw(settled.error);
    }
    return step.value;
  }

  function runSync<T>(gen: Core<T>): T {
    let step = gen.next();
    while (!step.done) {
      // A TypeError from resolveSync escapes here: the generator is abandoned, which is what a programming error should do.
      const settled = resolveSync(step.value);
      step = settled.ok ? gen.next(settled.value) : gen.throw(settled.error);
    }
    return step.value;
  }

  const whenAllowed: Gate["whenAllowed"] = async (input, options = {}) => {
    // A missing or non-finite bound means the default; a fraction rounds down and a negative one is zero.
    const maxHops = options.maxHops === undefined || !Number.isFinite(options.maxHops) ? 12 : Math.max(0, Math.floor(options.maxHops));
    let at = input.now ?? new Date();
    let decision = await evaluate({ ...input, now: at });
    for (let hop = 0; !decision.allowed; hop++) {
      if (!decision.nextAllowedAt || hop >= maxHops) return { at: null, decision };
      at = decision.nextAllowedAt;
      decision = await evaluate({ ...input, now: at });
    }
    return { at, decision };
  };

  const record: Gate["record"] = async (user, candidate, event, at = new Date()) => {
    if (event === "acted" || event === "dismissed") {
      await store.incr(hourKeyFor(user.id, hourOfDay(at, effectiveZone(user)), event), HOUR_COUNT_TTL);
    }
    if (event !== "dismissed") return;
    const key = dismissalKey(user.id, candidate.type);
    const raw = await store.get(key);
    const stamps: number[] = raw ? JSON.parse(raw) : [];
    const keepFrom = at.getTime() - 90 * DAY_SECONDS * 1000;
    const next = [...stamps.filter((t) => t >= keepFrom), at.getTime()];
    await store.set(key, JSON.stringify(next), 90 * DAY_SECONDS);
  };

  const inspect: Gate["inspect"] = async (user, now = new Date()) => {
    const budgetUsed = Number((await store.get(budgetKey(user.id, now, effectiveZone(user)))) ?? 0);
    const dismissals: Record<string, number> = {};
    for (const type of user.mutedTypes ?? []) {
      const raw = await store.get(dismissalKey(user.id, type));
      dismissals[type] = raw ? (JSON.parse(raw) as number[]).length : 0;
    }
    return { budgetUsed, dismissals };
  };

  const inbound = createInboundConsent({ store, keyPrefix: "" });

  return { evaluate, whenAllowed, commit, release, evaluateSync, commitSync, decideSync, record, inspect, inbound, checks };
}

function pickSurfaces(user: UserState, candidate: Candidate): Surface[] {
  const wanted = candidate.surfaces ?? ["feed"];
  if (!user.surfaces) return wanted;
  const allowed = new Set(user.surfaces);
  return wanted.filter((s) => allowed.has(s));
}

const elapsed = (started: number) => Math.round((performance.now() - started) * 1000) / 1000;
