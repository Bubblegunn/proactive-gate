/**
 * Fidelity of the simulator, from a review of 0.6.0.
 *
 * Every test here asserts what a truthful simulation must do, so each one that fails is a
 * reproduction of a defect in the shipped measurement tool rather than a wish. They are written
 * against the public shape of `simulate()` only, with hand-built streams, so they keep working if
 * the internals are rewritten underneath them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptiveTiming, consent, dailyBudget, dedupe, mode, quietHours, snooze } from "../src/checks.js";
import { simulate } from "../src/simulate.js";
import type { Check, EvaluateInput, UserState } from "../src/index.js";

const user = (o: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  createdAt: "2026-01-01T00:00:00Z",
  ...o,
});

const at = (iso: string) => new Date(iso);

const event = (id: string, when: string, u: UserState = user(), extra: Record<string, unknown> = {}): EvaluateInput => ({
  user: u,
  candidate: { id, type: "reminder", priority: "normal", surfaces: ["push"], ...extra },
  now: at(when),
});

const outcomeOf = (records: Array<{ candidateId: string; outcome: string; attempt: number }>, id: string) => {
  const attempts = records.filter((r) => r.candidateId === id);
  return attempts.length ? attempts[attempts.length - 1]?.outcome : "missing";
};

/* 1. The store's clock -------------------------------------------------------------------- */

test("finding 1: a TTL window reopens as simulated time passes", async () => {
  // dedupe's only expiry mechanism is the store TTL, so it is the honest probe for whether the
  // store's clock follows the simulation. Same dedupeKey, three simulated days apart, one hour
  // window: the second one must be allowed, because the window closed long before it arrived.
  const events = [
    event("c1", "2026-09-07T09:00:00Z", user(), { dedupeKey: "morning-digest" }),
    event("c2", "2026-09-10T09:00:00Z", user(), { dedupeKey: "morning-digest" }),
  ];
  const result = await simulate({
    events,
    policies: [{ label: "dedupe", checks: [consent(), dedupe({ windowSeconds: 3600 })] }],
  });
  const run = result.runs[0];
  assert.equal(outcomeOf(run?.records ?? [], "c1"), "sent");
  assert.equal(
    outcomeOf(run?.records ?? [], "c2"),
    "sent",
    "three simulated days later the one-hour dedupe window has closed, so this must be allowed",
  );
});

test("finding 1 guard: a week of simulated time does not erase the earlier budget rows", async () => {
  // The counterpart risk of giving the store a virtual clock: the daily budget key carries a
  // two-day TTL, so a report that reads the store after a simulated week would find the first
  // days expired and print zeros. Whatever the clock does, the spent units must still be there.
  const day = (n: number) => `2026-09-${String(7 + n).padStart(2, "0")}T09:00:00Z`;
  const events = Array.from({ length: 7 }, (_, n) => event(`c${n}`, day(n)));
  const result = await simulate({ events, policies: [{ label: "capped", checks: [consent(), dailyBudget({ limit: 5 })] }] });
  const run = result.runs[0];
  assert.equal(run?.counts.sent, 7, "every day's one candidate is under the cap");
  assert.equal(run?.budget.length, 7, `one row per local day that spent a unit, got ${JSON.stringify(run?.budget)}`);
  assert.ok(run?.budget.every((row) => row.used === 1), "each of those days spent exactly one");
});

/* 2. The user state a retry sees ---------------------------------------------------------- */

test("finding 2: a deferral is re-evaluated against the state in force at the retry", async () => {
  // 08:00 consented, snoozed until 09:00, so the candidate defers. 08:30 the consent is gone.
  // 09:00 the retry must not send: a deferral is not a standing permission.
  const consented = user({ snoozedUntil: "2026-09-07T09:00:00Z" });
  const revoked = user({ consent: false, snoozedUntil: "2026-09-07T09:00:00Z" });
  const events = [
    event("deferred", "2026-09-07T08:00:00Z", consented),
    event("revocation", "2026-09-07T08:30:00Z", revoked),
  ];
  const result = await simulate({
    events,
    policies: [{ label: "defers", checks: [consent(), snooze({ defer: true })] }],
    expirySeconds: 4 * 3600,
  });
  const run = result.runs[0];
  assert.equal(outcomeOf(run?.records ?? [], "revocation"), "held", "the 08:30 candidate itself is held, obviously");
  assert.notEqual(
    outcomeOf(run?.records ?? [], "deferred"),
    "sent",
    "the 09:00 retry used the 08:00 snapshot and sent to a user who had withdrawn consent at 08:30",
  );
});

/* 3. Evaluation time against delivery time ------------------------------------------------ */

const deliverAtCheck = (when: string): Check => adaptiveTiming({ nextGoodMoment: () => at(when) });

test("finding 3: a quiet-hours figure follows the delivery, not the evaluation", async () => {
  // Evaluated at 23:30 local, which is inside quiet hours, and moved by adaptiveTiming to 09:00
  // the next morning, which is not. Nobody was disturbed at 23:30, so the count must be zero.
  const u = user({ quietHours: { start: "22:00", end: "08:00" } });
  const events = [event("moved", "2026-09-07T20:30:00Z", u)]; // 23:30 Europe/Istanbul
  const result = await simulate({
    events,
    policies: [{ label: "moves", checks: [consent(), deliverAtCheck("2026-09-08T06:00:00Z"), dailyBudget({ limit: 5 })] }],
  });
  const run = result.runs[0];
  assert.equal(run?.counts.sent, 1);
  assert.equal(
    run?.counts.sentInQuietHours,
    0,
    "the send was moved to 09:00 local, so counting it inside quiet hours reports a disturbance that never happened",
  );
});

test("finding 3: the delivery moment is re-evaluated before the send", async () => {
  // Moved to 09:00, and the consent is withdrawn at 08:00, before the delivery instant.
  const u = user();
  const events = [
    event("moved", "2026-09-07T05:00:00Z", u), // 08:00 local, delivery pushed to 12:00 local
    event("revocation", "2026-09-07T06:00:00Z", user({ consent: false })),
  ];
  const result = await simulate({
    events,
    policies: [{ label: "moves", checks: [consent(), deliverAtCheck("2026-09-07T09:00:00Z"), dailyBudget({ limit: 5 })] }],
  });
  const run = result.runs[0];
  assert.notEqual(
    outcomeOf(run?.records ?? [], "moved"),
    "sent",
    "the delivery moment arrived after the consent was withdrawn, so it must not count as delivered",
  );
});

test("review of the fix: a postponed delivery is not refused by the unit it paid for itself", async () => {
  // Found by review of the first fix. The gate commits at evaluation, so at the delivery moment the
  // same daily budget reads its own spend and refuses the send. The library never re-evaluates at
  // `deliverAt` at all, so that hold does not exist outside the simulator: it is invented, and it
  // lands in the headline twice, as a stop that should be a send and as a missing delivery.
  const u = user();
  const events = [event("paid", "2026-09-07T07:00:00Z", u)]; // 10:00 local
  const result = await simulate({
    events,
    policies: [{ label: "one a day, moved", checks: [consent(), dailyBudget({ limit: 1 }), deliverAtCheck("2026-09-07T09:00:00Z")] }],
  });
  const run = result.runs[0];
  const final = run?.records.filter((r) => r.candidateId === "paid").pop();
  assert.equal(final?.outcome, "sent", `the candidate that spent the day's only unit must be the one allowed to use it: ${final?.reason ?? ""}`);
  assert.equal(final?.deliveredAt, "2026-09-07T09:00:00.000Z", "and it lands at the moment the check moved it to");
  assert.deepEqual(run?.budget, [{ userId: "u1", localDay: "2026-09-07", used: 1 }], "one unit, spent once");
});

test("review of the fix: somebody else's spend cannot retroactively block a paid delivery", async () => {
  // Contributed by the review of the first fix, and kept because it pins the predicate rather than
  // the symptom: dropping the consuming checks at the delivery moment is right because the unit was
  // already taken, not merely because it makes the happy path pass. Two units, one candidate
  // postponed and one immediate that spends the remainder in between.
  const u = user();
  const moment = at("2026-09-07T09:00:00Z");
  const movesOne: Check = adaptiveTiming({ nextGoodMoment: ({ candidate }) => (candidate.id === "postponed" ? moment : null) });
  const events = [
    event("postponed", "2026-09-07T07:00:00Z", u), // 10:00 local, delivery moved to 12:00 local
    event("immediate", "2026-09-07T08:00:00Z", u), // 11:00 local, spends the remaining unit
  ];
  const result = await simulate({
    events,
    policies: [{ label: "two a day", checks: [consent(), dailyBudget({ limit: 2 }), movesOne] }],
  });
  const run = result.runs[0];
  const finalOf = (id: string) => run?.records.filter((r) => r.candidateId === id).pop();
  assert.equal(finalOf("immediate")?.outcome, "sent");
  assert.equal(finalOf("postponed")?.outcome, "sent", "the delivery that had already paid is not blocked by the other candidate's unit");
  assert.equal(finalOf("postponed")?.deliveredAt, "2026-09-07T09:00:00.000Z");
  assert.deepEqual(run?.budget, [{ userId: "u1", localDay: "2026-09-07", used: 2 }], "two units, spent once each");
});

test("review of the fix: a postponed delivery is still refused when the person's window moved over it", async () => {
  // The other half of the same rule: dropping the checks that already took payment must not drop
  // the checks that read state, because reading state again at the delivery moment is the point.
  const u = user({ quietHours: { start: "22:00", end: "08:00" } });
  const events = [event("moved", "2026-09-07T17:00:00Z", u)]; // 20:00 local, delivery at 23:00 local
  const result = await simulate({
    events,
    policies: [{ label: "into the night", checks: [consent(), dailyBudget({ limit: 5 }), deliverAtCheck("2026-09-07T20:00:00Z"), quietHours({ priorityFloor: "critical" })] }],
  });
  const final = result.runs[0]?.records.filter((r) => r.candidateId === "moved").pop();
  assert.equal(final?.outcome, "stoppedAtDelivery", "23:00 local is inside that user's quiet hours by the time it would land");
  assert.equal(final?.rejectedBy, "quietHours");
});

test("review of the fix: an event with no instant is refused, not evaluated at the epoch", async () => {
  const events = [{ user: user(), candidate: { id: "c1", type: "reminder", priority: "normal" as const } }] as EvaluateInput[];
  await assert.rejects(
    () => simulate({ events, policies: [{ label: "p", checks: [consent()] }] }),
    /no usable instant/,
    "without its own instant an event sits at the epoch, a lifetime before every TTL on the simulated clock",
  );
});

test("finding 3, the part I dispute: the budget unit stays on the day the gate spent it", async () => {
  // The library takes the unit at commit, under the evaluation day's key (SPEC 5.1). A simulator
  // that moved the budget row to the delivery day would disagree with the store it just wrote to.
  // So: the volume the person feels follows the delivery, the counter follows the commit.
  const u = user({ timezone: "Europe/Istanbul" });
  const events = [event("moved", "2026-09-07T20:30:00Z", u)]; // 23:30 local on the 7th
  const result = await simulate({
    events,
    policies: [{ label: "moves", checks: [consent(), deliverAtCheck("2026-09-08T06:00:00Z"), dailyBudget({ limit: 5 })] }],
  });
  const run = result.runs[0];
  assert.deepEqual(
    run?.budget,
    [{ userId: "u1", localDay: "2026-09-07", used: 1 }],
    "the unit was spent on the 7th, which is what the store's own key says",
  );
});

/* 4. What counts as a disagreement -------------------------------------------------------- */

test("finding 4: two policies that hold the same candidate for different reasons disagree", async () => {
  const u = user({ mode: "focus", quietHours: { start: "22:00", end: "08:00" } });
  const events = [event("c1", "2026-09-07T20:30:00Z", u)]; // 23:30 local: quiet, and in focus mode
  const result = await simulate({
    events,
    policies: [
      { label: "by mode", checks: [consent(), mode({ allow: ["normal"] })] },
      { label: "by quiet hours", checks: [consent(), quietHours({ priorityFloor: "critical" })] },
    ],
  });
  assert.equal(result.runs[0]?.records[0]?.rejectedBy, "mode");
  assert.equal(result.runs[1]?.records[0]?.rejectedBy, "quietHours");
  assert.equal(
    result.disagreements.length,
    1,
    "the same verdict for different reasons is a difference a policy comparison has to show",
  );
});

test("finding 4: two policies that deliver the same candidate at different times disagree", async () => {
  const events = [event("c1", "2026-09-07T09:00:00Z")];
  const result = await simulate({
    events,
    policies: [
      { label: "now", checks: [consent()] },
      { label: "later", checks: [consent(), deliverAtCheck("2026-09-07T17:00:00Z")] },
    ],
  });
  assert.equal(result.runs[0]?.counts.sent, 1);
  assert.equal(result.runs[1]?.counts.sent, 1);
  assert.equal(
    result.disagreements.length,
    1,
    "same outcome, eight hours apart: a comparison that calls this agreement is hiding the whole point",
  );
});

/* 5. Monotonicity: the counterexample from the review -------------------------------------- */

// finding 5, the monotonicity counterexample, lives in test/monotonicity.test.ts, beside the
// claim it disproves, so nobody can read that claim without meeting the case that breaks it.

/* Boundary cases ------------------------------------------------------------------------- */

/** A check that always defers to the instant it was asked about: retryAt is now. */
const deferToNow = (): Check => ({
  id: "deferNow",
  run: ({ now }) => ({ kind: "defer", reason: "again, right now", retryAt: now }),
});

/** A check that always defers three hours further out, forever. */
const deferForever = (): Check => ({
  id: "deferForever",
  run: ({ now }) => ({ kind: "defer", reason: "three hours out", retryAt: new Date(now.getTime() + 3 * 3600 * 1000) }),
});

test("boundary: a deferral to the current instant terminates instead of looping", async () => {
  const events = [event("c1", "2026-09-07T09:00:00Z")];
  const done = simulate({ events, policies: [{ label: "loops", checks: [consent(), deferToNow()] }] }).then(() => "returned");
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("did not terminate"), 1000));
  assert.equal(await Promise.race([done, timeout]), "returned", "a retryAt of now re-queues the same instant forever");
});

test("boundary: a repeatedly deferred candidate expires from its first sighting", async () => {
  // Expiry is four hours and each deferral is three hours out, so measuring from the latest
  // attempt keeps it alive for ever. Measured from the first sighting it stops after two hops.
  const events = [event("c1", "2026-09-07T09:00:00Z")];
  const done = simulate({
    events,
    policies: [{ label: "creeps", checks: [consent(), deferForever()] }],
    expirySeconds: 4 * 3600,
  }).then((r) => r);
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000));
  const result = await Promise.race([done, timeout]);
  assert.ok(result, "the run did not terminate: each deferral moved the expiry window with it");
  const run = result.runs[0];
  assert.equal(outcomeOf(run?.records ?? [], "c1"), "expired");
  const attempts = run?.records.filter((r) => r.candidateId === "c1") ?? [];
  assert.ok(attempts.length <= 3, `expiry is four hours in three-hour hops, so at most three attempts, got ${attempts.length}`);
  const last = attempts[attempts.length - 1];
  assert.ok(
    Date.parse(last?.at ?? "") <= Date.parse("2026-09-07T09:00:00Z") + 4 * 3600 * 1000,
    "the last attempt ran after the candidate should already have expired",
  );
});

test("boundary: changing a time zone does not re-judge what was already delivered", async () => {
  // 03:00 UTC is 06:00 in Istanbul, inside that user's quiet hours, and 12:00 in Tokyo, which is
  // not. The user moves to Tokyo later in the week. The first send must be judged in the zone
  // that was in force when it happened.
  const istanbul = user({ timezone: "Europe/Istanbul", quietHours: { start: "22:00", end: "08:00" } });
  const tokyo = user({ timezone: "Asia/Tokyo", quietHours: { start: "22:00", end: "08:00" } });
  const events = [
    event("early", "2026-09-07T03:00:00Z", istanbul),
    event("later", "2026-09-09T06:00:00Z", tokyo),
  ];
  const result = await simulate({ events, policies: [{ label: "no window check", checks: [consent()] }] });
  assert.equal(
    result.runs[0]?.counts.sentInQuietHours,
    1,
    "06:00 Istanbul was inside that user's quiet hours at the time; a later move to Tokyo cannot un-disturb them",
  );
});

test("boundary: a duplicated candidate id is refused rather than silently collapsed", async () => {
  const events = [event("c1", "2026-09-07T09:00:00Z"), event("c1", "2026-09-07T10:00:00Z")];
  await assert.rejects(
    () => simulate({ events, policies: [{ label: "p", checks: [consent()] }] }),
    /c1/,
    "two candidates sharing an id collapse into one row, so one of them disappears from every count",
  );
});
