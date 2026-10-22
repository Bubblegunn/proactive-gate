import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, explain, en, KNOWN_CHECKS, MemoryStore } from "../src/index.js";
import type { Candidate, Check, Decision, UserState } from "../src/index.js";

// L2 review item 1 and L5 follow-up: every check id has a sentence, and the sentences for the spec 1.6.0 checks
// read as reasons rather than as the generic "the X check stopped it" fallback.

const NON_REJECTING = ["adaptiveTiming", "boundedDeferral", "deadHours"];
const FALLBACK = /[Tt]he "\w+" check (stopped|let it through|adjusted it|did not weigh in)/;
const INTERNAL = /freshUntil|createdAt|hourStats|crisisUntil|newSinceLast|dataPoints|deviceTimezone|kind:|why:/;

test("every check id in KNOWN_CHECKS has a pass sentence and a rejection sentence, or is listed as non-rejecting", () => {
  const missing: string[] = [];
  for (const id of Object.keys(KNOWN_CHECKS)) {
    if (!en[`${id}.pass`]) missing.push(`${id}.pass`);
    const rejects = Boolean(en[`${id}.reject`]);
    const adjusts = NON_REJECTING.includes(id) && Boolean(en[`${id}.adjust`]);
    if (!rejects && !adjusts) missing.push(`${id}.reject`);
  }
  assert.deepEqual(missing, []);
  assert.ok(Object.keys(KNOWN_CHECKS).length > 0);
});

const now = new Date("2026-10-21T10:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, createdAt: "2026-01-01T00:00:00Z", timezone: "UTC", ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", surfaces: ["feed"], ...o });

async function sentenceFor(check: Check, input: { user: UserState; candidate: Candidate }): Promise<{ sentence: string; decision: Decision }> {
  const gate = createGate({ checks: [check], store: new MemoryStore() });
  const decision = await gate.evaluate({ ...input, now });
  const sentence = explain(decision).checks.at(-1)?.sentence ?? "";
  assert.doesNotMatch(sentence, FALLBACK, "the sentence is the generic fallback, not a reason");
  for (const text of [sentence, explain(decision).summary]) assert.doesNotMatch(text, INTERNAL, "the text names an internal field");
  return { sentence, decision };
}

test("freshness: an expired candidate is said to be out of date", async () => {
  const { sentence, decision } = await sentenceFor(checks.freshness(), { user: user(), candidate: candidate({ freshUntil: "2026-10-21T09:00:00Z" }) });
  assert.equal(decision.rejectedBy, "freshness");
  assert.match(sentence, /out of date/);
});

test("silence: thin evidence is said to be too little evidence, with the counts", async () => {
  const { sentence } = await sentenceFor(checks.silence(), { user: user(), candidate: candidate({ evidence: { dataPoints: 2, confidence: 0.9 } }) });
  assert.match(sentence, /too little evidence to send this: 2 data points/);
});

test("silence: a repeat of nothing new is said to be nothing new", async () => {
  const { sentence } = await sentenceFor(checks.silence(), { user: user(), candidate: candidate({ evidence: { dataPoints: 9, confidence: 0.9, newSinceLast: false } }) });
  assert.match(sentence, /[Nn]othing new/);
});

test("crisisQuiet: a message in the quiet period is refused with the instant it lifts", async () => {
  const until = "2026-10-22T00:00:00Z";
  const { sentence, decision } = await sentenceFor(checks.crisisQuiet(), { user: user({ crisisUntil: until }), candidate: candidate() });
  assert.equal(decision.rejectedBy, "crisisQuiet");
  assert.ok(sentence.includes(new Date(until).toISOString()), "the sentence names the instant the quiet period ends");
});

test("crisisQuiet: outside the period it passes with a sentence of its own", async () => {
  const { sentence } = await sentenceFor(checks.crisisQuiet(), { user: user(), candidate: candidate() });
  assert.match(sentence, /did not block it/);
});

test("deadHours: a dead hour names the counts and says push was left off", async () => {
  const hour = String(now.getUTCHours());
  const { sentence, decision } = await sentenceFor(checks.deadHours(), { user: user({ hourStats: { [hour]: { acted: 0, dismissed: 9 } } }), candidate: candidate({ surfaces: ["push", "feed"] }) });
  assert.deepEqual(decision.surfaces, ["feed"]);
  assert.match(sentence, /acted on only 0 of the 9 messages/);
  assert.match(sentence, /push was left off/);
});

test("deadHours: when push was the only surface, the summary says nothing is sent", async () => {
  const hour = String(now.getUTCHours());
  const gate = createGate({ checks: [checks.deadHours()], store: new MemoryStore() });
  const decision = await gate.evaluate({ user: user({ hourStats: { [hour]: { acted: 0, dismissed: 9 } } }), candidate: candidate({ surfaces: ["push"] }), now });
  assert.equal(decision.allowed, true);
  assert.deepEqual(decision.surfaces, []);
  assert.match(explain(decision).summary, /nowhere to deliver it/);
});

test("trustRamp: a requested message passes the ramp, and the sentence says the person asked", async () => {
  const { sentence } = await sentenceFor(checks.trustRamp(), { user: user({ createdAt: "2026-10-20T00:00:00Z" }), candidate: candidate({ requested: true }) });
  assert.match(sentence, /asked for this message/);
});

test("dismissalCooldown: an exempt type passes, and the sentence names the type", async () => {
  const { sentence } = await sentenceFor(checks.dismissalCooldown({ exemptTypes: ["reminder"] }), { user: user(), candidate: candidate() });
  assert.match(sentence, /"reminder" type is exempt from the dismissal cooldown/);
});

test("dismissalCooldown: a commitment passes with the reason that it was set up", async () => {
  const { sentence } = await sentenceFor(checks.dismissalCooldown(), { user: user(), candidate: candidate({ kind: "commitment" }) });
  assert.match(sentence, /set this up/);
});

test("requiresConsent: a transactional message passes without marketing consent, and says why", async () => {
  const { sentence } = await sentenceFor(checks.requiresConsent({ name: "marketing", exemptTransactional: true }), { user: user(), candidate: candidate({ transactional: true }) });
  assert.match(sentence, /caused by the user's own action, not a promotion/);
});

test("budget: a commitment spends nothing, and the sentence says so", async () => {
  const { sentence, decision } = await sentenceFor(checks.dailyBudget({ limit: 1 }), { user: user(), candidate: candidate({ kind: "commitment" }) });
  assert.equal(decision.allowed, true);
  assert.match(sentence, /set up, so the daily budget is not counted/);
});

test("the rest of the sentences still read as reasons for a plain pass", async () => {
  const { sentence } = await sentenceFor(checks.freshness(), { user: user(), candidate: candidate({ freshUntil: "2026-10-22T00:00:00Z" }) });
  assert.match(sentence, /within its freshness limits/);
});

test("freshness: with no expiry on the candidate, the sentence says freshness was not checked", async () => {
  const { sentence, decision } = await sentenceFor(checks.freshness(), { user: user(), candidate: candidate() });
  assert.equal(decision.trace.at(-1)?.outcome, "skip");
  assert.match(sentence, /not checked/);
});
