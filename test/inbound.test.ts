import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGate, createInboundConsent, defaultChecks, explain, MemoryStore, parseKeyword, SqliteStore, checks, START_KEYWORDS, STOP_KEYWORDS } from "../src/index.js";
import type { Candidate, UserState } from "../src/index.js";

const user = (overrides: Partial<UserState> = {}): UserState => ({
  id: "u1",
  consent: true,
  proactiveEnabled: true,
  mode: "normal",
  intensity: "normal",
  timezone: "Europe/Istanbul",
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});
const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ id: "c1", type: "reminder", priority: "normal", surfaces: ["push"], ...overrides });
const noon = new Date("2026-09-04T09:00:00Z");

const sqliteAvailable = (() => {
  try {
    const loader = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
    return typeof loader?.("node:sqlite") === "object";
  } catch {
    return false;
  }
})();

test("parseKeyword matches only a whole message, after trimming and dropping trailing punctuation", () => {
  const stop = ["STOP", "stop", "  Stop.  ", "UNSUBSCRIBE!", "end", "Quit", "STOPALL", "cancel"];
  const start = ["START", "unstop", "Yes."];
  const none = ["please stop by tomorrow", "thanks", "HELP", "stopping", "end of month", "stop it", "yes please"];
  for (const text of stop) assert.equal(parseKeyword(text), "stop", text);
  for (const text of start) assert.equal(parseKeyword(text), "start", text);
  for (const text of none) assert.equal(parseKeyword(text), "none", text);
});

test("the exported keyword lists are the ones parseKeyword uses", () => {
  for (const word of STOP_KEYWORDS) assert.equal(parseKeyword(word), "stop", word);
  for (const word of START_KEYWORDS) assert.equal(parseKeyword(word), "start", word);
});

test("a stop on sms blocks sms and leaves email open for the same user", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [checks.consent(), inbound.check()], store });

  assert.deepEqual(await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" }), { action: "stop", channel: "sms" });

  const sms = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(sms.allowed, false);
  assert.equal(sms.rejectedBy, "inboundConsent");

  const email = await gate.evaluate({ user: user(), candidate: candidate({ channel: "email" }), now: noon });
  assert.equal(email.allowed, true);
});

test("a start re-enables the channel, and a second stop blocks it again", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [checks.consent(), inbound.check()], store });
  const sms = candidate({ channel: "sms" });

  await inbound.handle({ userId: "u1", channel: "sms", text: "stop." });
  assert.equal((await gate.evaluate({ user: user(), candidate: sms, now: noon })).allowed, false);

  assert.deepEqual(await inbound.handle({ userId: "u1", channel: "sms", text: "START" }), { action: "start", channel: "sms" });
  assert.equal((await gate.evaluate({ user: user(), candidate: sms, now: noon })).allowed, true);

  await inbound.handle({ userId: "u1", channel: "sms", text: "QUIT" });
  assert.equal((await gate.evaluate({ user: user(), candidate: sms, now: noon })).allowed, false);
});

test("a start on a channel that was never stopped changes nothing", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [inbound.check()], store });
  assert.deepEqual(await inbound.handle({ userId: "u1", channel: "sms", text: "START" }), { action: "start", channel: "sms" });
  assert.equal(await inbound.isStopped("u1", "sms"), false);
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon })).allowed, true);
});

test("a profile that says consent is true is still blocked after STOP", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [checks.consent(), inbound.check()], store });
  await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  const decision = await gate.evaluate({ user: user({ consent: true }), candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "inboundConsent");
});

test("a candidate with no channel uses its first surface, and with neither uses default", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [inbound.check()], store });

  await inbound.handle({ userId: "u1", channel: "push", text: "STOP" });
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate({ surfaces: ["push"] }), now: noon })).allowed, false);

  await inbound.handle({ userId: "u1", channel: "default", text: "STOP" });
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate({ surfaces: [] }), now: noon })).allowed, false);
});

test("the stop survives a restart: a second gate on the same SQLite file still blocks", { skip: !sqliteAvailable }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "proactive-gate-inbound-"));
  const path = join(directory, "store.sqlite");
  try {
    const first = new SqliteStore(path);
    const inbound = createInboundConsent({ store: first });
    await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
    first.close();

    const second = new SqliteStore(path);
    const gate = createGate({ checks: [checks.consent(), createInboundConsent({ store: second }).check()], store: second });
    const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
    assert.equal(decision.allowed, false);
    assert.equal(decision.rejectedBy, "inboundConsent");
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explain gives a non-empty sentence for the rejection that names the stop", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [checks.consent(), inbound.check()], store });
  await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
  const { checks: sentences } = explain(decision);
  const entry = sentences.find((s) => s.id === "inboundConsent");
  assert.ok(entry);
  assert.ok(entry.sentence.length > 0);
  assert.match(entry.sentence, /stop/i);
  assert.match(entry.sentence, /sms/);
});

test("defaultChecks adds the inbound check right after consent only when asked", () => {
  const ids = (list: { id: string }[]) => list.map((c) => c.id);
  assert.equal(ids(defaultChecks()).includes("inboundConsent"), false);
  const withInbound = ids(defaultChecks({ inboundConsent: true }));
  assert.equal(withInbound[withInbound.indexOf("consent") + 1], "inboundConsent");
});

test("a long message is refused before any other work, and quickly", () => {
  const started = performance.now();
  assert.equal(parseKeyword("stop" + " ".repeat(100_000) + "x"), "none");
  assert.ok(performance.now() - started < 100, "parseKeyword took too long on a long message");
});

test("punctuation, full-width forms, quotes and invisible characters around a keyword still count as that keyword", () => {
  const stop = ["STOP！", "STOP。", "STOP…", "STOP 🙏", "'STOP'", "ＳＴＯＰ", "stop​"];
  for (const text of stop) assert.equal(parseKeyword(text), "stop", JSON.stringify(text));
  for (const text of ["S T O P", "stop it"]) assert.equal(parseKeyword(text), "none", text);
});

test("non-string input is none and does not throw", async () => {
  for (const value of [null, undefined, 42, { text: "STOP" }]) assert.equal(parseKeyword(value), "none", String(value));
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  assert.deepEqual(await inbound.handle({ userId: "u1", channel: "sms", text: null as unknown as string }), { action: "none", channel: "sms" });
  assert.equal(await inbound.isStopped("u1", "sms"), false);
});

test("an empty channel counts as missing: handle files it under default, and the check falls back to the first surface", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  const gate = createGate({ checks: [inbound.check()], store });
  assert.deepEqual(await inbound.handle({ userId: "u1", channel: "", text: "STOP" }), { action: "stop", channel: "default" });
  await inbound.handle({ userId: "u1", channel: "push", text: "STOP" });
  const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "", surfaces: ["push"] }), now: noon });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "inboundConsent");
});

test("isStopped reads an empty channel under default, the key handle writes", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store });
  await inbound.handle({ userId: "u1", channel: "", text: "STOP" });
  assert.equal(await inbound.isStopped("u1", "default"), true);
  assert.equal(await inbound.isStopped("u1", ""), true);
});

test("custom keywords replace the defaults for that list only", async () => {
  const store = new MemoryStore();
  const inbound = createInboundConsent({ store, keywords: { stop: ["HALT"] } });
  assert.equal((await inbound.handle({ userId: "u1", channel: "sms", text: "HALT" })).action, "stop");
  assert.equal((await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" })).action, "none");
  assert.equal((await inbound.handle({ userId: "u1", channel: "sms", text: "START" })).action, "start");

  const startOnly = createInboundConsent({ store, keywords: { start: ["GO"] } });
  assert.equal((await startOnly.handle({ userId: "u1", channel: "sms", text: "YES" })).action, "none");
  assert.equal((await startOnly.handle({ userId: "u1", channel: "sms", text: "GO" })).action, "start");
});

test("a stop is stored with no TTL, and it is still there after a long time passes", async () => {
  const calls: Array<{ key: string; value: string; ttl: number | undefined }> = [];
  const memory = new MemoryStore(() => now);
  let now = Date.parse("2026-10-21T00:00:00Z");
  const spy = {
    get: (key: string) => memory.get(key),
    set: (key: string, value: string, ttl?: number) => {
      calls.push({ key, value, ttl });
      return memory.set(key, value, ttl);
    },
    incr: (key: string, ttl?: number) => memory.incr(key, ttl),
    del: (key: string) => memory.del(key),
  };
  const inbound = createInboundConsent({ store: spy });
  await inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.ttl, undefined);
  now += 100 * 365 * 24 * 60 * 60 * 1000;
  assert.equal(await inbound.isStopped("u1", "sms"), true);
});

test("gate.inbound writes where the check reads, under a policy keyPrefix", async () => {
  const store = new MemoryStore();
  const gate = createGate({ policy: { specVersion: "1.0.0", keyPrefix: "x:", checks: [{ id: "consent" }] }, store, inboundConsent: true });
  await gate.inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  assert.equal(await store.get("x:inbound:u1:sms"), "stopped");
  const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(decision.allowed, false);
  assert.equal(decision.rejectedBy, "inboundConsent");
});

test("gate.inbound also works under the default prefix", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.consent()], store, inboundConsent: true });
  await gate.inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(decision.rejectedBy, "inboundConsent");
});

test("ordering: the stop wins over quiet hours when consent passes, and consent false still wins over the stop", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.consent(), checks.quietHours()], store, inboundConsent: true });
  await gate.inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  const quiet = { ...user(), quietHours: { start: "11:00", end: "13:00" } } as UserState;
  const stopped = await gate.evaluate({ user: quiet, candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(stopped.rejectedBy, "inboundConsent");
  const noConsent = await gate.evaluate({ user: user({ consent: false }), candidate: candidate({ channel: "sms" }), now: noon });
  assert.equal(noConsent.rejectedBy, "consent");
});

test("without the flag the gate ignores a recorded stop, but gate.inbound still exists", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.consent()], store });
  await gate.inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  assert.equal((await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon })).allowed, true);
});

test("the flag inserts the check after consent, first when there is no consent check, and never twice", () => {
  const store = new MemoryStore();
  const after = createGate({ checks: [checks.consent(), checks.enabled()], store, inboundConsent: true });
  assert.deepEqual(after.checks.map((c) => c.id), ["consent", "inboundConsent", "enabled"]);
  const first = createGate({ checks: [checks.enabled()], store, inboundConsent: true });
  assert.equal(first.checks[0]!.id, "inboundConsent");
  const twice = createGate({ checks: defaultChecks({ inboundConsent: true }), store, inboundConsent: true });
  assert.equal(twice.checks.filter((c) => c.id === "inboundConsent").length, 1);
});

test("explain gives a sentence naming the stop for a gate rejection", async () => {
  const store = new MemoryStore();
  const gate = createGate({ checks: [checks.consent()], store, inboundConsent: true });
  await gate.inbound.handle({ userId: "u1", channel: "sms", text: "STOP" });
  const decision = await gate.evaluate({ user: user(), candidate: candidate({ channel: "sms" }), now: noon });
  const entry = explain(decision).checks.find((s) => s.id === "inboundConsent");
  assert.match(entry?.sentence ?? "", /stop/i);
});

test("a keyword followed by more than 64 characters of punctuation is refused by the length cap", () => {
  assert.equal(parseKeyword("STOP" + ".".repeat(70)), "none");
  assert.equal(parseKeyword("STOP" + ".".repeat(10)), "stop");
});
