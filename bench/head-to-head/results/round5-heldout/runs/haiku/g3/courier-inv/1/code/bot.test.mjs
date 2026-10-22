import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalEmail,
  mayEmail,
  recordResubscribe,
  recordUnsubscribe,
} from "./bot.mjs";

const marketing = (to) => ({ to, kind: "marketing" });
const transactional = (to) => ({ to, kind: "transactional" });
const t = (n) => new Date(1_700_000_000_000 + n);

let dir;
test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bot-test-"));
  process.env.STATE_DIR = join(dir, "not-yet-created"); // must be created on demand
});
test.afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  delete process.env.STATE_DIR;
});

test("canonicalEmail folds case, display names, plus-tags, Gmail dots", () => {
  const a = canonicalEmail("<EMAIL>");
  assert.equal(a, "<EMAIL>");
  assert.equal(canonicalEmail('"Jane" <<EMAIL>>'), a);
  assert.equal(canonicalEmail("mailto:<EMAIL>"), a);
  assert.equal(canonicalEmail("  x+tag@Example.COM "), "x@example.com");
});

test("canonicalEmail rejects malformed input", () => {
  for (const bad of ["", "no-at-sign", "@x.com", "a@", "<EMAIL>", "a <EMAIL>", 5]) {
    assert.throws(() => canonicalEmail(bad), TypeError, String(bad));
  }
});

test("unsubscribe blocks marketing, not transactional", async () => {
  await recordUnsubscribe("<EMAIL>", t(1));
  assert.deepEqual(await mayEmail(marketing("<EMAIL>"), t(2)), { allowed: false, reason: "unsubscribed" });
  assert.deepEqual(await mayEmail(transactional("<EMAIL>"), t(2)), { allowed: true, reason: null });
});

test("unsubscribe applies to every spelling of the same person", async () => {
  await recordUnsubscribe('"A" <<EMAIL>>', t(1));
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(2))).reason, "unsubscribed");
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(2))).reason, "unsubscribed");
});

test("an unrelated address is not blocked", async () => {
  await recordUnsubscribe("<EMAIL>", t(1));
  assert.deepEqual(await mayEmail(marketing("<EMAIL>"), t(2)), { allowed: true, reason: null });
});

test("no events means marketing is allowed", async () => {
  assert.deepEqual(await mayEmail(marketing("<EMAIL>"), t(0)), { allowed: true, reason: null });
});

test("resubscribe after unsubscribe re-enables marketing", async () => {
  await recordUnsubscribe("<EMAIL>", t(1));
  await recordResubscribe("<EMAIL>", t(2));
  assert.deepEqual(await mayEmail(marketing("<EMAIL>"), t(3)), { allowed: true, reason: null });
});

test("out of order: a late older resubscribe does not undo a newer unsubscribe", async () => {
  await recordUnsubscribe("<EMAIL>", t(5));
  await recordResubscribe("<EMAIL>", t(2)); // arrives late
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(6))).reason, "unsubscribed");
});

test("out of order: a late unsubscribe does not undo a newer resubscribe", async () => {
  await recordResubscribe("<EMAIL>", t(5));
  await recordUnsubscribe("<EMAIL>", t(2)); // arrives late
  assert.deepEqual(await mayEmail(marketing("<EMAIL>"), t(6)), { allowed: true, reason: null });
});

test("same timestamp: unsubscribe wins regardless of arrival order", async () => {
  await recordResubscribe("<EMAIL>", t(3));
  await recordUnsubscribe("<EMAIL>", t(3));
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(4))).reason, "unsubscribed");

  await recordUnsubscribe("<EMAIL>", t(3));
  await recordResubscribe("<EMAIL>", t(3));
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(4))).reason, "unsubscribed");
});

test("duplicate webhook deliveries are harmless", async () => {
  for (let i = 0; i < 3; i++) await recordUnsubscribe("<EMAIL>", t(1));
  await recordResubscribe("<EMAIL>", t(2));
  for (let i = 0; i < 3; i++) await recordUnsubscribe("<EMAIL>", t(1)); // old, replayed
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(3))).allowed, true);
});

test("concurrent writes from many workers are all kept", async () => {
  const people = Array.from({ length: 50 }, (_, i) => `p${i}@x.com`);
  await Promise.all(people.flatMap((p) => [recordUnsubscribe(p, t(1)), recordUnsubscribe(p, t(1))]));
  const results = await Promise.all(people.map((p) => mayEmail(marketing(p), t(2))));
  assert.ok(results.every((r) => r.reason === "unsubscribed"));
});

test("state survives a restart (fresh module instance reads the same files)", async () => {
  await recordUnsubscribe("<EMAIL>", t(1));
  const fresh = await import(`./bot.mjs?restart=${Date.now()}`);
  assert.equal((await fresh.mayEmail(marketing("<EMAIL>"), t(2))).reason, "unsubscribed");
});

test("invalid input is refused, never allowed", async () => {
  assert.equal((await mayEmail(marketing("nope"), t(0))).reason, "invalid_recipient");
  assert.equal((await mayEmail(null, t(0))).reason, "invalid_message");
  assert.equal((await mayEmail({ to: "<EMAIL>", kind: "promo" }, t(0))).reason, "unknown_kind");
});

test("marketing fails closed when the store is unavailable; transactional still goes", async () => {
  delete process.env.STATE_DIR;
  assert.equal((await mayEmail(marketing("<EMAIL>"), t(0))).reason, "suppression_check_failed");
  assert.deepEqual(await mayEmail(transactional("<EMAIL>"), t(0)), { allowed: true, reason: null });
});

test("invalid event input throws instead of being stored", async () => {
  await assert.rejects(recordUnsubscribe("<EMAIL>", "2026-01-01"), TypeError);
  await assert.rejects(recordUnsubscribe("bad", t(1)), TypeError);
});
