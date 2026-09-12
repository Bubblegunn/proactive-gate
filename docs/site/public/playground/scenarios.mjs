/**
 * The playground's scenarios, the policies behind them, and the run logic they share.
 *
 * This lives beside the page rather than inside it so that test/playground-scenarios.test.mjs
 * can run these exact scenarios through the real library. The verdicts the labels imply are
 * therefore measured, not transcribed, and a label cannot drift away from behaviour: the same
 * file feeds the browser and the test, and the test fails if they disagree.
 *
 * Two policies, deliberately.
 *
 * The default demo is about the user's own preferences and the product's own budget: consent,
 * operating mode, snooze, quiet hours, a trust ramp and a daily limit. Those are the honest
 * constraints on an assistant message.
 *
 * The legal preset gets its own scenario and its own policy, because it answers a different
 * question. Pairing an ordinary reminder with a marketing preset, which is what this page did
 * before, teaches the opposite of what README.md says under "Read the scope before you reach
 * for a legal preset": a reminder the user asked for is not advertising, and importing a
 * marketing restriction onto one is its own kind of wrong answer.
 *
 * Nothing here states a legal conclusion. The scenario shows what the preset does to a
 * decision; whether an instrument applies to your message is not something this page can say.
 */

/**
 * The date the scope wording below was last checked against the preset's own `note` and
 * `sources` in the library. It is not a claim that the underlying primary sources were
 * re-read on that date, and not a legal review.
 */
export const SCOPE_CHECKED = "2026-09-12";

/** Consent, the user's settings, and the product's own limit. No legal instrument. */
const preferenceChecks = [
  { id: "consent" },
  { id: "mode", allow: ["normal", "commute"] },
  { id: "snooze", defer: true },
  { id: "quietHours", priorityFloor: "high" },
  { id: "trustRamp", days: 7, minPriority: "high" },
  { id: "utilityFloor", costFalseAlarm: 1, costMissedHelp: 2, shadow: true },
  { id: "dailyBudget", limit: 3, bypassPriority: "critical", nearLimit: 0.67 },
];

export const preferencePolicy = { specVersion: "1.0.0", checks: preferenceChecks };

/**
 * The same policy with one commercial-communication preset added, in the position a preset
 * entry expands at (spec/SPEC.md 7.2): after the preference checks, before the budget.
 */
export const commercialPolicy = {
  specVersion: "1.0.0",
  checks: [...preferenceChecks.slice(0, 5), { preset: "usTcpa" }, ...preferenceChecks.slice(5)],
};

export const POLICIES = { preference: preferencePolicy, commercial: commercialPolicy };

/**
 * Shown with the commercial scenario, next to the preset's own sourced note. Says what the
 * example is scoped to and what it is not.
 */
export const COMMERCIAL_SCOPE =
  "Scoped to a commercial message. This preset encodes a marketing rule, so it binds a message only when the message is itself commercial. A reminder your user asked for is not advertising, and reaching for a marketing preset for one imports a restriction the law never placed on you. This scenario demonstrates what the preset does to a decision. It is not legal advice, it is not a compliance check, and it does not tell you whether the rule applies to your message.";

const user = {
  id: "ayse", consent: true, mode: "normal", timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" }, createdAt: "2026-01-01T00:00:00Z",
};

const candidate = { id: "a1", type: "reminder", priority: "normal", surfaces: ["push", "feed"], pAccept: 0.41, pNeed: 0.4 };

/**
 * The same message in nine situations. Each entry says what it changes and how many messages
 * were already delivered today, because a budget can only be exhausted by actually spending
 * it: `deliveredToday` commits that many decisions before the one you are shown.
 *
 * `expect` is what the label claims. It is checked against a real run of the library, so if a
 * check changes behaviour the test fails and the label gets corrected rather than the library.
 * That has already happened once on this page.
 */
export const scenarios = [
  { key: "ok", label: "09:00, ordinary day", note: "nothing in the way", policy: "preference",
    now: "2026-09-04T06:00:00Z", expect: { outcome: "allowed", surfaces: ["push", "feed"] } },

  { key: "quiet", label: "23:47, quiet hours", note: "asleep", policy: "preference",
    now: "2026-09-04T20:47:00Z", expect: { outcome: "rejected", by: "quietHours" } },

  { key: "snooze", label: "snoozed until the morning", note: "held, not dropped", policy: "preference",
    now: "2026-09-04T06:00:00Z", user: { snoozedUntil: "2026-09-04T09:00:00Z" },
    expect: { outcome: "deferred", by: "snooze" } },

  { key: "budget", label: "the fourth message today", note: "three already sent", policy: "preference",
    now: "2026-09-04T06:00:00Z", deliveredToday: 3, expect: { outcome: "rejected", by: "dailyBudget" } },

  { key: "bypass", label: "the fourth, but critical", note: "priority does bypass the budget", policy: "preference",
    now: "2026-09-04T06:00:00Z", deliveredToday: 3, candidate: { priority: "critical" },
    expect: { outcome: "allowed", surfaces: ["push", "feed"] } },

  { key: "trust", label: "account is three days old", note: "trust is earned over a week", policy: "preference",
    now: "2026-09-04T06:00:00Z", user: { createdAt: "2026-09-01T00:00:00Z" },
    expect: { outcome: "rejected", by: "trustRamp" } },

  { key: "consent", label: "consent never given", note: "the first check", policy: "preference",
    now: "2026-09-04T06:00:00Z", user: { consent: false }, expect: { outcome: "rejected", by: "consent" } },

  { key: "focus", label: "phone in focus mode", note: "the user's own setting", policy: "preference",
    now: "2026-09-04T06:00:00Z", user: { mode: "focus" }, expect: { outcome: "rejected", by: "mode" } },

  // The only scenario carrying a legal preset, and the only one whose candidate is commercial.
  // Priority clears the quiet-hours floor here and the message still stops: the preset's window
  // carries no priority bypass, so escalating a message does not open it. That is the lesson,
  // and it is the library's behaviour rather than a claim about anyone's obligations.
  { key: "commercial", label: "23:47, a promotion escalated to critical", note: "priority does not open a legal window",
    policy: "commercial", now: "2026-09-04T20:47:00Z",
    candidate: { id: "p1", type: "promotion", priority: "critical" },
    scope: COMMERCIAL_SCOPE, preset: "usTcpa",
    expect: { outcome: "rejected", by: "window:tcpa" } },
];

/** The policy document a scenario runs under. */
export const policyFor = (scenario) => POLICIES[scenario.policy];

/** The EvaluateInput a scenario runs with, plus the playground-only `deliveredToday`. */
export function inputFor(scenario) {
  return {
    user: { ...user, ...(scenario.user ?? {}) },
    candidate: { ...candidate, ...(scenario.candidate ?? {}) },
    now: scenario.now,
    ...(scenario.deliveredToday ? { deliveredToday: scenario.deliveredToday } : {}),
  };
}

/**
 * Runs one input through a fresh gate and returns the decision.
 *
 * `deliveredToday` is spent the only way it can honestly be spent: by committing real
 * decisions first. Nothing here pre-loads a counter behind the library's back. It is also the
 * one key in the Input box that the library does not read, which is why it is handled here.
 *
 * `lib` is the library namespace, so the browser can pass its bundle and the test can pass the
 * package itself. Both then exercise the same path.
 */
export async function evaluateWithPrespend(lib, policy, input) {
  const now = input.now ? new Date(input.now) : undefined;
  const gate = lib.createGate({ policy, store: new lib.MemoryStore() });
  for (let n = 0; n < (input.deliveredToday ?? 0); n += 1) {
    const earlier = { ...input.candidate, id: `earlier-${n}` };
    const decision = await gate.evaluate({ user: input.user, candidate: earlier, now });
    if (decision.allowed) await gate.commit(decision, { user: input.user, candidate: earlier });
  }
  return gate.evaluate({ user: input.user, candidate: input.candidate, now });
}

/** What a decision says, in the three words the scenarios use. */
export function outcomeOf(decision) {
  if (decision.allowed) return "allowed";
  return decision.deferredBy ? "deferred" : "rejected";
}
