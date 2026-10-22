import { test } from "node:test";
import assert from "node:assert/strict";
import { checks, createGate, MemoryStore } from "../src/index.js";
import type { Candidate, EvaluateInput, UserState } from "../src/index.js";

// SPEC 1.6.0 S8, S9 and S10. freshness refuses stale content. silence refuses a candidate whose caller-supplied
// evidence is thin or repeats nothing. crisisQuiet lets only support candidates through during a crisis period.

const now = new Date("2026-09-04T12:00:00Z");
const user = (o: Partial<UserState> = {}): UserState => ({ id: "u1", consent: true, ...o });
const candidate = (o: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "insight", ...o });
const input = (u: UserState, c: Candidate): EvaluateInput => ({ user: u, candidate: c, now });
const decide = async (list: ReturnType<typeof checks.freshness>[], c: Candidate) =>
  createGate({ checks: list, store: new MemoryStore() }).evaluate(input(user(), c));
const secondsBefore = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

// S8 freshness

test("S8: a candidate whose freshUntil is after now passes", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T12:00:01Z" }))).allowed, true);
});

test("S8: a candidate whose freshUntil is exactly now is expired, not fresh", async () => {
  const decision = await decide([checks.freshness()], candidate({ freshUntil: now.toISOString() }));
  assert.equal(decision.rejectedBy, "freshness");
  assert.match(decision.reason ?? "", /expired/);
});

test("S8: a candidate whose freshUntil is in the past is expired", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T11:00:00Z" }))).rejectedBy, "freshness");
});

test("S8: an unparseable freshUntil is refused as expired rather than let through", async () => {
  const decision = await decide([checks.freshness()], candidate({ freshUntil: "not a date" }));
  assert.equal(decision.rejectedBy, "freshness");
  assert.match(decision.reason ?? "", /expired/);
});

test("S8: with maxAgeSeconds, content exactly that old is still fresh and one second older is expired", async () => {
  const list = [checks.freshness({ maxAgeSeconds: 3600 })];
  assert.equal((await decide(list, candidate({ createdAt: secondsBefore(3600) }))).allowed, true);
  const older = await decide(list, candidate({ createdAt: secondsBefore(3601) }));
  assert.equal(older.rejectedBy, "freshness");
  assert.match(older.reason ?? "", /expired/);
});

test("S8: freshness with neither field present is skipped and says so", async () => {
  const decision = await decide([checks.freshness({ maxAgeSeconds: 60 })], candidate());
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
  assert.match(decision.trace[0]?.reason ?? "", /freshness cannot be evaluated/);
});

test("S8: createdAt without maxAgeSeconds is not checked and the check says so", async () => {
  const decision = await decide([checks.freshness()], candidate({ createdAt: secondsBefore(10_000_000) }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
});

test("S8: freshness applies to a commitment too", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ kind: "commitment", freshUntil: now.toISOString() }))).rejectedBy, "freshness");
});

// S9 silence

const silenceCase = async (evidence: Candidate["evidence"], options = {}) =>
  decide([checks.silence(options)], candidate({ ...(evidence === undefined ? {} : { evidence }) }));

test("S9: evidence absent is skipped and says so", async () => {
  const decision = await silenceCase(undefined);
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
});

test("S9: exactly the minimum data points and confidence pass", async () => {
  const at = await silenceCase({ dataPoints: 5, confidence: 0.5, newSinceLast: true });
  assert.equal(at.allowed, true);
});

test("S9: one data point below the minimum is refused as not enough", async () => {
  const decision = await silenceCase({ dataPoints: 4, confidence: 0.9, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /not enough/);
});

test("S9: confidence below the minimum is refused as not enough", async () => {
  const decision = await silenceCase({ dataPoints: 10, confidence: 0.49, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /not enough/);
});

test("S9: evidence with no data points is refused as not enough", async () => {
  assert.match((await silenceCase({ confidence: 0.9 })).reason ?? "", /not enough/);
});

test("S9: nothing new since the last message is refused", async () => {
  const decision = await silenceCase({ dataPoints: 10, confidence: 0.9, newSinceLast: false });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /nothing new/);
});

test("S9: requireNew false lets a candidate with nothing new through", async () => {
  assert.equal((await silenceCase({ dataPoints: 10, confidence: 0.9, newSinceLast: false }, { requireNew: false })).allowed, true);
});

test("S9: newSinceLast absent does not count as nothing new", async () => {
  assert.equal((await silenceCase({ dataPoints: 10, confidence: 0.9 })).allowed, true);
});

test("S9: the thresholds can be set by the caller", async () => {
  assert.equal((await silenceCase({ dataPoints: 2, confidence: 0.2, newSinceLast: true }, { minDataPoints: 2, minConfidence: 0.2 })).allowed, true);
});

// S10 crisisQuiet

const crisis = (u: Partial<UserState>, c: Partial<Candidate>) => createGate({ checks: [checks.crisisQuiet()], store: new MemoryStore() }).evaluate({ user: user(u), candidate: candidate(c), now });

test("S10: during a crisis period a normal candidate is refused, with a reason that says so", async () => {
  const decision = await crisis({ crisisUntil: "2026-09-05T12:00:00Z" }, {});
  assert.equal(decision.rejectedBy, "crisisQuiet");
  assert.match(decision.reason ?? "", /crisis/);
});

test("S10: during a crisis period a support candidate passes", async () => {
  assert.equal((await crisis({ crisisUntil: "2026-09-05T12:00:00Z" }, { kind: "support" })).allowed, true);
});

test("S10: a commitment is refused during a crisis period, because only support passes", async () => {
  assert.equal((await crisis({ crisisUntil: "2026-09-05T12:00:00Z" }, { kind: "commitment" })).rejectedBy, "crisisQuiet");
});

test("S10: crisisUntil exactly now is over, and so is one in the past", async () => {
  assert.equal((await crisis({ crisisUntil: now.toISOString() }, {})).allowed, true);
  assert.equal((await crisis({ crisisUntil: "2026-09-04T11:59:59Z" }, {})).allowed, true);
});

test("S10: no crisisUntil, or null, stops nothing", async () => {
  assert.equal((await crisis({}, {})).allowed, true);
  assert.equal((await crisis({ crisisUntil: null }, {})).allowed, true);
});

test("S10: the refusal names the instant the quiet period ends", async () => {
  const decision = await crisis({ crisisUntil: "2026-09-05T12:00:00Z" }, {});
  assert.equal(decision.nextAllowedAt?.toISOString(), "2026-09-05T12:00:00.000Z");
});

test("S10: crisisQuiet spends nothing", () => {
  assert.equal(checks.crisisQuiet().consume, undefined);
});

// R1: a JSON null instant is absent, as in Python and Go.

test("R1: a freshUntil of null is absent, so freshness skips rather than rejecting it", async () => {
  const decision = await decide([checks.freshness({ maxAgeSeconds: 60 })], candidate({ freshUntil: null }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
});

test("R1: a createdAt of null is absent, so freshness skips with maxAgeSeconds set", async () => {
  const decision = await decide([checks.freshness({ maxAgeSeconds: 60 })], candidate({ createdAt: null }));
  assert.equal(decision.allowed, true);
  assert.equal(decision.trace[0]?.outcome, "skip");
});

test("R1: a null freshUntil beside a fresh createdAt is judged by createdAt alone", async () => {
  const list = [checks.freshness({ maxAgeSeconds: 3600 })];
  assert.equal((await decide(list, candidate({ freshUntil: null, createdAt: secondsBefore(60) }))).allowed, true);
  assert.equal((await decide(list, candidate({ freshUntil: null, createdAt: secondsBefore(7200) }))).rejectedBy, "freshness");
});

// R2: a count that is not a finite number is zero for silence.

test("R2: a non-numeric dataPoints counts as zero and refuses", async () => {
  const decision = await silenceCase({ dataPoints: "x" as unknown as number, confidence: 0.9, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /not enough data: 0 data points/);
});

test("R2: a numeric string dataPoints is not a number and counts as zero", async () => {
  const decision = await silenceCase({ dataPoints: "9" as unknown as number, confidence: 0.9, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
});

test("R2: a non-numeric confidence counts as zero and refuses", async () => {
  const decision = await silenceCase({ dataPoints: 10, confidence: "y" as unknown as number, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /not enough confidence: 0/);
});

test("R2: a non-finite dataPoints counts as zero and refuses", async () => {
  const decision = await silenceCase({ dataPoints: Number.POSITIVE_INFINITY, confidence: 0.9, newSinceLast: true });
  assert.equal(decision.rejectedBy, "silence");
  assert.match(decision.reason ?? "", /not enough data: 0 data points/);
});

// R4: an instant with no offset is UTC, whatever the host time zone is.

test("R4: an offset-less instant is read as UTC, not in the host zone", async () => {
  // In Europe/Istanbul this instant read as local time would be 09:00:01Z, which is already expired.
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T12:00:01" }))).allowed, true);
});

test("R4: an offset-less instant that is past in UTC is expired", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T11:59:59" }))).rejectedBy, "freshness");
});

test("R4: a date alone is midnight UTC", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04" }))).rejectedBy, "freshness");
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-05" }))).allowed, true);
});

test("R4: an instant with an offset keeps its offset", async () => {
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T12:00:01+03:00" }))).rejectedBy, "freshness");
  assert.equal((await decide([checks.freshness()], candidate({ freshUntil: "2026-09-04T15:00:01+03:00" }))).allowed, true);
});
