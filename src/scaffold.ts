/**
 * `proactive-gate scaffold nudge`: the files an assistant needs to message a user on its own.
 *
 * The policy is the `assistantNudge` preset with a daily limit and a freshness age. The notify module maps the
 * app's shapes onto the gate in one function, toInput(), and exports the calls an app makes. Its tests run through
 * the built library, so a change to the mapping is checked as it is made. The library never reads these files.
 */

const POLICY = (dailyLimit: number, legalUs: boolean) =>
  `${JSON.stringify({ specVersion: "1.0.0", checks: [{ preset: "assistantNudge", dailyLimit }, ...(legalUs ? [{ preset: "usTcpa" }] : []), { id: "freshness", maxAgeSeconds: 86400 }] }, null, 2)}\n`;

const NOTIFY = `// Written by proactive-gate scaffold nudge. Edit toInput() to match your app's data, then run:
//   node --test notify.test.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { checks, createGate, explain, MemoryStore, SqliteStore } from "proactive-gate";
const DAY = 24 * 60 * 60 * 1000;
const policy = JSON.parse(readFileSync(new URL("./proactive-gate.policy.json", import.meta.url), "utf8"));
// STATE_DIR survives restarts and is shared by every worker. It is read at first use, not at import (a host may set it
// later); each directory gets its own store, created when missing. Without it the log and the store live for this process.
const stores = new Map();
const memoryLog = [];
const logFile = () => (process.env.STATE_DIR ? process.env.STATE_DIR + "/decisions.jsonl" : null);
const current = () => {
  const dir = process.env.STATE_DIR || null;
  if (!stores.has(dir)) stores.set(dir, dir ? (mkdirSync(dir, { recursive: true }), new SqliteStore(dir + "/gate.db")) : new MemoryStore());
  return stores.get(dir);
};
const store = { get: (...a) => current().get(...a), set: (...a) => current().set(...a), incr: (...a) => current().incr(...a), incrBy: (...a) => current().incrBy(...a), del: (...a) => current().del(...a) };
export const gate = createGate({ policy, store, inboundConsent: true });
// A call may carry its own daily limit (config.dailyNudgeCap); the gate for that number shares the store.
const gates = new Map();
const withCap = (cap) => ({ ...policy, checks: policy.checks.map((c) => (c.preset ? { ...c, dailyLimit: cap } : c)) });
const gateFor = (cap) => (Number.isInteger(cap) && cap >= 0 ? (gates.get(cap) ?? gates.set(cap, createGate({ policy: withCap(cap), store, inboundConsent: true })).get(cap)) : gate);
// Every code decide() and deliver() can return: each check the policy can stop with, and the few this module adds.
export const REASON_CODES = [...new Set([...gate.checks.map((c) => c.id), "surface", "commit", "transport", "optOut", "permission", "category"])];
// Used when the app has no quiet-hours window (the preset has none, SPEC 9.14). LOST is the commit race's reason.
const DEFAULT_QUIET = { start: "22:00", end: "08:00" };
const LOST = "another delivery took the last unit at the same moment, so nothing was sent";
const optOutKey = (userId, value) => "app:optout:" + userId + ":" + value;
const call = (args) => ({ ...args, now: args.now ?? new Date() });

// EDIT HERE. The app's shapes become the gate's input, and this is the only function that reads them.
// origin "requested" is a request, "reminder" is something the user set up, anything else is an inferred nudge.
// A consent flag or consents.marketing counts as consent. insight is { key, dataPoints, confidence }.
// Returns { input, pushOff }: pushOff is { code, reason } when push is taken off the table, else undefined.
export function toInput({ user, candidate = {}, context = {}, message = {}, notification = {}, flags = {}, now = new Date() }) {
  const type = candidate.type ?? "notification";
  const explicitId = message.id ?? notification.id ?? candidate.id;
  const id = explicitId ?? randomUUID();
  const granted = user.consent === true || user.consents?.marketing === true;
  const zone = checks.effectiveZone(user);
  const day = zone ? checks.localClock(now, zone).day : now.toISOString().slice(0, 10);
  const { insight } = candidate;
  const createdAt = message.createdAt ?? candidate.createdAt;
  // The account's own creation date; a bare account age is turned into one.
  const accountCreated = user.createdAt ?? user.profileCreatedAt ?? (user.accountAgeDays === undefined ? undefined : new Date(now.getTime() - user.accountAgeDays * DAY).toISOString());
  let pushOff;
  if (user.notificationsPermitted === false) pushOff = { code: "permission", reason: "push was not used: the operating system's notification permission is off" };
  else if (user.categories && user.categories[type] === undefined) pushOff = { code: "category", reason: "push was not used: the user was never asked about this category" };
  const surfaces = (candidate.surfaces ?? ["feed"]).filter((s) => !(pushOff && s === "push"));
  return {
    pushOff,
    input: {
      user: {
        id: user.id, timezone: user.timezone, deviceTimezone: user.deviceTimezone, consentUnknown: user.consentUnknown,
        consent: granted, consents: { ...user.consents, marketing: granted },
        createdAt: accountCreated, mode: user.focusMode === true ? "focus" : user.mode,
        quietHours: user.quietHours === undefined ? DEFAULT_QUIET : user.quietHours,
        crisisUntil: context.crisis === true ? new Date(now.getTime() + 365 * DAY).toISOString() : user.crisisUntil,
        snoozedUntil: user.snoozedUntil, hourStats: context.hourStats ?? user.hourStats,
        mutedTypes: user.categories?.[type] === false ? [...(user.mutedTypes ?? []), type] : user.mutedTypes,
      },
      candidate: {
        ...candidate, id, type, surfaces, channel: message.channel ?? candidate.channel,
        requested: candidate.origin === "requested" || candidate.requested === true,
        ...(candidate.origin === "reminder" ? { kind: "commitment" } : {}),
        ...(insight ? { evidence: { dataPoints: insight.dataPoints, confidence: insight.confidence, newSinceLast: true } } : {}),
        // A redelivered message id is sent once. An insight is sent once per local day, whatever its attempts.
        dedupeKey: insight ? "insight:" + insight.key + ":" + day : explicitId,
        ...(createdAt ? { createdAt } : {}),
      },
      now,
      flags: { proactiveEnabled: !(flags.proactiveEnabled === false || flags.killSwitch === true) },
    },
  };
}
// deliver()'s consent lookup. A store that throws leaves consent unknown, so the policy's fail mode applies.
async function withStoredConsent(user, consentStore) {
  if (!consentStore) return user;
  try {
    const stored = await consentStore.get(user.id);
    return { ...user, consent: user.consent === true || stored === true, consents: { ...user.consents, ...(stored && typeof stored === "object" ? stored : {}) } };
  } catch {
    return { ...user, consentUnknown: true };
  }
}
// Evaluates one message. Opt-outs from optOut() apply here, for decide() and deliver() alike.
async function admit(args) {
  const { input, pushOff } = toInput(args);
  const { user, candidate } = input;
  if (candidate.channel && (await store.get(optOutKey(user.id, candidate.channel)))) return { sent: false, code: "optOut", reason: "the user turned " + candidate.channel + " messages off" };
  if (await store.get(optOutKey(user.id, candidate.type))) user.mutedTypes = [...(user.mutedTypes ?? []), candidate.type];
  const g = gateFor(args.config?.dailyNudgeCap);
  const decision = await g.evaluate(input);
  const availableAt = decision.nextAllowedAt?.toISOString() ?? null;
  if (!decision.allowed || !decision.surfaces.length) {
    const code = decision.rejectedBy ?? decision.deferredBy ?? pushOff?.code ?? "surface";
    return { sent: false, code, reason: pushOff && code === pushOff.code ? pushOff.reason : explain(decision, { user, now: input.now }).summary, availableAt };
  }
  if (!(await g.commit(decision, input))) return { sent: false, code: "commit", reason: LOST, availableAt };
  return { sent: true, decision, input, surfaces: decision.surfaces, gate: g };
}
// One line per decision, the log whyNotReceived() reads. Lines stay well under 4 KB.
function record(args, delivered, code, text, availableAt = null) {
  const id = args.message?.id ?? args.notification?.id ?? args.candidate?.id ?? args.candidate?.type;
  const line = JSON.stringify({ notificationId: id, userId: args.user.id, at: args.now.toISOString(), delivered, ruleCode: code, availableAt, text: String(text).slice(0, 1000) });
  const file = logFile();
  if (file) appendFileSync(file, line + "\\n");
  else memoryLog.push(line);
}
// Returns { send, reason, reasonCode, surfaces }. reasonCode is one of REASON_CODES, and reason is null when sent.
export async function decide(args) {
  args = call(args);
  const v = await admit(args);
  record(args, v.sent, v.code ?? null, v.sent ? "delivered" : v.reason, v.availableAt);
  return v.sent ? { send: true, reason: null, reasonCode: null, surfaces: v.surfaces } : { send: false, reason: v.reason, reasonCode: v.code, surfaces: [] };
}
// decide(), then the app's transport: push(user, candidate) and inApp(user, candidate). A unit is given back when the
// push was refused or nothing was delivered. Returns { push, inApp, reason, resumeAt }; resumeAt is the ISO time it can go out.
export async function deliver(args) {
  args = call(args);
  const user = await withStoredConsent(args.user, args.consentStore);
  const v = await admit({ ...args, user });
  const snoozeAt = args.user.snoozedUntil ? new Date(args.user.snoozedUntil).toISOString() : null;
  if (!v.sent) {
    const resumeAt = v.availableAt ?? snoozeAt;
    record(args, false, v.code, v.reason, resumeAt);
    return { push: false, inApp: false, reason: v.reason, resumeAt };
  }
  let push = false;
  let inApp = false;
  try {
    if (v.surfaces.includes("push")) push = Boolean(await args.transport.push(args.user, v.input.candidate));
    if (v.surfaces.includes("feed")) inApp = Boolean(await args.transport.inApp(args.user, v.input.candidate));
  } catch (error) {
    if (!push && !inApp) await v.gate.release(v.decision, v.input);
    throw error;
  }
  // A unit is spent only on a confirmed send: a push the phone refused gives it back, even if the in-app item was stored.
  if (!push && (!inApp || v.surfaces.includes("push"))) await v.gate.release(v.decision, v.input);
  const delivered = push || inApp;
  const reason = delivered ? (push ? null : "the phone did not accept the push, so only the in-app item was stored") : "nothing was delivered, so the budget unit was given back";
  record(args, delivered, delivered ? null : "transport", reason ?? "delivered", delivered ? null : snoozeAt);
  return { push, inApp, reason, resumeAt: delivered ? null : snoozeAt };
}
// What happened to a user between from (inclusive) and to (exclusive), in the order it was considered.
export function whyNotReceived({ userId, from, to }) {
  const lo = new Date(from).getTime();
  const hi = new Date(to).getTime();
  const file = logFile();
  const lines = file ? (existsSync(file) ? readFileSync(file, "utf8").split("\\n").filter(Boolean) : []) : memoryLog;
  return lines
    .map((line) => JSON.parse(line))
    .filter((e) => e.userId === userId && new Date(e.at).getTime() >= lo && new Date(e.at).getTime() < hi)
    .map(({ notificationId, at, delivered, ruleCode, availableAt, text }) => ({ notificationId, at, delivered, ruleCode, availableAt, text }));
}
// Last week's events under another policy (quietHours {start, end} or null, dailyCap a number or null). Its own
// store and no log, so nothing real changes.
export async function dryRun({ events, policy: rules = {} }) {
  const trial = createGate({ policy: rules.dailyCap === undefined ? policy : withCap(rules.dailyCap), store: new MemoryStore(), inboundConsent: true });
  let delivered = 0;
  let blocked = 0;
  for (const e of [...events].sort((a, b) => new Date(a.at) - new Date(b.at))) {
    const user = rules.quietHours === undefined ? e.user : { ...e.user, quietHours: rules.quietHours };
    const { input } = toInput({ user, notification: e.notification, now: new Date(e.at) });
    const decision = await trial.evaluate(input);
    if (decision.allowed && decision.surfaces.length && (await trial.commit(decision, input))) delivered += 1;
    else blocked += 1;
  }
  return { delivered, blocked };
}
// Pass the zone so the hour counts line up with the hours decide() reads.
export const recordDismissal = (userId, type, now = new Date(), timezone) => gate.record({ id: userId, timezone }, { type }, "dismissed", now);
export const recordAct = (userId, type, now = new Date(), timezone) => gate.record({ id: userId, timezone }, { type }, "acted", now);
// A type or a channel ("sms", "email"). Durable with SqliteStore only; a MemoryStore forgets it on restart.
export async function optOut(userId, typeOrChannel) {
  await store.set(optOutKey(userId, typeOrChannel), "1");
}
// STOP and START per channel. Answer the carrier with a non-200 status if this throws, so it retries.
export function handleInbound({ userId, channel, text, now = new Date() }) {
  return gate.inbound.handle({ userId, channel, text, now });
}
`;

const NOTIFY_TEST = `// Run with: node --test notify.test.mjs. Each test uses its own user, so the shared store does not link them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decide, deliver, dryRun, gate, handleInbound, optOut, recordDismissal, REASON_CODES, whyNotReceived } from "./notify.mjs";

const policy = JSON.parse(readFileSync(new URL("./proactive-gate.policy.json", import.meta.url), "utf8"));
const DAILY = policy.checks[0].dailyLimit;
const MAX_AGE = policy.checks.find((c) => c.id === "freshness").maxAgeSeconds;
const NOW = new Date("2026-10-21T10:00:00Z"); // 13:00 in Istanbul
const DAY = 24 * 60 * 60 * 1000;
const OLD = "2026-01-01T00:00:00Z";
const HOUR = String(Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", hourCycle: "h23" }).format(NOW)));
let seq = 0;
const who = (extra = {}) => ({ id: "u" + ++seq + "-" + Date.now(), consent: true, timezone: "Europe/Istanbul", createdAt: OLD, ...extra });
const nudge = (extra = {}) => ({ type: "nudge", ...extra });
const ask = (user, candidate = nudge(), extra = {}) => decide({ user, candidate, now: NOW, ...extra });
const coded = (r) => {
  assert.ok(REASON_CODES.includes(r.reasonCode), "reasonCode " + r.reasonCode + " is in REASON_CODES");
  return r.reasonCode;
};

test("consent counts from the consent flag or the marketing consent, and a user with neither is refused", async () => {
  assert.equal((await ask(who({ consent: false, consents: { marketing: true } }))).send, true);
  assert.equal(coded(await ask(who({ consent: undefined, consents: { analytics: true } }))), "consent");
});

test("a user whose consent lookup fails gets feed only: push is not attempted", async () => {
  const calls = [];
  const transport = { push: async (...a) => { calls.push(["push", a]); return true; }, inApp: async (...a) => { calls.push(["inApp", a]); return true; } };
  const result = await deliver({ user: who(), candidate: nudge({ origin: "requested", surfaces: ["push", "feed"] }), now: NOW, transport, consentStore: { get: async () => { throw new Error("store down"); } } });
  assert.equal(result.push, false);
  assert.equal(result.inApp, true);
  assert.equal(result.resumeAt, null);
  assert.deepEqual(calls.map(([name]) => name), ["inApp"]);
});

test("a consent store that returns the marketing consent lets an inferred message through", async () => {
  const transport = { push: async () => true, inApp: async () => true };
  const r = await deliver({ user: who({ consent: false }), candidate: nudge({ surfaces: ["feed"] }), now: NOW, transport, consentStore: { get: async () => ({ marketing: true }) } });
  assert.equal(r.inApp, true);
});

test("deliver hands the user and the candidate to push and inApp, and reports both", async () => {
  const user = who();
  const candidate = nudge({ origin: "requested", surfaces: ["push", "feed"] });
  const seen = [];
  const transport = { push: async (u, c) => { seen.push(u.id, c.type); return true; }, inApp: async (u, c) => { seen.push(u.id, c.type); return true; } };
  const result = await deliver({ user, candidate, now: NOW, transport });
  assert.deepEqual(result, { push: true, inApp: true, reason: null, resumeAt: null });
  assert.deepEqual(seen, [user.id, "nudge", user.id, "nudge"]);
});

test("a push the phone rejects gives the unit back when nothing else delivered", async () => {
  const user = who();
  const failing = { push: async () => false, inApp: async () => false };
  for (let i = 0; i < DAILY; i++) assert.equal((await deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push"] }), now: NOW, transport: failing })).push, false);
  const ok = { push: async () => true, inApp: async () => true };
  for (let i = 0; i < DAILY; i++) assert.equal((await deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push"] }), now: NOW, transport: ok })).push, true);
  assert.match((await deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push"] }), now: NOW, transport: ok })).reason, /budget/);
});

test("a push the phone refused gives its unit back, even when the in-app item was stored", async () => {
  const user = who();
  const half = { push: async () => false, inApp: async () => true };
  for (let i = 0; i < DAILY + 1; i++) assert.equal((await deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push", "feed"] }), now: NOW, transport: half })).inApp, true);
  assert.equal((await ask(user, nudge({ origin: "requested" }))).send, true, "nothing was spent, so the next message still goes");
});

test("a transport that throws gives its unit back and passes the error on", async () => {
  const user = who();
  await assert.rejects(deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push"] }), now: NOW, transport: { push: async () => { throw new Error("down"); }, inApp: async () => true } }), /down/);
  for (let i = 0; i < DAILY; i++) assert.equal((await deliver({ user, candidate: nudge({ origin: "requested", surfaces: ["push"] }), now: NOW, transport: { push: async () => true, inApp: async () => true } })).push, true);
});

test("the daily limit counts the local day, and the next local day starts again", async () => {
  const user = who();
  for (let i = 0; i < DAILY; i++) assert.equal((await ask(user)).send, true);
  assert.equal(coded(await ask(user)), "dailyBudget");
  assert.equal((await decide({ user, candidate: nudge(), now: new Date(NOW.getTime() + DAY) })).send, true);
});

test("the device zone wins over the stored zone, and no zone at all is refused", async () => {
  const at = new Date("2026-10-21T06:00:00Z"); // 02:00 in New York (quiet) and 09:00 in Istanbul (not quiet)
  assert.equal(coded(await decide({ user: who({ timezone: "America/New_York" }), candidate: nudge({ origin: "requested" }), now: at })), "quietHours");
  assert.equal((await decide({ user: who({ timezone: "America/New_York", deviceTimezone: "Europe/Istanbul" }), candidate: nudge({ origin: "requested" }), now: at })).send, true);
  assert.equal(coded(await ask(who({ timezone: undefined }))), "quietHours");
});

test("three dismissals silence that type and leave the other types alone", async () => {
  const user = who();
  for (const minutes of [3, 2, 1]) await recordDismissal(user.id, "nudge", new Date(NOW.getTime() - minutes * 60000), user.timezone);
  assert.equal(coded(await ask(user)), "dismissalCooldown");
  assert.equal((await ask(user, nudge({ type: "digest" }))).send, true);
});

test("the kill switch is read from proactiveEnabled, and from killSwitch", async () => {
  assert.equal(coded(await ask(who(), nudge(), { flags: { proactiveEnabled: false } })), "killSwitch");
  assert.equal(coded(await ask(who(), nudge(), { flags: { killSwitch: true } })), "killSwitch");
});

test("STOP silences one channel until START, and leaves the other channels alone", async () => {
  const user = who();
  assert.equal((await handleInbound({ userId: user.id, channel: "sms", text: "STOP", now: NOW })).action, "stop");
  assert.equal(coded(await ask(user, nudge({ channel: "sms" }))), "inboundConsent");
  assert.equal((await ask(user, nudge({ channel: "email" }))).send, true);
  await handleInbound({ userId: user.id, channel: "sms", text: "START", now: NOW });
  assert.equal((await ask(user, nudge({ channel: "sms" }))).send, true);
});

test("a requested message passes the new-account trust ramp, and an inferred one is held", async () => {
  const fresh = who({ createdAt: new Date(NOW.getTime() - DAY).toISOString() });
  assert.equal((await ask(fresh, nudge({ origin: "requested" }))).send, true);
  assert.equal(coded(await ask(fresh)), "trustRamp");
});

test("a reminder the person set up passes after the daily limit is spent", async () => {
  const user = who();
  for (let i = 0; i < DAILY; i++) await ask(user);
  assert.equal((await ask(user)).send, false);
  assert.equal((await ask(user, nudge({ origin: "reminder", type: "reminder" }))).send, true);
});

test("a crisis, a focus mode and a too-new account each stop the message with their own code", async () => {
  assert.equal(coded(await ask(who(), nudge(), { context: { crisis: true } })), "crisisQuiet");
  assert.equal((await ask(who(), nudge({ kind: "support" }))).send, true, "a support message is not stopped by the crisis check");
  assert.equal(coded(await ask(who({ focusMode: true }))), "mode");
  assert.equal(coded(await ask(who({ createdAt: undefined, accountAgeDays: 1 }))), "trustRamp");
});

test("thin insight evidence is refused by silence, and the reason says it is not enough", async () => {
  const r = await ask(who(), nudge({ origin: "requested", insight: { key: "k1", dataPoints: 2, confidence: 0.9 } }));
  assert.equal(coded(r), "silence");
  assert.match(r.reason, /evidence/);
});

test("the same message id sent twice goes once, and the same insight goes once a local day", async () => {
  const user = who();
  assert.equal((await ask(user, nudge({ origin: "requested" }), { message: { id: "m-1" } })).send, true);
  assert.equal(coded(await ask(user, nudge({ origin: "requested" }), { message: { id: "m-1" } })), "dedupe");
  const insight = { key: "sleep", dataPoints: 9, confidence: 0.9 };
  assert.equal((await ask(user, nudge({ origin: "requested", insight }))).send, true);
  assert.equal(coded(await ask(user, nudge({ origin: "requested", insight }))), "dedupe");
  assert.equal((await decide({ user, candidate: nudge({ origin: "requested", insight }), now: new Date(NOW.getTime() + DAY) })).send, true, "the next local day sends it again");
});

test("optOut takes a type or a channel: a muted type gets the mute code, a channel gets optOut, on decide and deliver", async () => {
  const user = who();
  await optOut(user.id, "digest");
  assert.equal(coded(await ask(user, nudge({ type: "digest" }))), "mute");
  await optOut(user.id, "email");
  assert.equal(coded(await ask(user, nudge({ channel: "email" }))), "optOut");
  const transport = { push: async () => true, inApp: async () => true };
  const refused = await deliver({ user, candidate: nudge({ channel: "email", origin: "requested" }), now: NOW, transport });
  assert.equal(refused.push, false);
  assert.equal((await ask(user, nudge({ channel: "sms" }))).send, true);
});

test("a permission that is off takes push away, and a push-only message says why", async () => {
  const user = who({ notificationsPermitted: false });
  const pushOnly = await ask(user, nudge({ surfaces: ["push"] }));
  assert.equal(pushOnly.reasonCode, "permission");
  assert.match(pushOnly.reason, /permission/);
  const both = await ask(user, nudge({ surfaces: ["push", "feed"] }));
  assert.equal(both.send, true);
  assert.deepEqual(both.surfaces, ["feed"]);
});

test("a category the user was never asked about gets no push", async () => {
  const user = who({ categories: { tips: true } });
  assert.equal(coded(await ask(user, nudge({ type: "briefing", surfaces: ["push"] }))), "category");
  assert.equal((await ask(user, nudge({ type: "tips", surfaces: ["push"] }))).send, true);
});

test("a message that is older than the freshness age is refused", async () => {
  const createdAt = new Date(NOW.getTime() - (MAX_AGE + 60) * 1000).toISOString();
  assert.equal(coded(await ask(who(), nudge({ origin: "requested" }), { message: { id: "m-old", createdAt } })), "freshness");
});

test("an hour the user rarely acts in takes push off, and a push-only message is not sent", async () => {
  const user = who({ hourStats: { [HOUR]: { acted: 0, dismissed: 9 } } });
  const before = (await gate.inspect(user, NOW)).budgetUsed;
  const r = await ask(user, nudge({ surfaces: ["push"] }));
  assert.equal(r.send, false);
  assert.equal(r.reasonCode, "surface");
  assert.equal((await gate.inspect(user, NOW)).budgetUsed, before, "nothing was committed");
});

test("the decision log answers whyNotReceived for one user, from inclusive to exclusive", async () => {
  const user = who();
  await ask(user, nudge({ origin: "requested" }), { message: { id: "log-1" } });
  const later = new Date(NOW.getTime() + 60000);
  await decide({ user, candidate: nudge(), now: later, message: { id: "log-2" } });
  const entries = whyNotReceived({ userId: user.id, from: NOW.toISOString(), to: later.toISOString() });
  assert.deepEqual(entries.map((e) => e.notificationId), ["log-1"]);
  assert.equal(entries[0].delivered, true);
  assert.equal(entries[0].ruleCode, null);
  assert.equal(whyNotReceived({ userId: user.id, from: NOW.toISOString(), to: new Date(later.getTime() + 1).toISOString() }).length, 2);
});

test("dryRun counts what a policy would deliver and block, and touches no real state", async () => {
  const user = who();
  const at = (iso, id) => ({ user, notification: { id }, at: iso });
  const day = ["2026-10-21T10:00:00Z", "2026-10-21T10:05:00Z", "2026-10-21T10:10:00Z"];
  assert.deepEqual(await dryRun({ events: day.map((iso, i) => at(iso, "d" + i)), policy: { quietHours: null, dailyCap: 1 } }), { delivered: 1, blocked: 2 });
  assert.deepEqual(await dryRun({ events: [at("2026-10-21T20:30:00Z", "night"), at("2026-10-21T10:00:00Z", "noon")], policy: { quietHours: { start: "22:00", end: "08:00" }, dailyCap: null } }), { delivered: 1, blocked: 1 });
  assert.equal((await gate.inspect(user, NOW)).budgetUsed, 0, "the dry run left the real budget alone");
  assert.equal((await ask(user, nudge({ origin: "requested" }))).send, true);
});

test("the codes are a closed list that includes the module's own", () => {
  for (const code of ["surface", "commit", "transport", "optOut", "permission", "category", "consent", "dailyBudget"]) assert.ok(REASON_CODES.includes(code), code);
});
`;

/** The files `scaffold nudge` writes, by name. */
export function nudgeFiles(dailyLimit: number, legalUs = false): Record<string, string> {
  return { "proactive-gate.policy.json": POLICY(dailyLimit, legalUs), "notify.mjs": NOTIFY, "notify.test.mjs": NOTIFY_TEST };
}
