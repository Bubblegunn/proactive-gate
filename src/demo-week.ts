/**
 * The week `proactive-gate simulate` runs when you give it nothing of your own.
 *
 * It is a generator plus a seed, not a committed blob, so it is auditable in a way a data file
 * is not: the parameters below are the whole definition, and `--dump-events` writes out exactly
 * what they produced. It adds nothing to the published package.
 *
 * What it is: eight users in five time zones over seven days, with an assistant that fires when
 * its own data arrives rather than when the recipient is awake. That is the ordinary failure
 * mode this library exists for, and it is why candidate instants are drawn uniformly across the
 * UTC day rather than placed politely inside each user's waking hours.
 *
 * What it is not: anybody's real traffic, and not a measurement of one. It cannot tell you how
 * often a real assistant has something to say, whether a message was wanted, or what a user did
 * with it. It measures what a policy does to a stream, which is the only thing a policy decides.
 *
 * What it does not reach, said plainly so nobody reads a clean run as full coverage: every user
 * here has consented and is enabled, so `consent`, `enabled` and `killSwitch` never fire; no
 * dismissals are seeded, so `dismissalCooldown` never fires; no candidate carries a `dedupeKey`,
 * `pAccept` or `busy`, so `dedupe`, `utilityFloor` and `boundedDeferral` stay quiet; and no
 * preset is involved. The checks it does exercise are quiet hours with its priority floor,
 * mode, mute, snooze, intensity, the trust ramp and the daily budget.
 */
import type { Candidate, EvaluateInput, Priority, UserState } from "./types.js";

/** First and last instant of the generated week, inclusive of the first, exclusive of the last. */
export const DEMO_WEEK_START = "2026-09-07T00:00:00.000Z";
export const DEMO_WEEK_DAYS = 7;

/** One line per user, and every field on it is there to make a particular check reachable. */
const PEOPLE: Array<{ user: Omit<UserState, "consent">; why: string }> = [
  {
    user: { id: "ayse", proactiveEnabled: true, mode: "normal", intensity: "normal", timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" }, createdAt: "2026-04-02T00:00:00Z" },
    why: "the ordinary case: an established account with ordinary quiet hours",
  },
  {
    user: { id: "ben", proactiveEnabled: true, mode: "normal", intensity: "low", timezone: "America/New_York", quietHours: { start: "23:00", end: "07:00" }, createdAt: "2026-01-15T00:00:00Z" },
    why: "intensity low, so the floor rises and ordinary messages stop being worth sending",
  },
  {
    user: { id: "chika", proactiveEnabled: true, mode: "normal", intensity: "normal", timezone: "Asia/Tokyo", quietHours: { start: "22:30", end: "06:30" }, createdAt: "2026-09-04T00:00:00Z" },
    why: "three days old at the start of the week, so the trust ramp is still on",
  },
  {
    user: { id: "dilan", proactiveEnabled: true, mode: "normal", intensity: "normal", timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" }, mutedTypes: ["digest"], createdAt: "2026-03-01T00:00:00Z" },
    why: "one type muted, which is a user's own decision and not a budget",
  },
  {
    user: { id: "emre", proactiveEnabled: true, mode: "normal", intensity: "normal", timezone: "America/Sao_Paulo", quietHours: { start: "23:00", end: "07:00" }, snoozedUntil: "2026-09-10T12:00:00Z", createdAt: "2026-02-20T00:00:00Z" },
    why: "snoozed into the middle of the week, so the first days are held rather than dropped",
  },
  {
    user: { id: "fatima", proactiveEnabled: true, mode: "focus", intensity: "normal", timezone: "Europe/London", quietHours: { start: "22:00", end: "07:30" }, createdAt: "2025-11-11T00:00:00Z" },
    why: "in focus mode all week, which the default order only lets critical through",
  },
  {
    user: { id: "gabriel", proactiveEnabled: true, mode: "normal", intensity: "normal", timezone: "America/New_York", quietHours: { start: "00:00", end: "06:00" }, createdAt: "2026-09-06T00:00:00Z" },
    why: "one day old, with a narrow night: a new account is the strictest case there is",
  },
  {
    user: { id: "hana", proactiveEnabled: true, mode: "normal", intensity: "high", timezone: "Asia/Tokyo", quietHours: null, createdAt: "2025-08-01T00:00:00Z" },
    why: "intensity high and no quiet hours at all: the person who wants everything",
  },
];

/** Types an assistant of this shape actually produces, and nothing invented for the demo. */
const TYPES = ["reminder", "insight", "digest", "alert", "nudge"] as const;

/** Priorities, weighted the way a real stream is: mostly ordinary, rarely an emergency. */
const PRIORITIES: Array<{ value: Priority; weight: number }> = [
  { value: "low", weight: 15 },
  { value: "normal", weight: 60 },
  { value: "high", weight: 20 },
  { value: "critical", weight: 5 },
];

/**
 * Candidates per user per day, drawn uniformly from this list: a mean of about three, which is
 * a product that surfaces a couple of reminders, a digest and the occasional alert. Chosen
 * before the run rather than after seeing it, and wide enough that the default daily budget of
 * five binds for the chattier days instead of never being reached.
 */
const PER_DAY = [1, 2, 3, 3, 4, 6];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;

function pickPriority(random: () => number): Priority {
  const total = PRIORITIES.reduce((n, p) => n + p.weight, 0);
  let roll = random() * total;
  for (const p of PRIORITIES) {
    roll -= p.weight;
    if (roll <= 0) return p.value;
  }
  return "normal";
}

/**
 * The generated week, in instant order.
 *
 * Ordered by instant rather than grouped by user because that is the order a server produces
 * them in, and because the budget and the deferral queue both depend on the order they arrive.
 */
export function demoWeek(seed = 7): EvaluateInput[] {
  const random = mulberry32(seed);
  const start = Date.parse(DEMO_WEEK_START);
  const events: EvaluateInput[] = [];
  let n = 0;
  for (const { user } of PEOPLE) {
    for (let day = 0; day < DEMO_WEEK_DAYS; day += 1) {
      const count = pick(random, PER_DAY);
      for (let i = 0; i < count; i += 1) {
        const minuteOfDay = Math.floor(random() * 24 * 60);
        const at = new Date(start + day * 86400000 + minuteOfDay * 60000);
        const candidate: Candidate = {
          id: `c${(n += 1)}`,
          type: pick(random, TYPES),
          priority: pickPriority(random),
          surfaces: ["push", "feed"],
        };
        events.push({ user: { ...user, consent: true }, candidate, now: at });
      }
    }
  }
  return events.sort((a, b) => (a.now?.getTime() ?? 0) - (b.now?.getTime() ?? 0));
}

/** One line per person, for the footer of the table, so the week is legible without reading code. */
export const demoWeekPeople = (): string[] => PEOPLE.map(({ user, why }) => `${user.id} (${user.timezone}): ${why}`);

/** What the week is and is not, printed under any table built from it. */
export const DEMO_WEEK_NOTE = [
  "This is a generated week, not anybody's traffic: eight users in five time zones over seven days,",
  "with candidate instants drawn uniformly across the UTC day, which is how an assistant that fires",
  "when its data arrives meets a person who is asleep. It measures what a policy does to a stream.",
  "It cannot tell you whether a message was wanted, or what its recipient did with it.",
  "Every user here has consented and no dismissals are seeded, so consent, enabled, killSwitch,",
  "dedupe and dismissalCooldown never fire in this run. Point --events at your own JSONL for a",
  "number about your own traffic.",
].join("\n");
