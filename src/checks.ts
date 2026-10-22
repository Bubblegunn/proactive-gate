import { PRIORITY_RANK } from "./types.js";
import type { Candidate, Check, CheckContext, CheckOutcome, Priority, QuietSchedule, QuietWindow, Store, SyncStore, Surface, UserState, Weekday } from "./types.js";

const pass: CheckOutcome = { kind: "pass" };
const reject = (reason: string): CheckOutcome => ({ kind: "reject", reason });
const skip = (reason: string): CheckOutcome => ({ kind: "skip", reason });
const defer = (reason: string, retryAt: Date): CheckOutcome => ({ kind: "defer", reason, retryAt });

const atLeast = (priority: Priority, floor: Priority) => PRIORITY_RANK[priority] >= PRIORITY_RANK[floor];

/** An ISO 8601 date-time with no offset. JavaScript would read it in the host zone; the spec reads it as UTC (SPEC 9.1). */
const OFFSETLESS_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

const toDate = (value: Date | string | number | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" && OFFSETLESS_INSTANT.test(value) ? `${value}Z` : value;
  const d = text instanceof Date ? text : new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** A count the caller supplied as evidence: a finite JSON number, else zero (SPEC 9.9). */
const evidenceCount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

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
  return { minutes: hour * 60 + Number(get("minute")), day: `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}` };
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

/** True when `zone` is an IANA name the runtime's Intl knows. */
const isValidZone = (zone: string | undefined): zone is string => {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

/**
 * The zone a user's local clock is read in: `deviceTimezone` when it is a valid IANA name, else
 * `timezone` when it is one, else undefined (SPEC 9.2). Every check that reads a zone, and every
 * budget key, goes through this so the device's zone and the stored zone cannot disagree.
 */
export function effectiveZone(user: Pick<UserState, "deviceTimezone" | "timezone">): string | undefined {
  if (isValidZone(user.deviceTimezone)) return user.deviceTimezone;
  if (isValidZone(user.timezone)) return user.timezone;
  return undefined;
}

/**
 * The zone quiet hours need when `onMissingTimezone` is "reject". The placeholder "UTC" is not a
 * zone the user chose, so it counts as no zone unless a valid `deviceTimezone` is present (SPEC 9.2).
 */
const reportedZone = (user: Pick<UserState, "deviceTimezone" | "timezone">): string | undefined => {
  if (isValidZone(user.deviceTimezone)) return user.deviceTimezone;
  if (isValidZone(user.timezone) && user.timezone !== "UTC") return user.timezone;
  return undefined;
};

/**
 * A UTC instant from calendar fields, without `Date.UTC`'s two-digit-year rule.
 *
 * `Date.UTC(1, 5, 1)` is 1901, not year 1, because years 0 to 99 are read as
 * offsets from 1900. Every date in this file arrives as a "YYYY-MM-DD" that
 * `localClock` already resolved, so a year below 1000 is a real year and not
 * an abbreviation. Reading it as one made `weekdayOf` answer for the wrong
 * century, `dayBefore` miss, and the ISO week arithmetic subtract a 1901 year
 * start from a year-1 instant, which is where `weeklyBudget:u:0001-W-99115`
 * came from.
 */
const utcDate = (year: number, monthIndex: number, day: number): Date => {
  const at = new Date(0);
  at.setUTCFullYear(year, monthIndex, day);
  at.setUTCHours(0, 0, 0, 0);
  return at;
};

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
  return WEEKDAYS[utcDate(y, m - 1, d).getUTCDay()]!;
}

export function dayBefore(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return utcDate(y, m - 1, d - 1).toISOString().slice(0, 10);
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

const MINUTE_MS = 60_000;
const floorMinute = (at: Date) => new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);

/**
 * The earliest minute after `now` at which quiet hours stop applying, or null when none is
 * found within sixteen jumps.
 *
 * Each jump moves to the end of the window that is silencing the current local time, using the
 * local clock at that instant. A daylight-saving change between the two instants makes the jump
 * land an hour early (still quiet, so it jumps again) or an hour late (so it steps back one
 * minute at a time to the first open minute). A window end that falls inside a spring-forward
 * gap therefore resolves to the minute the clocks jump to, and a window that ends inside a
 * repeated autumn hour resolves to its first open minute, even though a later minute of the same
 * hour may be quiet again.
 */
export function quietEndsAt(quiet: QuietWindow | QuietSchedule, timezone: string, now: Date): Date | null {
  const start = floorMinute(now);
  let at = start;
  for (let jump = 0; jump < 16; jump++) {
    const { minutes, day } = localClock(at, timezone);
    const hit = quietAt(quiet, day, minutes);
    if (!hit) {
      for (let back = 0; back < 180; back++) {
        const earlier = new Date(at.getTime() - MINUTE_MS);
        if (earlier <= start) break;
        const before = localClock(earlier, timezone);
        if (quietAt(quiet, before.day, before.minutes)) break;
        at = earlier;
      }
      return at > now ? at : null;
    }
    const untilEnd = (((parseHHMM(hit.window.end) - minutes) % 1440) + 1440) % 1440 || 1;
    at = new Date(at.getTime() + untilEnd * MINUTE_MS);
  }
  return null;
}

/**
 * The first minute after `now` at which `keyAt` answers differently, found by jumping to
 * successive local midnights. Used for counters keyed by local day, ISO week or month, whose
 * reset is the instant their key changes. Returns null when the key does not change within forty days.
 */
export function nextKeyChange(now: Date, timezone: string | undefined, keyAt: (at: Date) => string): Date | null {
  const base = keyAt(now);
  const start = floorMinute(now);
  let at = start;
  for (let jump = 0; jump < 40; jump++) {
    const minutes = timezone ? localClock(at, timezone).minutes : at.getUTCHours() * 60 + at.getUTCMinutes();
    at = new Date(at.getTime() + (1440 - minutes) * MINUTE_MS);
    if (keyAt(at) !== base) {
      for (let back = 0; back < 180; back++) {
        const earlier = new Date(at.getTime() - MINUTE_MS);
        if (earlier <= start || keyAt(earlier) === base) break;
        at = earlier;
      }
      return at;
    }
  }
  return null;
}

const mod1440 = (minutes: number) => ((minutes % 1440) + 1440) % 1440;

/**
 * The earliest minute after `now` whose local time satisfies `ready`, found by moving `jumpTo`
 * minutes at a time on the local clock, as quietEndsAt does. A jump that a daylight-saving change
 * carries past the target lands late, and the walk back to the first ready minute corrects it; a
 * target inside a spring-forward gap resolves to the first minute the clocks show after it.
 * Returns null when no ready minute is found within sixteen jumps.
 */
function firstReadyMinute(now: Date, timezone: string, ready: (minutes: number) => boolean, jumpTo: (minutes: number) => number): Date | null {
  const start = floorMinute(now);
  let at = start;
  for (let jump = 0; jump < 16; jump++) {
    const { minutes } = localClock(at, timezone);
    if (!ready(minutes)) {
      at = new Date(at.getTime() + jumpTo(minutes) * MINUTE_MS);
      continue;
    }
    for (let back = 0; back < 180; back++) {
      const earlier = new Date(at.getTime() - MINUTE_MS);
      if (earlier <= start || !ready(localClock(earlier, timezone).minutes)) break;
      at = earlier;
    }
    return at > now ? at : null;
  }
  return null;
}

/**
 * A commitment is something the person set up, such as a reminder they asked for (SPEC 9.4). It skips the
 * trust ramp, the dismissal cooldown, mute and every budget, and spends nothing when committed.
 */
const isCommitment = (candidate: Candidate): boolean => candidate.kind === "commitment";

/* ------------------------------------------------------------------------ */
/* The checks, in the default order. Compose your own order freely.  */
/* ------------------------------------------------------------------------ */

/** A production hard-stop that silences every producer at once. */
export function killSwitch(isOn: () => boolean | Promise<boolean>): Check {
  const verdict = (on: boolean): CheckOutcome => (on ? reject("engine kill switch is on") : pass);
  // A callback that returns a plain boolean has a synchronous path; an async callback hands back its promise from
  // runSync, which the gate refuses with a TypeError (SPEC 10.2).
  const run = (): CheckOutcome | Promise<CheckOutcome> => {
    const on = isOn();
    return isPromiseLike(on) ? Promise.resolve(on).then(verdict) : verdict(on);
  };
  return { id: "killSwitch", run, runSync: () => run() as CheckOutcome };
}

/**
 * A kill switch read from the runtime flags the caller passes to evaluate (SPEC 9.13). It rejects only
 * while flag `name` is exactly false. A flag that is absent, or any other value, stops nothing, so a
 * caller that never sets the flag keeps the behaviour it had.
 */
export function killSwitchFlag(name: string): Check {
  return {
    id: "killSwitch",
    run: ({ flags }) => (flags?.[name] === false ? reject(`kill switch is on: flag "${name}" is false`) : pass),
  };
}

/**
 * Consent comes before everything, or you have evaluated preferences for someone who never agreed.
 *
 * When the caller could not look consent up (`consentUnknown` true), the value is not false, it is
 * unknown. `failMode` then decides each surface still on the table: "open" keeps it, "closed" drops it,
 * and a surface with no entry takes `failMode.default`, else "closed" (SPEC 9.3). When no surface stays
 * open the candidate is rejected. A known consent is unaffected by `failMode`.
 */
export function consent(options: { failMode?: Record<string, "open" | "closed"> } = {}): Check {
  const modeFor = (surface: Surface) => options.failMode?.[surface] ?? options.failMode?.default ?? "closed";
  return {
    id: "consent",
    run: ({ user, surfaces }) => {
      if (user.consentUnknown !== true) return user.consent ? pass : reject("user has not consented to proactive behaviour");
      const open = surfaces.filter((surface) => modeFor(surface) === "open");
      if (open.length === 0) return reject("consent could not be determined and no surface on the table fails open");
      return { kind: "adjust", reason: `consent could not be determined; keeping ${open.join(", ")}`, surfaces: open };
    },
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
    nextAllowedAt: ({ user }) => toDate(user.snoozedUntil),
  };
}

/** Per-type mute. */
export function mute(): Check {
  return {
    id: "mute",
    run: ({ user, candidate }) =>
      !isCommitment(candidate) && user.mutedTypes?.includes(candidate.type) ? reject(`type "${candidate.type}" is muted by the user`) : pass,
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
export function quietHours(options: { priorityFloor?: Priority; onMissingTimezone?: "skip" | "reject" } = {}): Check {
  const floor = options.priorityFloor ?? "critical";
  const rejectWithoutZone = options.onMissingTimezone === "reject";
  const zoneOf = (user: UserState) => (rejectWithoutZone ? reportedZone(user) : effectiveZone(user));
  return {
    id: "quietHours",
    run: ({ user, now, priority }) => {
      // Under "reject" a user with no zone is rejected before quiet hours are looked at, so the rule
      // holds whether or not the user has quiet hours (SPEC 9.2.1).
      const zone = zoneOf(user);
      if (!zone && rejectWithoutZone) return reject("no time zone on the user; quiet hours cannot be evaluated");
      if (!user.quietHours) return pass;
      if (!zone) return skip("quiet hours set but no timezone on the user; cannot evaluate");
      const { minutes, day } = localClock(now, zone);
      const hit = quietAt(user.quietHours, day, minutes);
      if (!hit) return pass;
      if (atLeast(priority, floor)) return pass;
      // Name the day the window came from: when it crossed midnight the reason is
      // yesterday's setting, and a reader looking at today's would not find it.
      const whose = hit.day === day ? "" : ` (${weekdayOf(hit.day)} ${hit.day})`;
      return reject(`quiet hours ${hit.window.start} to ${hit.window.end}${whose} ${zone}; priority ${priority} is below the floor (${floor})`);
    },
    nextAllowedAt: ({ user, now }) => {
      const zone = zoneOf(user);
      return user.quietHours && zone ? quietEndsAt(user.quietHours, zone, now) : null;
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
    run: ({ user, now, priority, candidate }) => {
      // A requested candidate and a commitment are the person's own doing, so the ramp does not apply (SPEC 9.4, 9.5).
      if (candidate.requested === true) return { kind: "pass", reason: "requested by the person; the trust ramp does not apply" };
      if (isCommitment(candidate)) return { kind: "pass", reason: "a commitment the person set up; the trust ramp does not apply" };
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
/** The store as a synchronous store, or a TypeError that says so. The gate checks this first; a check calls it too. */
export function syncStoreOf(store: Store): SyncStore {
  const candidate = store as Partial<SyncStore>;
  if (typeof candidate.getSync !== "function" || typeof candidate.incrSync !== "function" || typeof candidate.setSync !== "function" || typeof candidate.delSync !== "function")
    throw new TypeError("this check needs a store with synchronous methods for the synchronous path");
  return store as SyncStore;
}

export function dismissalCooldown(options: { dismissals?: number; withinDays?: number; silenceDays?: number; exemptTypes?: string[] } = {}): Check {
  const n = options.dismissals ?? 3;
  const withinDays = options.withinDays ?? 30;
  const silenceDays = options.silenceDays ?? 7;
  const exempt = options.exemptTypes ?? [];
  // The cooldown's pure parts: what is decided before the store is read, and the verdict once it is.
  const cooldownEarly = (candidate: Candidate): CheckOutcome | null => {
    if (isCommitment(candidate)) return { kind: "pass", reason: "a commitment the person set up; the dismissal cooldown does not apply" };
    // Types the caller lists are never silenced by the cooldown (SPEC 9.6).
    if (exempt.includes(candidate.type)) return { kind: "pass", reason: `type "${candidate.type}" is exempt from the dismissal cooldown` };
    return null;
  };
  const cooldownVerdict = (candidate: Candidate, now: Date, raw: string | null): CheckOutcome => {
    const stamps: number[] = raw ? JSON.parse(raw) : [];
    const windowStart = now.getTime() - withinDays * DAY_SECONDS * 1000;
    const recent = stamps.filter((t) => t >= windowStart).sort((a, b) => a - b);
    if (recent.length < n) return pass;
    // Silence runs from the most recent dismissal; every further dismissal restarts it.
    const latest = recent[recent.length - 1]!;
    const silentUntil = latest + silenceDays * DAY_SECONDS * 1000;
    if (now.getTime() >= silentUntil) return pass;
    return reject(`${recent.length} dismissals of "${candidate.type}" in ${withinDays} days; silent until ${new Date(silentUntil).toISOString()}`);
  };
  return {
    id: "dismissalCooldown",
    async run({ user, candidate, now, store }) {
      const early = cooldownEarly(candidate);
      if (early) return early;
      return cooldownVerdict(candidate, now, await store.get(dismissalKey(user.id, candidate.type)));
    },
    runSync({ user, candidate, now, store }) {
      const early = cooldownEarly(candidate);
      if (early) return early;
      return cooldownVerdict(candidate, now, syncStoreOf(store).getSync(dismissalKey(user.id, candidate.type)));
    },
  };
}

export const dismissalKey = (userId: string, type: string) => `cooldown:${userId}:${type}`;

/** The store key of one local hour's count of acted or dismissed candidates (SPEC 9.11). */
export const hourKeyFor = (userId: string, hour: number, outcome: "acted" | "dismissed") => `hours:${userId}:${hour}:${outcome}`;

/** The local hour of day, 0 to 23, of an instant in a zone, or its UTC hour when there is no zone (SPEC 9.11). */
export function hourOfDay(now: Date, zone: string | undefined): number {
  return zone ? Math.floor(localClock(now, zone).minutes / 60) : now.getUTCHours();
}

/**
 * Never rejects. Moves a delivery to the user's next good moment when the
 * caller supplies one, and can narrow surfaces. The default keeps the
 * candidate where it is; pass `nextGoodMoment` to plug in your own model.
 */
export function adaptiveTiming(options: {
  nextGoodMoment?: (ctx: CheckContext) => Promise<Date | null> | Date | null;
  surfacesFor?: (ctx: CheckContext) => Surface[] | null;
} = {}): Check {
  const outcomeFor = (ctx: CheckContext, at: Date | null): CheckOutcome => {
    const surfaces = options.surfacesFor ? options.surfacesFor(ctx) : null;
    if (!at && !surfaces) return pass;
    const parts: string[] = [];
    if (at) parts.push(`deliver at ${at.toISOString()}`);
    if (surfaces) parts.push(`surfaces ${surfaces.join(",")}`);
    return { kind: "adjust", reason: parts.join("; "), ...(at ? { deliverAt: at } : {}), ...(surfaces ? { surfaces } : {}) };
  };
  // A synchronous nextGoodMoment keeps the check synchronous; an async one makes run return a promise, and runSync hands
  // that promise back so the gate refuses it (SPEC 10.2).
  const run = (ctx: CheckContext): CheckOutcome | Promise<CheckOutcome> => {
    const at = options.nextGoodMoment ? options.nextGoodMoment(ctx) : null;
    return isPromiseLike(at) ? Promise.resolve(at).then((when) => outcomeFor(ctx, when)) : outcomeFor(ctx, at);
  };
  return { id: "adaptiveTiming", nonRejecting: true, run, runSync: (ctx) => run(ctx) as CheckOutcome };
}

/** True for a promise or thenable. A check that returns one from runSync is refused on the synchronous path. */
const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  (typeof value === "object" || typeof value === "function") && value !== null && typeof (value as { then?: unknown }).then === "function";

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
  /**
   * A limit per `user.tier` (SPEC 9.12). Read after an explicit `user.dailyLimit` and before `limit`, so a
   * tier with no entry falls back to `limit`.
   */
  tiers?: Record<string, number>;
}

/**
 * The limit a budget check applies to this user (SPEC 9.12): an explicit override the check names, else the
 * user's tier from `tiers` when it has one of its own, else the check's own limit. A tier name is looked up
 * on the object's own keys only, so a tier called "constructor" is not a limit.
 */
const limitFor = (base: number, tiers: Record<string, number> | undefined, user: UserState, override?: number): number => {
  if (override !== undefined) return override;
  const tier = user.tier;
  if (tier !== undefined && tiers && Object.prototype.hasOwnProperty.call(tiers, tier)) {
    const limit = tiers[tier];
    if (typeof limit === "number") return limit;
  }
  return base;
};

/** A finite number of at least 0 that the user set as dailyLimit, or undefined. */
const dailyOverride = (user: UserState): number | undefined => {
  const explicit = user.dailyLimit;
  return typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0 ? explicit : undefined;
};

function budget(spec: { id: string; label: string; defaultLimit: number; keyFor: (ctx: CheckContext) => string; ttlSeconds: number; resetsAt?: (ctx: CheckContext) => Date | null; override?: (user: UserState) => number | undefined }, options: BudgetOptions): BudgetCheck {
  const base = options.limit ?? spec.defaultLimit;
  const nearFraction = options.nearLimit ?? 0.8;
  const limitOf = (ctx: CheckContext) => limitFor(base, options.tiers, ctx.user, spec.override?.(ctx.user));
  const bypass = (priority: Priority) => options.bypassPriority !== undefined && atLeast(priority, options.bypassPriority);
  // Budget-like checks skip the count for a priority the caller bypasses and for a commitment.
  const skipped = (ctx: CheckContext) => bypass(ctx.priority) || isCommitment(ctx.candidate);
  // A commitment says why it spent nothing; a bypassed priority passes without a reason, as before.
  const skippedPass = (ctx: CheckContext): CheckOutcome => (isCommitment(ctx.candidate) ? { kind: "pass", reason: "a commitment the person set up; it spends no budget" } : pass);
  const verdict = (ctx: CheckContext, used: number): CheckOutcome => {
    const limit = limitOf(ctx);
    if (used >= limit) return reject(`${spec.label} of ${limit} used (${used})`);
    const nearAt = Math.max(1, Math.ceil(limit * nearFraction));
    return used >= nearAt ? { kind: "pass", reason: `${used} of ${limit} used`, nearLimit: { used, limit } } : pass;
  };
  return {
    id: spec.id,
    limit: base,
    async run(ctx) {
      if (skipped(ctx)) return skippedPass(ctx);
      return verdict(ctx, Number((await ctx.store.get(spec.keyFor(ctx))) ?? 0));
    },
    runSync(ctx) {
      if (skipped(ctx)) return skippedPass(ctx);
      return verdict(ctx, Number(syncStoreOf(ctx.store).getSync(spec.keyFor(ctx)) ?? 0));
    },
    async consume(ctx) {
      if (skipped(ctx)) return true;
      const key = spec.keyFor(ctx);
      const used = await ctx.store.incr(key, spec.ttlSeconds);
      if (used <= limitOf(ctx)) return true;
      // A refused unit was never spent. Give it back, so the counter counts committed units and nothing else.
      if (ctx.store.incrBy) await ctx.store.incrBy(key, -1);
      return false;
    },
    consumeSync(ctx) {
      if (skipped(ctx)) return true;
      const store = syncStoreOf(ctx.store);
      const key = spec.keyFor(ctx);
      const used = store.incrSync(key, spec.ttlSeconds);
      if (used <= limitOf(ctx)) return true;
      if (store.incrBySync) store.incrBySync(key, -1);
      return false;
    },
    async release(ctx) {
      if (bypass(ctx.priority) || isCommitment(ctx.candidate)) return;
      const key = spec.keyFor(ctx);
      if (!ctx.store.incrBy) return;
      // Never below zero: if the counter had already expired or gone, the decrement is undone.
      if ((await ctx.store.incrBy(key, -1, spec.ttlSeconds)) < 0) await ctx.store.incrBy(key, 1, spec.ttlSeconds);
    },
    ...(spec.resetsAt ? { nextAllowedAt: spec.resetsAt } : {}),
  };
}

export const budgetKey = (userId: string, now: Date, timezone?: string) => `budget:${userId}:${localDay(now, timezone)}`;

const isoWeekKey = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = utcDate(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-W${String(week).padStart(2, "0")}`;
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
  return budget({ id: "dailyBudget", label: "daily budget", defaultLimit: 5, override: dailyOverride, keyFor: ({ user, now }) => budgetKey(user.id, now, effectiveZone(user)), ttlSeconds: 2 * DAY_SECONDS, resetsAt: ({ user, now }) => nextKeyChange(now, effectiveZone(user), (at) => budgetKey(user.id, at, effectiveZone(user))) }, options);
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
  return budget({ id: "weeklyBudget", label: "weekly budget", defaultLimit: 20, keyFor: ({ user, now }) => weeklyBudgetKey(user.id, now, effectiveZone(user)), ttlSeconds: 8 * DAY_SECONDS, resetsAt: ({ user, now }) => nextKeyChange(now, effectiveZone(user), (at) => weeklyBudgetKey(user.id, at, effectiveZone(user))) }, options);
}

/** At most `limit` deliveries per user per local calendar month. */
export function monthlyBudget(options: BudgetOptions = {}): BudgetCheck {
  return budget({ id: "monthlyBudget", label: "monthly budget", defaultLimit: 60, keyFor: ({ user, now }) => monthlyBudgetKey(user.id, now, effectiveZone(user)), ttlSeconds: 32 * DAY_SECONDS, resetsAt: ({ user, now }) => nextKeyChange(now, effectiveZone(user), (at) => monthlyBudgetKey(user.id, at, effectiveZone(user))) }, options);
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
  const seenVerdict = (seen: string | null): CheckOutcome => (seen === null ? pass : reject(`already delivered within the last ${label}`));
  return {
    id: "dedupe",
    async run({ user, candidate, store }) {
      if (!candidate.dedupeKey) return skip("no dedupeKey on the candidate; deduplication cannot be evaluated");
      return seenVerdict(await store.get(dedupeKeyFor(user.id, candidate.dedupeKey)));
    },
    runSync({ user, candidate, store }) {
      if (!candidate.dedupeKey) return skip("no dedupeKey on the candidate; deduplication cannot be evaluated");
      return seenVerdict(syncStoreOf(store).getSync(dedupeKeyFor(user.id, candidate.dedupeKey)));
    },
    async consume({ user, candidate, store }) {
      if (!candidate.dedupeKey) return true;
      const claims = await store.incr(dedupeKeyFor(user.id, candidate.dedupeKey), windowSeconds);
      return claims === 1;
    },
    consumeSync({ user, candidate, store }) {
      if (!candidate.dedupeKey) return true;
      return syncStoreOf(store).incrSync(dedupeKeyFor(user.id, candidate.dedupeKey), windowSeconds) === 1;
    },
    /** Releases the claim commit made, so a failed send does not block the retry of the same event. */
    async release({ user, candidate, store }) {
      if (!candidate.dedupeKey) return;
      await store.del(dedupeKeyFor(user.id, candidate.dedupeKey));
    },
  };
}

/** The store key an inbound STOP is recorded under, before the gate's key prefix is added. */
export const inboundKeyFor = (userId: string, channel: string) => `inbound:${userId}:${channel}`;

/**
 * The channel a candidate's inbound consent is read from: its `channel`, else its first
 * surface, else "default". An empty string counts as missing. `inbound.handle` must be given the same
 * string for the same channel.
 */
export const inboundChannelOf = (candidate: Candidate): string => candidate.channel || candidate.surfaces?.[0] || "default";

/**
 * Rejects a candidate on a channel where the user has replied STOP and not yet START.
 * Reads the store the gate was built with, so the state written by `createInboundConsent`
 * must go through that same store. Place it right after `consent()` in the checks list.
 *
 * It follows the gate's onStoreError. The default, "open", lets a candidate through when the store
 * throws, so set "closed" where consent is legally required. Write the stops with `gate.inbound`
 * (or `createInboundConsent`), which uses the same store.
 *
 * This check is a TypeScript extension. It is not in KNOWN_CHECKS, so a JSON policy cannot name it;
 * the spec and schema do not describe it.
 */
export function inboundConsent(): Check {
  const stoppedVerdict = (channel: string, state: string | null): CheckOutcome =>
    state === "stopped" ? reject(`user replied STOP on ${channel}; they have not sent START since`) : pass;
  return {
    id: "inboundConsent",
    run: async ({ user, candidate, store }) => {
      const channel = inboundChannelOf(candidate);
      return stoppedVerdict(channel, await store.get(inboundKeyFor(user.id, channel)));
    },
    runSync: ({ user, candidate, store }) => {
      const channel = inboundChannelOf(candidate);
      return stoppedVerdict(channel, syncStoreOf(store).getSync(inboundKeyFor(user.id, channel)));
    },
  };
}

/**
 * Stale content is not sent (SPEC 9.8). A candidate is refused at or after its `freshUntil` instant. With
 * `maxAgeSeconds` it is also refused when its `createdAt` is older than that. An unreadable instant is refused,
 * since a check that cannot read the date cannot say the content is fresh. With neither field the check skips.
 */
export function freshness(options: { maxAgeSeconds?: number } = {}): Check {
  return {
    id: "freshness",
    run: ({ candidate, now }) => {
      // A JSON null is absent (SPEC 9.8), the same as a missing field.
      const hasUntil = candidate.freshUntil !== undefined && candidate.freshUntil !== null;
      const hasCreated = candidate.createdAt !== undefined && candidate.createdAt !== null;
      if (!hasUntil && !(hasCreated && options.maxAgeSeconds !== undefined)) {
        return skip(hasCreated ? "no maxAgeSeconds set; createdAt is not checked" : "no freshUntil or createdAt on the candidate; freshness cannot be evaluated");
      }
      if (hasUntil) {
        const until = toDate(candidate.freshUntil);
        if (!until) return reject("freshUntil is not a valid instant; treated as expired");
        if (until.getTime() <= now.getTime()) return reject(`expired at ${until.toISOString()}`);
      }
      if (hasCreated && options.maxAgeSeconds !== undefined) {
        const created = toDate(candidate.createdAt);
        if (!created) return reject("createdAt is not a valid instant; treated as expired");
        if (now.getTime() - created.getTime() > options.maxAgeSeconds * 1000) {
          return reject(`expired: created ${created.toISOString()}, older than ${options.maxAgeSeconds} seconds`);
        }
      }
      return pass;
    },
  };
}

/**
 * Refuses a candidate whose caller-supplied evidence is too thin to act on (SPEC 9.9). The gate never reads the
 * evidence itself; the caller fills it. Missing data points or confidence count as zero, so they refuse. With no
 * evidence on the candidate the check skips. `requireNew` refuses a candidate that says it repeats nothing new.
 */
export function silence(options: { minDataPoints?: number; minConfidence?: number; requireNew?: boolean } = {}): Check {
  const minDataPoints = options.minDataPoints ?? 5;
  const minConfidence = options.minConfidence ?? 0.5;
  const requireNew = options.requireNew ?? true;
  return {
    id: "silence",
    run: ({ candidate }) => {
      const evidence = candidate.evidence;
      if (!evidence) return skip("no evidence on the candidate; silence cannot be evaluated");
      const points = evidenceCount(evidence.dataPoints);
      if (points < minDataPoints) return reject(`not enough data: ${points} data points, need ${minDataPoints}`);
      const confidence = evidenceCount(evidence.confidence);
      if (confidence < minConfidence) return reject(`not enough confidence: ${confidence}, need ${minConfidence}`);
      if (requireNew && evidence.newSinceLast === false) return reject("nothing new since the last message");
      return pass;
    },
  };
}

/**
 * While the user is in a crisis-support quiet period (SPEC 9.10), only `kind: "support"` candidates pass. The
 * check reads `user.crisisUntil` and spends nothing. Place it first in the checks list, so no later check can
 * let a message through first.
 */
export function crisisQuiet(): Check {
  return {
    id: "crisisQuiet",
    run: ({ user, candidate, now }) => {
      const until = toDate(user.crisisUntil);
      if (!until || until <= now || candidate.kind === "support") return pass;
      return reject(`crisis quiet period until ${until.toISOString()}; only support messages pass`);
    },
    nextAllowedAt: ({ user }) => toDate(user.crisisUntil),
  };
}

/**
 * Takes push off the table in an hour when the user has acted on too little of what they were sent then (SPEC 9.11).
 * It never rejects; it only narrows the surfaces. The counts are the user's own `hourStats` entry for the hour when
 * the caller supplied one, else the counters `gate.record` wrote. The defaults (five samples, an acted rate below
 * 0.2, priority below high) are judgements, not findings.
 */
export function deadHours(options: { minSamples?: number; maxActRate?: number; minPriority?: Priority } = {}): Check {
  const minSamples = options.minSamples ?? 5;
  const maxActRate = options.maxActRate ?? 0.2;
  const floor = options.minPriority ?? "high";
  // A missing count is zero. A count that is not a number makes the total not finite, and such an hour is not judged dead.
  const countOf = (value: unknown): number => (value === undefined || value === null ? 0 : Number(value));
  const hourVerdict = (hour: number, acted: number, dismissed: number, candidate: Candidate, surfaces: Surface[]): CheckOutcome => {
    const total = acted + dismissed;
    if (!Number.isFinite(total) || total === 0 || total < minSamples || acted / total >= maxActRate) return pass;
    return {
      kind: "adjust",
      reason: `dead hour ${hour}:00: ${acted} of ${total} acted on; push removed for ${candidate.id}`,
      surfaces: surfaces.filter((s) => s !== "push"),
    };
  };
  return {
    id: "deadHours",
    nonRejecting: true,
    async run({ user, candidate, now, priority, surfaces, store }) {
      if (!surfaces.includes("push") || atLeast(priority, floor)) return pass;
      const hour = hourOfDay(now, effectiveZone(user));
      const own = user.hourStats?.[String(hour)];
      const acted = own ? countOf(own.acted) : countOf(await store.get(hourKeyFor(user.id, hour, "acted")));
      const dismissed = own ? countOf(own.dismissed) : countOf(await store.get(hourKeyFor(user.id, hour, "dismissed")));
      return hourVerdict(hour, acted, dismissed, candidate, surfaces);
    },
    runSync({ user, candidate, now, priority, surfaces, store }) {
      if (!surfaces.includes("push") || atLeast(priority, floor)) return pass;
      const hour = hourOfDay(now, effectiveZone(user));
      const own = user.hourStats?.[String(hour)];
      const sync = syncStoreOf(store);
      const acted = own ? countOf(own.acted) : countOf(sync.getSync(hourKeyFor(user.id, hour, "acted")));
      const dismissed = own ? countOf(own.dismissed) : countOf(sync.getSync(hourKeyFor(user.id, hour, "dismissed")));
      return hourVerdict(hour, acted, dismissed, candidate, surfaces);
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

const zoneOf = (ctx: CheckContext, timezone: string) => (timezone === "user" ? effectiveZone(ctx.user) : timezone);

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
    // The earliest local minute the window is open. Null when no zone, or when the window is empty.
    nextAllowedAt: (ctx) => {
      const zone = zoneOf(ctx, options.timezone);
      if (!zone || start === end || (options.priorityFloor && atLeast(ctx.priority, options.priorityFloor))) return null;
      return firstReadyMinute(ctx.now, zone, (minutes) => inWindow(minutes, start, end), (minutes) => mod1440(start - minutes));
    },
  };
}

/**
 * Why a candidate is not promotional, or undefined when it may be promotional (SPEC 9.7): a transactional message
 * the user's own action caused, a message the person requested, or a commitment they set up.
 */
const notPromotional = (candidate: Candidate): string | undefined => {
  if (candidate.transactional === true) return "transactional";
  if (candidate.requested === true) return "requested";
  if (isCommitment(candidate)) return "commitment";
  return undefined;
};

/** Requires `user.consents[name]`, always or only inside a local-time window. */
export function requiresConsent(options: { name: string; when?: { start: string; end: string; timezone: string }; id?: string; exemptTransactional?: boolean }): Check {
  const when = options.when ? { start: parseHHMM(options.when.start), end: parseHHMM(options.when.end), timezone: options.when.timezone } : null;
  return {
    id: options.id ?? `consent:${options.name}`,
    // Only a windowed consent is time-dependent: inside the window a missing consent stops rejecting at the window's end.
    ...(when ? { nextAllowedAt: (ctx: CheckContext) => {
      const zone = zoneOf(ctx, when.timezone);
      if (!zone || when.start === when.end || ctx.user.consents?.[options.name]) return null;
      return firstReadyMinute(ctx.now, zone, (minutes) => !inWindow(minutes, when.start, when.end), (minutes) => mod1440(when.end - minutes));
    } } : {}),
    run: (ctx) => {
      // Marketing consent applies to promotion only (SPEC 9.7). With the option, a transactional, requested or
      // commitment candidate is not promotional and passes without the consent.
      if (options.exemptTransactional) {
        const why = notPromotional(ctx.candidate);
        if (why) return { kind: "pass", reason: `${why}; not promotional, so consent "${options.name}" is not required` };
      }
      if (when) {
        const zone = zoneOf(ctx, when.timezone);
        if (!zone) return skip("no timezone on the user; consent window cannot be evaluated");
        // A bare pass here would be indistinguishable from "the consent is on file",
        // and explain() said exactly that about a consent nobody had given.
        if (!inWindow(localClock(ctx.now, zone).minutes, when.start, when.end))
          return { kind: "pass", reason: `outside the consent window ${options.when!.start} to ${options.when!.end}` };
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

/** The default order, as a starting point. Replace, reorder, or drop checks freely. */
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
  /**
   * Add `inboundConsent` right after `consent`. Off by default: it reads STOP replies that
   * `createInboundConsent` records, so it does nothing unless the caller writes them.
   */
  inboundConsent?: boolean;
} = {}): Check[] {
  return [
    killSwitch(options.killSwitch ?? (() => false)),
    consent(),
    ...(options.inboundConsent ? [inboundConsent()] : []),
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
