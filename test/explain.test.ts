import { test } from "node:test";
import assert from "node:assert/strict";
import { createGate, defaultChecks, checks, MemoryStore, explain, en } from "../src/index.js";
import type { Candidate, Decision, Sentences, Store, UserState } from "../src/index.js";

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  quietHours: { start: "22:00", end: "08:00" },
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push", "feed"], ...overrides });
const noon = new Date("2026-09-04T09:00:00Z"); // 12:00 in Istanbul (UTC+3)
const night = new Date("2026-09-04T20:30:00Z"); // 23:30 in Istanbul

const deepFreeze = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
};

test("explain is a pure function of the decision: same input, same sentences, nothing mutated", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  deepFreeze(d);
  const first = explain(d);
  const second = explain(d);
  assert.deepEqual(first, second);
  assert.equal(first.summary, explain({ ...d }).summary);
  // An identical decision evaluated again (different ms timings, different id) explains the same way.
  const again = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  assert.equal(explain(again).summary, first.summary);
});

test("the plain sentence and the machine reason are both on hand", async () => {
  const gate = createGate({ checks: [checks.quietHours()] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  const e = explain(d);
  assert.equal(d.reason, "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (critical)");
  assert.equal(e.summary, "Held until 08:00 because the user's quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor needed to override them.");
});

test("the reason a candidate was not stopped: every check that ran gets a sentence", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  const e = explain(d);
  assert.equal(e.summary, "Allowed at 2026-09-04T09:00:00.000Z because no check stopped it.");
  assert.equal(e.checks.length, d.trace.length);
  assert.deepEqual(
    e.checks.map((c) => c.id),
    d.trace.map((t) => t.id),
  );
  assert.ok(e.checks.every((c) => c.sentence.length > 0));
});

test("killSwitch: the hard-stop reads as one", async () => {
  const gate = createGate({ checks: [checks.killSwitch(() => true)] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, "Held because the kill switch is on, which stops every message.");
});

test("consent, enabled, mode, mute: the preference checks name what the user set", async () => {
  const gate = createGate({ checks: defaultChecks() });
  const cases: Array<[Partial<UserState>, string]> = [
    [{ consent: false }, "the user has not agreed to proactive messages"],
    [{ proactiveEnabled: false }, "proactive messages are switched off on this user's profile"],
    [{ mode: "focus" }, 'the user\'s operating mode is "focus", which does not allow proactive messages'],
    [{ mutedTypes: ["reminder"] }, 'the user has muted "reminder" messages'],
  ];
  for (const [overrides, clause] of cases) {
    const d = await gate.evaluate({ user: user(overrides), candidate: candidate(), now: noon });
    assert.equal(explain(d).summary, `Held because ${clause}.`);
  }
});

test("snooze: reject and defer both say until when", async () => {
  const gate = createGate({ checks: [checks.snooze()] });
  const d = await gate.evaluate({ user: user({ snoozedUntil: "2026-09-04T12:00:00Z" }), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, "Held because the user has snoozed the assistant until 2026-09-04T12:00:00.000Z.");

  const deferring = createGate({ checks: [checks.snooze({ defer: true })] });
  const deferred = await deferring.evaluate({ user: user({ snoozedUntil: "2026-09-04T12:00:00Z" }), candidate: candidate(), now: noon });
  assert.equal(deferred.deferredBy, "snooze");
  assert.equal(explain(deferred).summary, "Held because the user has snoozed the assistant until 2026-09-04T12:00:00.000Z.");
});

test("intensity names the setting and the floor", async () => {
  const gate = createGate({ checks: [checks.intensity()] });
  const d = await gate.evaluate({ user: user({ intensity: "low" }), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, 'Held because the message was normal priority, and the user\'s "low" intensity setting allows only high and above.');
});

test("quietHours: the window end becomes the hold, and a window owned by yesterday says so", async () => {
  const gate = createGate({ checks: [checks.quietHours({ priorityFloor: "high" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  assert.equal(explain(d).summary, "Held until 08:00 because the user's quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the high floor needed to override them.");

  // Friday's 18:00 to 06:00 window is what silences Saturday 00:30 local; the
  // machine reason names the owning day and the sentence keeps it.
  const scheduled = createGate({ checks: [checks.quietHours()] });
  const fridayWindow = user({ quietHours: { default: null, days: { fri: { start: "18:00", end: "06:00" } } } });
  const satEarly = await scheduled.evaluate({ user: fridayWindow, candidate: candidate(), now: new Date("2026-09-04T21:30:00Z") });
  assert.equal(satEarly.rejectedBy, "quietHours");
  const e = explain(satEarly);
  assert.match(e.summary, /a window belonging to fri 2026-09-04/);
});

test("quietHours skip: set but no timezone", async () => {
  const gate = createGate({ checks: [checks.quietHours()] });
  const d = await gate.evaluate({ user: user({ timezone: undefined as unknown as string }), candidate: candidate(), now: night });
  const e = explain(d);
  assert.equal(e.checks[0]!.sentence, "The user has quiet hours but no time zone, so the check could not run.");
});

test("trustRamp names the day of the new-user period", async () => {
  const gate = createGate({ checks: [checks.trustRamp()] });
  const fresh = user({ createdAt: "2026-09-02T00:00:00Z" });
  const d = await gate.evaluate({ user: fresh, candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, "Held because the user is on day 3 of a 7-day trust period for new users, which allows only high priority and above, and the message was normal.");
  const noCreated = user();
  delete noCreated.createdAt;
  const skip = await gate.evaluate({ user: noCreated, candidate: candidate(), now: noon });
  assert.equal(explain(skip).checks[0]!.sentence, "The user's sign-up date is not on record, so the new-user trust period could not be checked.");
});

test("dismissalCooldown: the awkward one, said plainly", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: [checks.dismissalCooldown()] });
  const u = user();
  for (const day of [1, 2, 3]) await gate.record(u, { type: "reminder" }, "dismissed", new Date(`2026-09-0${day}T10:00:00Z`));
  const d = await gate.evaluate({ user: u, candidate: candidate(), now: new Date("2026-09-05T10:00:00Z") });
  assert.equal(explain(d).summary, 'Held because the user has dismissed "reminder" messages 3 times in 30 days, so this type stays silent until 2026-09-10T10:00:00.000Z.');
});

test("adaptiveTiming adjust: moved delivery and narrowed surfaces", async () => {
  const gate = createGate({ checks: [checks.adaptiveTiming({ nextGoodMoment: () => new Date("2026-09-04T10:00:00Z"), surfacesFor: () => ["feed"] })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  const e = explain(d);
  assert.equal(e.checks[0]!.sentence, "Delivery was moved to 2026-09-04T10:00:00.000Z and narrowed to feed.");
  assert.match(e.summary, /delivery waits until 2026-09-04T10:00:00.000Z/);
});

test("budgets: the spent budget names its period; near the limit says the unit is spent at send time", async () => {
  const store = new MemoryStore();
  const gate = createGate({ store, checks: [checks.dailyBudget({ limit: 5 }), checks.weeklyBudget({ limit: 20 })] });
  await store.set("pg:budget:u1:2026-09-04", "4");
  const near = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  const e = explain(near);
  assert.equal(e.checks[0]!.sentence, "The daily budget had room, but only just: 4 of 5 already used; the unit is spent when the message actually goes out.");
  assert.match(e.summary, /dailyBudget was close to its limit \(4 of 5 used\)/);

  await store.set("pg:budget:u1:2026-09-04", "5");
  const out = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(out).summary, "Held because the user's daily budget of 5 was already spent (5 used).");

  await store.set("pg:budget:u1:2026-09-04", "0");
  await store.set("pg:weeklyBudget:u1:2026-W36", "20");
  const week = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(week).summary, "Held because the user's weekly budget of 20 was already spent (20 used).");
});

test("rateLimit: the id's own numbers, and a preset's custom id renders the same", async () => {
  const store = new MemoryStore();
  const window = Math.floor(noon.getTime() / 1000 / 60);
  await store.set(`pg:rate:channel:general:60:${window}`, "20");
  const gate = createGate({ store, checks: [checks.rateLimit({ limit: 20, perSeconds: 60, keyBy: "channel", id: "rate:20/min" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate({ channel: "general" }), now: noon });
  assert.equal(explain(d).summary, "Held because the rate limit of 20 messages per minute was already reached (20 used).");
});

test("rateLimit periods: one of a unit drops the number, and the presets' hour and day are that case", async () => {
  // kakaoBrandMessage rate-limits per hour and lineMessagingApi per 24 hours, so
  // the singular is what ships rather than the exception.
  const cases: Array<[number, number, string]> = [
    [60, 20, "per minute"],
    [3600, 1000, "per hour"],
    [24 * 3600, 3, "per day"],
    [7200, 5, "per 2 hours"],
    [90, 2, "per 90 seconds"],
  ];
  for (const [perSeconds, limit, said] of cases) {
    const store = new MemoryStore();
    await store.set(`pg:rate:user:u1:${perSeconds}:${Math.floor(noon.getTime() / 1000 / perSeconds)}`, String(limit));
    const gate = createGate({ store, checks: [checks.rateLimit({ limit, perSeconds })] });
    const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
    assert.equal(explain(d).summary, `Held because the rate limit of ${limit} messages ${said} was already reached (${limit} used).`);
  }
});

test("dedupe: a delivered event and a missing key both read clearly", async () => {
  const store = new MemoryStore();
  await store.set("pg:dedupe:u1:order:42", "1");
  const gate = createGate({ store, checks: [checks.dedupe()] });
  const seen = await gate.evaluate({ user: user(), candidate: candidate({ dedupeKey: "order:42" }), now: noon });
  assert.equal(explain(seen).summary, "Held because the same event already produced a message within the last day.");

  const noKey = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(noKey).checks[0]!.sentence, "The candidate carried no event key, so duplicate detection could not run.");
});

test("utilityFloor names the caller's estimate against the floor", async () => {
  const gate = createGate({ checks: [checks.utilityFloor({ costFalseAlarm: 1, costMissedHelp: 1 })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate({ pAccept: 0.3 }), now: noon });
  assert.equal(explain(d).summary, "Held because the estimated chance the user would accept this message was 0.3, below the utility floor of 0.5.");
  const skip = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(skip).checks[0]!.sentence, "The candidate carried no acceptance estimate, so the utility floor could not run.");
});

test("boundedDeferral adjust: the user looked busy", async () => {
  const gate = createGate({ checks: [checks.boundedDeferral()] });
  const d = await gate.evaluate({ user: user(), candidate: candidate({ busy: true }), now: noon });
  assert.equal(d.allowed, true);
  const e = explain(d);
  assert.match(e.checks[0]!.sentence, /^The user looked busy, so delivery was deferred 116\.?\d* seconds to /);
  assert.match(e.summary, /delivery waits until /);
});

test("allowedWindow: works under a preset's custom id too", async () => {
  const gate = createGate({ checks: [checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "user", id: "window:tcpa" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  assert.equal(d.rejectedBy, "window:tcpa");
  assert.equal(explain(d).summary, "Held because messages may only go out between 08:00 and 21:00 (Europe/Istanbul), and the local time was outside that window.");
});

test("allowedWindow: a preset's window id names the window on the way through", async () => {
  // us-tcpa, kakao-brand-message and cn-minor-mode all give the window an id of
  // their own. Before the prefix was known, every one of their passes read as a
  // quoted fallback: 'The "window:tcpa" check let it through.'
  const gate = createGate({ checks: [checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "user", id: "window:tcpa" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.equal(explain(d).checks[0]!.sentence, 'The "tcpa" allowed window did not block it.');

  const plain = createGate({ checks: [checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "user" })] });
  const dp = await plain.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(dp).checks[0]!.sentence, "The allowed window did not block it.");

  // The id also answers for a window that could not run at all.
  const noZone = await gate.evaluate({ user: user({ timezone: undefined as unknown as string }), candidate: candidate(), now: noon });
  assert.equal(explain(noZone).checks[0]!.sentence, "The user has no time zone, so the allowed window could not be checked.");
});

test("requiresConsent: the consent name comes from the id, with or without hours", async () => {
  const gate = createGate({ checks: [checks.requiresConsent({ name: "ad" })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, 'Held because the user has not given the required "ad" consent.');

  const nightGate = createGate({ checks: [checks.requiresConsent({ name: "night", when: { start: "21:00", end: "08:00", timezone: "user" } })] });
  const dn = await nightGate.evaluate({ user: user(), candidate: candidate(), now: night });
  assert.equal(explain(dn).summary, 'Held because the user has not given the required "night" consent, which applies between 21:00 and 08:00.');

  const ok = await gate.evaluate({ user: user({ consents: { ad: true } }), candidate: candidate(), now: noon });
  assert.equal(explain(ok).checks[0]!.sentence, 'The "ad" consent the check needs was in place.');
});

test("a windowed consent that was not needed yet does not claim the consent exists", async () => {
  // The check used to return a bare pass outside its hours, which is the same
  // trace entry as "the consent is on file", so the sentence asserted a consent
  // the user had never given. India's TCCCPR preset runs four of these at once.
  const gate = createGate({ checks: [checks.requiresConsent({ name: "night", when: { start: "21:00", end: "24:00", timezone: "user" } })] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(d.allowed, true);
  assert.equal(d.trace[0]!.reason, "outside the consent window 21:00 to 24:00");
  assert.equal(explain(d).checks[0]!.sentence, 'The "night" consent is only needed between 21:00 and 24:00, and it was outside those hours.');

  // Inside the hours, with the consent given, the old sentence is still the true one.
  const inside = await gate.evaluate({ user: user({ consents: { night: true } }), candidate: candidate(), now: night });
  assert.equal(explain(inside).checks[0]!.sentence, 'The "night" consent the check needs was in place.');
});

test("recentInteraction: no inbound on record and an old one both read plainly", async () => {
  const gate = createGate({ checks: [checks.recentInteraction({ withinHours: 48 })] });
  const never = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(never).summary, "Held because the user has never written to the assistant, and this rule allows messages only after they do.");

  const old = await gate.evaluate({ user: user({ lastInboundAt: "2026-09-01T08:00:00Z" }), candidate: candidate(), now: noon });
  assert.equal(explain(old).summary, "Held because the user's last message to the assistant was 73 h ago, outside the 48 h window.");
});

test("windowBudget spent inside the reply window", async () => {
  const store = new MemoryStore();
  const last = "2026-09-04T08:00:00Z";
  await store.set(`pg:windowBudget:u1:${Math.floor(new Date(last).getTime() / 1000)}`, "1");
  const gate = createGate({ store, checks: [checks.windowBudget({ limit: 1, withinHours: 48 })] });
  const d = await gate.evaluate({ user: user({ lastInboundAt: last }), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, "Held because the budget for the window opened by the user's last message was already spent (1 of 1 used).");
});

test("the gate's own trace entries: failing open, failing closed, and an ignored non-rejecting stop", async () => {
  const boom = { id: "mystery", run: () => Promise.reject(new Error("boom")) };
  const open = createGate({ checks: [boom, checks.consent()] });
  const d1 = await open.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d1).checks[0]!.sentence, 'The "mystery" check failed with "boom", and the gate is set to let messages through when a check fails.');

  const closed = createGate({ checks: [boom, checks.consent()], onStoreError: "closed" });
  const d2 = await closed.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d2).summary, 'Held because the "mystery" check failed with "boom", and the gate is set to stop messages when a check fails.');

  const polite = { id: "polite", nonRejecting: true, run: () => ({ kind: "reject" as const, reason: "felt like it" }) };
  const ignored = createGate({ checks: [polite, checks.consent()] });
  const d3 = await ignored.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d3).checks[0]!.sentence, 'The "polite" check tried to reject ("felt like it") but is marked non-rejecting, so the gate ignored it.');
});

test("a shadowed stop is rendered as what would have happened", async () => {
  const shadowed = {
    id: "quietHours",
    shadow: true,
    run: () => ({ kind: "reject" as const, reason: "quiet hours 22:00 to 08:00 Europe/Istanbul; priority normal is below the floor (critical)" }),
  };
  const gate = createGate({ checks: [shadowed, checks.consent()] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });
  const e = explain(d);
  assert.equal(e.checks[0]!.shadow, true);
  assert.equal(
    e.checks[0]!.sentence,
    "It would have stopped the message (the user's quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor needed to override them), but the check ran in shadow mode so evaluation continued.",
  );
  assert.match(e.summary, /quietHours would have stopped it but ran in shadow mode/);
});

test("a shadowed pass does not claim the check would have stopped the message", () => {
  const d: Decision = {
    id: "u1:c1:2026-09-04T09:00:00.000Z#1",
    allowed: true,
    userId: "u1",
    candidateId: "c1",
    surfaces: ["feed"],
    shadowed: [],
    nearLimit: [],
    trace: [{ id: "dailyBudget", outcome: "pass", reason: "4 of 5 used", shadow: true, ms: 0 }],
    evaluatedAt: noon,
  };
  assert.equal(
    explain(d).checks[0]!.sentence,
    "The daily budget had room, but only just: 4 of 5 already used; the unit is spent when the message actually goes out.",
  );
});

test("a check nothing knows about still renders, quoting its own reason", async () => {
  const custom = { id: "weekend", run: () => ({ kind: "reject" as const, reason: "weekend: only high priority" }) };
  const gate = createGate({ checks: [custom] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(d).summary, 'Held because the "weekend" check stopped it: weekend: only high priority.');

  const passing = createGate({ checks: [{ id: "weather", run: () => ({ kind: "pass" as const, reason: "sunny out" }) }, custom] });
  const dp = await passing.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(dp).checks[0]!.sentence, 'The "weather" check let it through (sunny out).');
});

test("language is a parameter: default English, unknown codes fail loudly, caller catalogs merge over English", async () => {
  const gate = createGate({ checks: [checks.quietHours()] });
  const d = await gate.evaluate({ user: user(), candidate: candidate(), now: night });

  assert.equal(explain(d).summary, explain(d, { language: "en" }).summary);
  assert.throws(() => explain(d, { language: "tr" }), /no sentence catalog for language "tr"/);

  const tr: Partial<Sentences> = {
    "summary.held": (f) => `${f.until ? `${f.until} kadar ` : ""}bekletildi, çünkü ${f.clause}`,
  };
  const e = explain(d, { language: "tr", catalogs: { tr } });
  assert.equal(e.summary, "08:00 kadar bekletildi, çünkü the user's quiet hours run 22:00 to 08:00 Europe/Istanbul and normal priority is below the critical floor needed to override them.");
  assert.ok(Object.keys(en).length > 0, "the English catalog is exported so a translation has a template to copy");
});

test("a hand-built decision that names no stopping check still renders honestly", () => {
  const odd: Decision = {
    id: "u1:c1:2026-09-04T09:00:00.000Z#1",
    allowed: false,
    userId: "u1",
    candidateId: "c1",
    surfaces: [],
    shadowed: [],
    nearLimit: [],
    trace: [],
    evaluatedAt: noon,
  };
  assert.equal(explain(odd).summary, "Held; the trace does not name the check that stopped it.");
});

test("an allowed decision with no checks ran says so", () => {
  const empty: Decision = {
    id: "u1:c1:2026-09-04T09:00:00.000Z#1",
    allowed: true,
    userId: "u1",
    candidateId: "c1",
    surfaces: ["feed"],
    shadowed: [],
    nearLimit: [],
    trace: [],
    evaluatedAt: noon,
  };
  assert.equal(explain(empty).summary, "Allowed; no checks ran.");
});

test("the sentences the rest of this file never reaches: every remaining template, rendered", async () => {
  // Each of these was silent until it was asked for. A template nothing renders
  // is a sentence nobody has read, and the first person to read it is a user.
  const monthly = new MemoryStore();
  await monthly.set("pg:monthlyBudget:u1:2026-09", "60");
  const spent = await createGate({ store: monthly, checks: [checks.monthlyBudget()] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(spent).summary, "Held because the user's monthly budget of 60 was already spent (60 used).");

  const weekly = new MemoryStore();
  await weekly.set("pg:weeklyBudget:u1:2026-W36", "20");
  const weekSpent = await createGate({ store: weekly, checks: [checks.weeklyBudget()] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(weekSpent).summary, "Held because the user's weekly budget of 20 was already spent (20 used).");

  // A budget nowhere near its limit passes without a reason, which is a different
  // sentence from the near-limit one and was never asserted before.
  const room = await createGate({ store: new MemoryStore(), checks: [checks.dailyBudget({ limit: 5 })] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(room).checks[0]!.sentence, "The daily budget did not stop it.");

  const rate = await createGate({ store: new MemoryStore(), checks: [checks.rateLimit({ limit: 20, perSeconds: 60 })] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(rate).checks[0]!.sentence, "The rate limit did not stop it.");

  // Consent hours the gate cannot place, because the user has no time zone.
  const consentHours = createGate({ checks: [checks.requiresConsent({ name: "night", when: { start: "21:00", end: "08:00", timezone: "user" } })] });
  const unplaced = await consentHours.evaluate({ user: user({ timezone: undefined as unknown as string, consents: { night: true } }), candidate: candidate(), now: noon });
  assert.equal(explain(unplaced).checks[0]!.sentence, "The user has no time zone, so the hours this consent applies could not be checked.");

  // Somebody else's budget: a reason shaped like one, under a label this package
  // does not ship, keeps the caller's own words for the thing that ran out.
  const quota = { id: "teamQuota", run: () => ({ kind: "reject" as const, reason: "team quota of 5 used (5)" }) };
  const quotaOut = await createGate({ checks: [quota] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(quotaOut).summary, "Held because the team quota was already used up (5 of 5 used).");

  const quotaNear = { id: "teamQuota", run: () => ({ kind: "pass" as const, reason: "4 of 5 used" }) };
  const nearDecision = await createGate({ checks: [quotaNear] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(nearDecision).checks[0]!.sentence, "The budget had room, but only just: 4 of 5 already used; the unit is spent when the message actually goes out.");

  // A check nothing knows about, skipping and adjusting rather than stopping.
  const odd = createGate({
    checks: [
      { id: "weather", run: () => ({ kind: "skip" as const, reason: "forecast service is down" }) },
      { id: "router", run: () => ({ kind: "adjust" as const, reason: "sent via SMS instead" }) },
    ],
  });
  const oddDecision = await odd.evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(oddDecision).checks[0]!.sentence, 'The "weather" check did not weigh in: forecast service is down.');
  assert.equal(explain(oddDecision).checks[1]!.sentence, 'The "router" check adjusted it: sent via SMS instead.');

  // A deferral whose clause does not say when: the hold instant comes from retryAt.
  const queue = { id: "queue", run: () => ({ kind: "defer" as const, reason: "the send queue is draining", retryAt: new Date("2026-09-04T10:30:00Z") }) };
  const deferred = await createGate({ checks: [queue] }).evaluate({ user: user(), candidate: candidate(), now: noon });
  assert.equal(explain(deferred).summary, 'Held until 2026-09-04T10:30:00.000Z because the "queue" check stopped it: the send queue is draining.');
});

test("every check the package ships rejects or adjusts into a readable sentence", async () => {
  // Sweep: run the default policy plus the optional checks across two days and
  // assert no sentence ever came back empty or as a raw machine reason alone.
  const store: Store = new MemoryStore();
  const gate = createGate({
    store,
    checks: [
      ...defaultChecks({ dedupe: true, weeklyLimit: 20 }),
      checks.monthlyBudget(),
      checks.utilityFloor({ costFalseAlarm: 1, costMissedHelp: 1 }),
      checks.boundedDeferral(),
      checks.allowedWindow({ start: "08:00", end: "21:00", timezone: "user" }),
      checks.recentInteraction({ withinHours: 48 }),
      checks.windowBudget({ limit: 1, withinHours: 48 }),
    ],
  });
  for (const now of [noon, night, new Date("2026-09-06T07:00:00Z")]) {
    const d = await gate.evaluate({ user: user({ lastInboundAt: "2026-09-04T08:00:00Z" }), candidate: candidate({ dedupeKey: "evt:1", pAccept: 0.7 }), now });
    const e = explain(d);
    assert.equal(e.checks.length, d.trace.length);
    for (const c of e.checks) {
      assert.ok(c.sentence.length > 10, `empty sentence for ${c.id}`);
      assert.ok(/^[A-Z]/.test(c.sentence), `not a sentence for ${c.id}: ${c.sentence}`);
      // A check this package ships must have a template. Quoting its machine
      // reason back is the honest answer for somebody else's check, and a
      // silent regression for one of ours.
      assert.doesNotMatch(c.sentence, /" check (stopped it|let it through|did not weigh in|adjusted it)/, `${c.id} fell back to its machine reason: ${c.sentence}`);
    }
  }
});
