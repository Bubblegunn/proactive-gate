/**
 * The check most teams write first, and the honest version of "why not a few
 * if statements". It is not a straw man: consent, enabled, mute, quiet hours
 * and a daily cap are the five rules that actually get written, and the three
 * shortcuts below are the three that actually get taken.
 *
 *   1. Quiet hours from a fixed UTC offset per zone, captured once. Correct
 *      until the zone changes offset, which every zone with daylight saving
 *      does twice a year.
 *   2. The daily cap keyed by the UTC calendar day, because `toISOString()`
 *      is right there. The user's day starts somewhere else.
 *   3. The cap read, compared, then written. Two awaits with a gap between
 *      them, so two deliveries in flight both read the same number.
 *
 * It also counts at decide time rather than at send time, so a message that is
 * generated and then dropped downstream still costs the user a slot.
 */

/** Offsets captured once, the way a hand-rolled check captures them. */
export const FIXED_OFFSETS = {
  "Europe/Istanbul": 3,
  "Asia/Tokyo": 9,
  "America/Los_Angeles": -7,
  "America/New_York": -4,
};

const stop = (rule) => ({ allowed: false, rule });

export function createNaive({ limit = 2, offsets = FIXED_OFFSETS } = {}) {
  /** The counter a hand-rolled check keeps: user and day to a number. */
  const counts = new Map();
  const read = async (key) => counts.get(key) ?? 0;
  const write = async (key, value) => void counts.set(key, value);

  const allow = async ({ user, candidate, now }) => {
    if (!user.consent) return stop("consent");
    if (user.proactiveEnabled === false) return stop("enabled");
    if (user.mutedTypes?.includes(candidate.type)) return stop("mute");

    if (user.quietHours) {
      const offset = offsets[user.timezone] ?? 0;
      const local = (now.getUTCHours() + offset + 24) % 24;
      const start = Number(user.quietHours.start.split(":")[0]);
      const end = Number(user.quietHours.end.split(":")[0]);
      const quiet = start < end ? local >= start && local < end : local >= start || local < end;
      if (quiet && candidate.priority !== "critical") return stop("quietHours");
    }

    const key = `${user.id}:${now.toISOString().slice(0, 10)}`;
    const used = await read(key);
    if (used >= limit) return stop("dailyBudget");
    await write(key, used + 1);
    return { allowed: true };
  };

  return { allow, counts };
}
