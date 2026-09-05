import { PRIORITY_RANK } from "./types.js";
import type { Check, CheckContext, CheckOutcome, Priority, QuietSchedule, QuietWindow, Surface, Weekday } from "./types.js";

const pass: CheckOutcome = { kind: "pass" };
const reject = (reason: string): CheckOutcome => ({ kind: "reject", reason });
const skip = (reason: string): CheckOutcome => ({ kind: "skip", reason });
const defer = (reason: string, retryAt: Date): CheckOutcome => ({ kind: "defer", reason, retryAt });

const atLeast = (priority: Priority, floor: Priority) => PRIORITY_RANK[priority] >= PRIORITY_RANK[floor];

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const DAY_SECONDS = 24 * 60 * 60;

/** Local "HH:MM" and calendar day for an instant in an IANA zone, using Intl only. */
export function localClock(now: Date, timezone: string): { minutes: number; day: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  const hour = Number(get("hour")) % 24;
  return { minutes: hour * 60 + Number(get("minute")), day: `${get("year")}-${get("month")}-${get("day")}` };
}

const parseHHMM = (text: string): number => {
  const [h, m] = text.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) throw new Error(`bad time "${text}", expected HH:MM`);
  return h * 60 + m;
};

/** True when `minutes` falls inside [start, end), where the window may cross midnight. */
export function inWindow(minutes: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

const localDay = (now: Date, timezone?: string) => (timezone ? localClock(now, timezone).day : now.toISOString().slice(0, 10));

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * The weekday of a local calendar date, and the date before it.
 *
 * Both are pure calendar arithmetic on the "YYYY-MM-DD" that `localClock` already
 * resolved through Intl, never arithmetic on an instant. That is what keeps zones
 * with a 45-minute offset (Kathmandu, Chatham, Eucla) and every daylight-saving
 * transition out of this: the offset was applied before we got here.
 */
export function weekdayOf(day: string): Weekday {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

export function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const isSchedule = (q: QuietWindow | QuietSchedule): q is QuietSchedule => !("start" in q);

/** The window in force on one local date: a date beats a weekday beats the default. */
export function windowFor(quiet: QuietWindow | QuietSchedule, day: string): QuietWindow | null {
  if (!isSchedule(quiet)) return quiet;
  const byDate = quiet.dates?.[day];
  if (byDate !== undefined) return byDate;
  const byDay = quiet.days?.[weekdayOf(day)];
  if (byDay !== undefined) return byDay;
  return quiet.default ?? null;
}

/**
 * Whether a local time is inside quiet hours, and which day's window says so.
 *
 * A window that crosses midnight belongs to the day it opens on, so a time can be
 * quiet because of yesterday: Friday 18:00 to 00:00 silences Saturday 00:00 too.
 * With one window every day this reduces exactly to `inWindow`, which is why the
 * single-window form keeps behaving as it did.
 */
export function quietAt(quiet: QuietWindow | QuietSchedule, day: string, minutes: number): { window: QuietWindow; day: string } | null {
  const today = windowFor(quiet, day);
  if (today) {
    const start = parseHHMM(today.start);
    const end = parseHHMM(today.end);
    if (start !== end && (start < end ? minutes >= start && minutes < end : minutes >= start)) return { window: today, day };
  }
  const yesterday = windowFor(quiet, dayBefore(day));
  if (yesterday) {
    const start = parseHHMM(yesterday.start);
    const end = parseHHMM(yesterday.end);
    if (start > end && minutes < end) return { window: yesterday, day: dayBefore(day) };
  }
  return null;
}

/* ------------------------------------------------------------------------ */
/* The checks, in the order LILA runs them. Compose your own order freely.  */
/* ------------------------------------------------------------------------ */

/** A production hard-stop that silences every producer at once. */
export function killSwitch(isOn: () => boolean | Promise<boolean>): Check {
  return {
    id: "killSwitch",
    async run() {
      return (await isOn()) ? reject("engine kill switch is on") : pass;
    },
  };
}

/** Consent comes before everything, or you have evaluated preferences for someone who never agreed. */
export function consent(): Check {
  return {
    id: "consent",
    run: ({ user }) => (user.consent ? pass : reject("user has not consented to proactive behaviour")),
  };
}

/** Proactive behaviour switched on for this profile. Defaults to on when undefined. */
export function enabled(): Check {
  return {
    id: "enabled",
    run: ({ user }) => (user.proactiveEnabled === false ? reject("proactive behaviour is disabled on this profile") : pass),
  };
}

/** Only these operating modes may receive proactive messages. Undefined mode passes. */
export function mode(options: { allow: string[] }): Check {
  return {
    id: "mode",
    run: ({ user }) =>
      user.mode !== undefined && !options.allow.includes(user.mode)
        ? reject(`operating mode "${user.mode}" does not allow proactive messages`)
        : pass,
  };
}

/** A global pause until an instant. With `defer: true` the decision carries the instant as `retryAt` instead of rejecting. */
export function snooze(options: { defer?: boolean } = {}): Check {
  return {
    id: "snooze",
    run: ({ user, now }) => {
      const until = toDate(user.snoozedUntil);
      if (!until || until <= now) return pass;
      const reason = `snoozed until ${until.toISOString()}`;
      return options.defer ? defer(reason, until) : reject(reason);
    },
  };
}

/** Per-type mute. */
export function mute(): Check {
  return {
    id: "mute",
    run: ({ user, candidate }) =>
      user.mutedTypes?.includes(candidate.type) ? reject(`type "${candidate.type}" is muted by the user`) : pass,
  };
}

/**
 * The user's intensity setting maps to a priority floor:
 * low hears only high priority, normal hears normal and up, high hears everything.
 */
export function intensity(floors: Record<"low" | "normal" | "high", Priority> = { low: "high", normal: "normal", high: "low" }): Check {
  return {
    id: "intensity",
    run: ({ user, priority }) => {
      const floor = floors[user.intensity ?? "normal"];
      return atLeast(priority, floor) ? pass : reject(`priority ${priority} is below the "${user.intensity ?? "normal"}" intensity floor (${floor})`);
    },
  };
}

/** Timezone-aware quiet hours, bypassed only at or above the priority floor. */
export function quietHours(options: { priorityFloor?: Priority } = {}): Check {
  const floor = options.priorityFloor ?? "critical";
  return {
    id: "quietHours",
    run: ({ user, now, priority }) => {
      if (!user.quietHours) return pass;
      if (!user.timezone) return skip("quiet hours set but no timezone on the user; cannot evaluate");
      const { minutes, day } = localClock(now, user.timezone);
      const hit = quietAt(user.quietHours, day, minutes);
      if (!hit) return pass;
      if (atLeast(priority, floor)) return pass;
      // Name the day the window came from: when it crossed midnight the reason is
      // yesterday's setting, and a reader looking at today's would not find it.
      const whose = hit.day === day ? "" : ` (${weekdayOf(hit.day)} ${hit.day})`;
      return reject(`quiet hours ${hit.window.start} to ${hit.window.end}${whose} ${user.timezone}; priority ${priority} is below the floor (${floor})`);
    },
  };
}

/**
 * For the first `days` after sign-up the user hears from the system only at
 * or above `minPriority`. A proactive assistant is least calibrated exactly
 * when the user is least forgiving.
 *
 * Seven days is a judgement, not a finding. No study sets this number, and
 * none of the literature the package cites speaks to it.
 */
export function trustRamp(options: { days?: number; minPriority?: Priority } = {}): Check {
  const days = options.days ?? 7;
  const floor = options.minPriority ?? "high";
  return {
    id: "trustRamp",
    run: ({ user, now, priority }) => {
      const created = toDate(user.createdAt);
      if (!created) return skip("no createdAt on the user; ramp cannot be evaluated");
      const age = (now.getTime() - created.getTime()) / (DAY_SECONDS * 1000);
      if (age >= days) return pass;
      return atLeast(priority, floor) ? pass : reject(`trust ramp: day ${Math.floor(age) + 1} of ${days}, priority ${priority} is below ${floor}`);
    },
  };
}

/**
 * When the user has dismissed `dismissals` candidates of a type within
 * `withinDays`, that type stays silent for `silenceDays`. Fed by
 * gate.record(userId, candidate, "dismissed").
 *
 * Three in thirty buying seven days is a judgement, not a finding. The shape
 * is defensible, since a dismissal is the clearest signal a user gives; the
 * three numbers are ours and no study sets them.
 */
export function dismissalCooldown(options: { dismissals?: number; withinDays?: number; silenceDays?: number } = {}): Check {
  const n = options.dismissals ?? 3;
  const withinDays = options.withinDays ?? 30;
  const silenceDays = options.silenceDays ?? 7;
  return {
    id: "dismissalCooldown",
    async run({ user, candidate, now, store }) {
      const key = dismissalKey(user.id, candidate.type);
      const raw = await store.get(key);
      const stamps: number[] = raw ? JSON.parse(raw) : [];
      const windowStart = now.getTime() - withinDays * DAY_SECONDS * 1000;
      const recent = stamps.filter((t) => t >= windowStart).sort((a, b) => a - b);
      if (recent.length < n) return pass;
      // Silence runs from the most recent dismissal; every further dismissal restarts it.
      const latest = recent[recent.length - 1]!;
      const silentUntil = latest + silenceDays * DAY_SECONDS * 1000;
      if (now.getTime() >= silentUntil) return pass;
      return reject(`${recent.length} dismissals of "${candidate.type}" in ${withinDays} days; silent until ${new Date(silentUntil).toISOString()}`);
    },
  };
}

export const dismissalKey = (userId: string, type: string) => `cooldown:${userId}:${type}`;

/**
 * Never rejects. Moves a delivery to the user's next good moment when the
 * caller supplies one, and can narrow surfaces. The default keeps the
 * candidate where it is; pass `nextGoodMoment` to plug in your own model.
 */
export function adaptiveTiming(options: {
  nextGoodMoment?: (ctx: CheckContext) => Promise<Date | null> | Date | null;
  surfacesFor?: (ctx: CheckContext) => Surface[] | null;
} = {}): Check {
  return {
    id: "adaptiveTiming",
    nonRejecting: true,
    async run(ctx) {
      const at = options.nextGoodMoment ? await options.nextGoodMoment(ctx) : null;
      const surfaces = options.surfacesFor ? options.surfacesFor(ctx) : null;
      if (!at && !surfaces) return pass;
      const parts: string[] = [];
      if (at) parts.push(`deliver at ${at.toISOString()}`);
      if (surfaces) parts.push(`surfaces ${surfaces.join(",")}`);
      return { kind: "adjust", reason: parts.join("; "), ...(at ? { deliverAt: at } : {}), ...(surfaces ? { surfaces } : {}) };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Budgets. The check reads the counter; gate.commit() calls consume(),      */
/* which increments atomically and can still refuse when two instances race. */
/* ------------------------------------------------------------------------ */

export interface BudgetCheck extends Check {
  limit: number;
  consume(ctx: CheckContext): Promise<boolean>;
}

export interface BudgetOptions {
  limit?: number;
  bypassPriority?: Priority;
  /** Fraction of the limit at which a pass carries a nearLimit note. Default 0.8. */
  nearLimit?: number;
}

function budget(spec: { id: string; label: string; defaultLimit: number; keyFor: (ctx: CheckContext) => string; ttlSeconds: number }, options: BudgetOptions): BudgetCheck {
  const limit = options.limit ?? spec.defaultLimit;
  const nearAt = Math.max(1, Math.ceil(limit * (options.nearLimit ?? 0.8)));
  const bypass = (priority: Priority) => options.bypassPriority !== undefined && atLeast(priority, options.bypassPriority);
  return {
    id: spec.id,
    limit,
    async run(ctx) {
      if (bypass(ctx.priority)) return pass;
      const used = Number((await ctx.store.get(spec.keyFor(ctx))) ?? 0);
      if (used >= limit) return reject(`${spec.label} of ${limit} used (${used})`);
      return used >= nearAt ? { kind: "pass", reason: `${used} of ${limit} used`, nearLimit: { used, limit } } : pass;
    },
    async consume(ctx) {
      if (bypass(ctx.priority)) return true;
      const used = await ctx.store.incr(spec.keyFor(ctx), spec.ttlSeconds);
      return used <= limit;
    },
  };
}

export const budgetKey = (userId: string, now: Date, timezone?: string) => `budget:${userId}:${localDay(now, timezone)}`;

const isoWeekKey = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};

export const weeklyBudgetKey = (userId: string, now: Date, timezone?: string) => `weeklyBudget:${userId}:${isoWeekKey(localDay(now, timezone))}`;

export const monthlyBudgetKey = (userId: string, now: Date, timezone?: string) => `monthlyBudget:${userId}:${localDay(now, timezone).slice(0, 7)}`;

/**
 * At most `limit` deliveries per user per local day.
 *
 * Five is a judgement, not a finding. The direction has support: Pielot and
 * Rello, "Productive, Anxious, Lonely: 24 Hours Without Push Notifications",
 * MobileHCI 2017 (https://arxiv.org/abs/1612.02314), cite an in-situ log study
 * (Pielot, Church and de Oliveira, MobileHCI 2014) in which participants
 * received a median of 63.5 notifications a day, so a handful is far below the
 * ambient load. Nothing in that work says five.
 */
export function dailyBudget(options: BudgetOptions = {}): BudgetCheck {
  return budget({ id: "dailyBudget", label: "daily budget", defaultLimit: 5, keyFor: ({ user, now }) => budgetKey(user.id, now, user.timezone), ttlSeconds: 2 * DAY_SECONDS }, options);
}

/**
 * At most `limit` deliveries per user per local ISO week.
 *
 * The week is the ISO week, so the counter resets on Monday morning in the
 * user's zone. For a Sunday-to-Thursday working week that reset lands
 * mid-week. Documented rather than fixed; changing it would move every
 * existing key.
 */
export function weeklyBudget(options: BudgetOptions = {}): BudgetCheck {
  return budget({ id: "weeklyBudget", label: "weekly budget", defaultLimit: 20, keyFor: ({ user, now }) => weeklyBudgetKey(user.id, now, user.timezone), ttlSeconds: 8 * DAY_SECONDS }, options);
}

/** At most `limit` deliveries per user per local calendar month. */
export function monthlyBudget(options: BudgetOptions = {}): BudgetCheck {
  return budget({ id: "monthlyBudget", label: "monthly budget", defaultLimit: 60, keyFor: ({ user, now }) => monthlyBudgetKey(user.id, now, user.timezone), ttlSeconds: 32 * DAY_SECONDS }, options);
}

export const dedupeKeyFor = (userId: string, key: string) => `dedupe:${userId}:${key}`;

const humanWindow = (seconds: number): string => {
  if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
};

/**
 * One delivery per event per window, claimed atomically at commit time.
 *
 * Message transports deliver at least once. A webhook that does not get its 200
 * quickly enough arrives again, and two workers can pick up the same event at the
 * same moment. Both attempts then evaluate against a store where nothing has been
 * recorded yet, so a check that only reads cannot separate them: it has to claim.
 * `consume()` claims with an atomic increment, the same primitive the budgets use,
 * and only the caller that gets the first increment may send.
 *
 * Order matters and is the reason this check consumes before the budgets: when it
 * loses the race the gate stops there, so the duplicate never spends one of the
 * user's messages for the day. The cost of that ordering, stated rather than hidden:
 * the key is claimed before a later budget check runs, so an event that clears
 * dedupe and is then refused by an exhausted budget has burnt its key for the rest
 * of the window.
 *
 * The window is fixed from the first claim rather than sliding; every store here
 * keeps the original expiry when a key is incremented again.
 *
 * `candidate.dedupeKey` is the caller's, because only the caller knows what makes
 * two attempts the same event. Without it the check skips rather than guessing: a
 * dedupe keyed on something unique per attempt silently does nothing, which is
 * worse than not running.
 *
 * The 24-hour default is the common convention for how long a retry may arrive:
 * Stripe prunes an idempotency key "after they're at least 24 hours old"
 * (https://docs.stripe.com/api/idempotent_requests), and Nylas gives the same
 * figure as the safe default for webhook deduplication
 * (https://developer.nylas.com/docs/cookbook/agent-accounts/prevent-duplicate-replies/).
 * Pick your own from your transport's retry horizon.
 */
export function dedupe(options: { windowSeconds?: number } = {}): Check {
  const windowSeconds = options.windowSeconds ?? DAY_SECONDS;
  const label = humanWindow(windowSeconds);
  return {
    id: "dedupe",
    async run({ user, candidate, store }) {
      if (!candidate.dedupeKey) return skip("no dedupeKey on the candidate; deduplication cannot be evaluated");
      const seen = await store.get(dedupeKeyFor(user.id, candidate.dedupeKey));
      return seen === null ? pass : reject(`already delivered within the last ${label}`);
    },
    async consume({ user, candidate, store }) {
      if (!candidate.dedupeKey) return true;
      const claims = await store.incr(dedupeKeyFor(user.id, candidate.dedupeKey), windowSeconds);
      return claims === 1;
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Optional, caller-fed checks. Off by default; the package ships no model.  */
/* ------------------------------------------------------------------------ */

/**
 * Expected-utility alerting: act only when the caller's estimate of acceptance
 * clears tau = cFA / (cFA + pNeed * cFN). That threshold is the classical Bayes
 * decision boundary between the cost of alerting when the user did not want it,
 * (1 - p) * cFA, and the cost of staying silent when they did, p * cFN.
 * The alerting application is Horvitz, Jacobs and Hovel, "Attention-Sensitive
 * Alerting", UAI 1999 (https://arxiv.org/abs/1301.6707); the system in that
 * paper is named Priorities.
 * `candidate.pAccept` and `candidate.pNeed` come from the caller's own model.
 */
export function utilityFloor(options: { costFalseAlarm: number; costMissedHelp: number }): Check {
  const { costFalseAlarm: cFA, costMissedHelp: cFN } = options;
  return {
    id: "utilityFloor",
    run: ({ candidate }) => {
      if (typeof candidate.pAccept !== "number") return skip("no pAccept on the candidate; utility floor cannot be evaluated");
      const pNeed = typeof candidate.pNeed === "number" ? candidate.pNeed : 1;
      const tau = cFA / (cFA + pNeed * cFN);
      return candidate.pAccept >= tau ? pass : reject(`pAccept ${round3(candidate.pAccept)} < tau ${round3(tau)}`);
    },
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Bounded deferral: when the user is busy, wait t* = min(bound,
 * lambda * interruptCost / (2 * staleness)), the optimum of a quadratic
 * staleness loss against the cost of interrupting a busy person, with the
 * user becoming free at rate lambda. Never rejects; only moves deliverAt.
 *
 * The derivation is Achlioptas and Horvitz, "Principles of Bounded Deferral
 * for Balancing Information Awareness with Interruption", Microsoft Research
 * (http://erichorvitz.com/Bounded_Deferral.pdf): the expected cost is
 * stationary where f'(t0) = lambda * c with f''(t0) > 0, so a quadratic
 * staleness f(t) = s * t^2 gives t* = lambda * c / (2 * s).
 *
 * `lambda` defaults to 1/43 from the same paper's field study: 113 Microsoft
 * employees (42 program managers, 25 developers, 19 testers, 10 administrators,
 * 9 managers, 4 in sales and marketing, 4 research scientists), three
 * sequential business days between 10am and 4pm, 4,803 busy situations, mean
 * busy-session duration 43.12 s with a standard deviation of 51.79 s. That
 * spread matters: the same paper's two-subject Interruption Workbench analysis
 * puts the mean time to a lower-cost state after an alert at 11 s for one
 * person and 101 s for the other. Measure your own users before trusting it.
 *
 * `staleness` and `boundSeconds` are scale choices, not findings. Only the
 * ratio interruptCost / staleness affects t*, so the pair below is one way to
 * express "a few minutes"; nothing in the literature fixes either number.
 */
export function boundedDeferral(options: {
  lambda?: number;
  interruptCost?: number;
  staleness?: number;
  boundSeconds?: number;
  isBusy?: (ctx: CheckContext) => boolean;
} = {}): Check {
  const lambda = options.lambda ?? 1 / 43;
  const cost = options.interruptCost ?? 1;
  const staleness = options.staleness ?? 0.0001;
  const bound = options.boundSeconds ?? 240;
  const tStar = Math.min(bound, (lambda * cost) / (2 * staleness));
  return {
    id: "boundedDeferral",
    nonRejecting: true,
    run: (ctx) => {
      const busy = options.isBusy ? options.isBusy(ctx) : ctx.candidate.busy === true;
      if (!busy) return pass;
      const at = new Date(ctx.now.getTime() + Math.round(tStar * 1000));
      return { kind: "adjust", reason: `user busy; deliver at ${at.toISOString()} (t* ${Math.round(tStar)} s)`, deliverAt: at };
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Primitives the presets compose.                                           */
/* ------------------------------------------------------------------------ */

const zoneOf = (ctx: CheckContext, timezone: string) => (timezone === "user" ? ctx.user.timezone : timezone);

/** Deliveries only inside [start, end) local time in a fixed zone or the user's. */
export function allowedWindow(options: { start: string; end: string; timezone: string; priorityFloor?: Priority; id?: string }): Check {
  const start = parseHHMM(options.start);
  const end = parseHHMM(options.end);
  return {
    id: options.id ?? "allowedWindow",
    run: (ctx) => {
      const zone = zoneOf(ctx, options.timezone);
      if (!zone) return skip("no timezone on the user; window cannot be evaluated");
      if (options.priorityFloor && atLeast(ctx.priority, options.priorityFloor)) return pass;
      const { minutes } = localClock(ctx.now, zone);
      return inWindow(minutes, start, end) ? pass : reject(`outside the allowed window ${options.start} to ${options.end} ${zone}`);
    },
  };
}

/** Requires `user.consents[name]`, always or only inside a local-time window. */
export function requiresConsent(options: { name: string; when?: { start: string; end: string; timezone: string }; id?: string }): Check {
  const when = options.when ? { start: parseHHMM(options.when.start), end: parseHHMM(options.when.end), timezone: options.when.timezone } : null;
  return {
    id: options.id ?? `consent:${options.name}`,
    run: (ctx) => {
      if (when) {
        const zone = zoneOf(ctx, when.timezone);
        if (!zone) return skip("no timezone on the user; consent window cannot be evaluated");
        if (!inWindow(localClock(ctx.now, zone).minutes, when.start, when.end)) return pass;
      }
      return ctx.user.consents?.[options.name] ? pass : reject(`consent "${options.name}" is missing${when ? ` (required ${options.when!.start} to ${options.when!.end})` : ""}`);
    },
  };
}

/** Fixed-window rate limit keyed by user or by candidate.channel; consumed at commit. */
export function rateLimit(options: { limit: number; perSeconds: number; keyBy?: "user" | "channel"; id?: string }): BudgetCheck {
  const keyBy = options.keyBy ?? "user";
  const keyFor = (ctx: CheckContext) => {
    const scope = keyBy === "channel" ? ctx.candidate.channel ?? ctx.user.id : ctx.user.id;
    return `rate:${keyBy}:${scope}:${options.perSeconds}:${Math.floor(ctx.now.getTime() / 1000 / options.perSeconds)}`;
  };
  const id = options.id ?? `rate:${options.limit}/${options.perSeconds}s`;
  return budget({ id, label: `rate limit ${options.limit} per ${options.perSeconds} s`, defaultLimit: options.limit, keyFor, ttlSeconds: options.perSeconds * 2 }, { limit: options.limit, nearLimit: 1 });
}

/** The user wrote to the assistant within the last `withinHours`. */
export function recentInteraction(options: { withinHours: number }): Check {
  return {
    id: "recentInteraction",
    run: ({ user, now }) => {
      const last = toDate(user.lastInboundAt);
      if (!last) return reject("no inbound message from the user on record");
      const age = (now.getTime() - last.getTime()) / 3600000;
      return age <= options.withinHours ? pass : reject(`last inbound message ${Math.floor(age)} h ago, window is ${options.withinHours} h`);
    },
  };
}

/** At most `limit` deliveries in the `withinHours` window that opened with the user's last inbound message. */
export function windowBudget(options: { limit: number; withinHours: number }): BudgetCheck {
  const keyFor = ({ user }: CheckContext) => {
    const last = toDate(user.lastInboundAt);
    return `windowBudget:${user.id}:${last ? Math.floor(last.getTime() / 1000) : "none"}`;
  };
  return budget({ id: "windowBudget", label: `window budget`, defaultLimit: options.limit, keyFor, ttlSeconds: options.withinHours * 3600 }, { limit: options.limit, nearLimit: 1 });
}

/** The LILA order, as a starting point. Replace, reorder, or drop checks freely. */
export function defaultChecks(options: {
  killSwitch?: () => boolean | Promise<boolean>;
  modes?: string[];
  dailyLimit?: number;
  weeklyLimit?: number;
  quietHoursFloor?: Priority;
  /**
   * Add `dedupe` before the budgets. Off by default because it adds an entry to
   * every trace; on, it costs nothing until a candidate carries a `dedupeKey`.
   */
  dedupe?: boolean | { windowSeconds?: number };
} = {}): Check[] {
  return [
    killSwitch(options.killSwitch ?? (() => false)),
    consent(),
    enabled(),
    mode({ allow: options.modes ?? ["normal"] }),
    snooze(),
    mute(),
    intensity(),
    quietHours({ priorityFloor: options.quietHoursFloor ?? "critical" }),
    trustRamp(),
    dismissalCooldown(),
    adaptiveTiming(),
    ...(options.dedupe ? [dedupe(typeof options.dedupe === "object" ? options.dedupe : {})] : []),
    ...(options.weeklyLimit === undefined ? [] : [weeklyBudget({ limit: options.weeklyLimit })]),
    dailyBudget({ limit: options.dailyLimit ?? 5 }),
  ];
}
