// Written by proactive-gate scaffold nudge. Edit toInput() to match your app's data, then run:
//   node --test notify.test.mjs
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { checks, createGate, explain, MemoryStore, SqliteStore } from "proactive-gate";
const DAY = 24 * 60 * 60 * 1000;
// Only the rules the product states: consent, quiet hours 22:00-08:00 (unknown zone is held), redelivery by id, 3 per local day.
const policy = {
  specVersion: "1.0.0",
  checks: [
    { id: "consent" },
    { id: "quietHours" },
    { id: "dedupe" },
    { id: "dailyBudget", limit: 3 },
  ],
};
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
const withCap = (cap) => ({ ...policy, checks: policy.checks.flatMap((c) => (c.id !== "dailyBudget" ? [c] : cap === null ? [] : [{ ...c, limit: cap }])) });
const gateFor = (cap) => (Number.isInteger(cap) && cap >= 0 && cap !== 3 ? (gates.get(cap) ?? gates.set(cap, createGate({ policy: withCap(cap), store, inboundConsent: true })).get(cap)) : gate);
// Every code decide() and deliver() can return: each check the policy can stop with, and the few this module adds.
export const REASON_CODES = [...new Set([...gate.checks.map((c) => c.id), "timezone", "surface", "commit", "transport", "optOut", "permission", "category"])];
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
  // An unknown or invalid zone is held, never guessed ("UTC" is a real zone and is accepted).
  if (!checks.effectiveZone(user)) return { sent: false, code: "timezone", reason: "Held because the user's time zone is unknown or invalid, so quiet hours and the daily count cannot be read.", availableAt: null };
  if (candidate.channel && (await store.get(optOutKey(user.id, candidate.channel)))) return { sent: false, code: "optOut", reason: "the user turned " + candidate.channel + " messages off" };
  if (await store.get(optOutKey(user.id, candidate.type))) user.mutedTypes = [...(user.mutedTypes ?? []), candidate.type];
  const g = gateFor(args.config?.dailyNudgeCap);
  const decision = await g.evaluate(input);
  const availableAt = decision.nextAllowedAt?.toISOString() ?? null;
  if (!decision.allowed || !decision.surfaces.length) {
    const code = decision.rejectedBy ?? decision.deferredBy ?? pushOff?.code ?? "surface";
    const plain = code === "quietHours" ? "Held because it was inside quiet hours (22:00 to 08:00 the user's local time)." + (availableAt ? " It could go out at " + availableAt + "." : "") : null;
    return { sent: false, code, reason: plain ?? (pushOff && code === pushOff.code ? pushOff.reason : explain(decision, { user, now: input.now }).summary), availableAt };
  }
  if (!(await g.commit(decision, input))) return { sent: false, code: "commit", reason: LOST, availableAt };
  return { sent: true, decision, input, surfaces: decision.surfaces, gate: g };
}
// One line per decision, the log whyNotReceived() reads. Lines stay well under 4 KB.
function record(args, delivered, code, text, availableAt = null) {
  const id = args.message?.id ?? args.notification?.id ?? args.candidate?.id ?? args.candidate?.type;
  const line = JSON.stringify({ notificationId: id, userId: args.user.id, at: args.now.toISOString(), delivered, ruleCode: code, availableAt, text: String(text).slice(0, 1000) });
  const file = logFile();
  if (file) appendFileSync(file, line + "\n");
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
  const lines = file ? (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []) : memoryLog;
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
