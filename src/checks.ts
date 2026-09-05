import { PRIORITY_RANK } from "./types.js";
import type { Check, CheckContext, CheckOutcome, Priority, Surface } from "./types.js";

const pass: CheckOutcome = { kind: "pass" };
const reject = (reason: string): CheckOutcome => ({ kind: "reject", reason });
const skip = (reason: string): CheckOutcome => ({ kind: "skip", reason });

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

/** A global pause until an instant. */
export function snooze(): Check {
  return {
    id: "snooze",
    run: ({ user, now }) => {
      const until = toDate(user.snoozedUntil);
      return until && until > now ? reject(`snoozed until ${until.toISOString()}`) : pass;
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
      const { minutes } = localClock(now, user.timezone);
      const start = parseHHMM(user.quietHours.start);
      const end = parseHHMM(user.quietHours.end);
      if (!inWindow(minutes, start, end)) return pass;
      if (atLeast(priority, floor)) return pass;
      return reject(`quiet hours ${user.quietHours.start} to ${user.quietHours.end} ${user.timezone}; priority ${priority} is below the floor (${floor})`);
    },
  };
}

/**
 * For the first `days` after sign-up the user hears from the system only at
 * or above `minPriority`. A proactive assistant is least calibrated exactly
 * when the user is least forgiving.
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

/**
 * At most `limit` deliveries per user per local day. The check reads the
 * counter; gate.commit() increments it atomically and can still refuse when
 * two instances race, which is the only race-safe place to enforce a cap.
 */
export interface BudgetCheck extends Check {
  limit: number;
}

export function dailyBudget(options: { limit?: number; bypassPriority?: Priority } = {}): BudgetCheck {
  const limit = options.limit ?? 5;
  return {
    id: "dailyBudget",
    limit,
    async run({ user, now, store, priority }) {
      if (options.bypassPriority && atLeast(priority, options.bypassPriority)) return pass;
      const key = budgetKey(user.id, now, user.timezone);
      const used = Number((await store.get(key)) ?? 0);
      return used < limit ? pass : reject(`daily budget of ${limit} used (${used})`);
    },
  };
}

export const budgetKey = (userId: string, now: Date, timezone?: string) =>
  `budget:${userId}:${timezone ? localClock(now, timezone).day : now.toISOString().slice(0, 10)}`;

/** The LILA order, as a starting point. Replace, reorder, or drop checks freely. */
export function defaultChecks(options: {
  killSwitch?: () => boolean | Promise<boolean>;
  modes?: string[];
  dailyLimit?: number;
  quietHoursFloor?: Priority;
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
    dailyBudget({ limit: options.dailyLimit ?? 5 }),
  ];
}
