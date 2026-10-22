import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(path.join(here, 'bot.mjs')).href;
const run = promisify(execFile);

const { recordUnsubscribe, recordResubscribe, mayEmail } = await import(botUrl);

const T1 = new Date('2026-10-01T10:00:00Z');
const T2 = new Date('2026-10-05T10:00:00Z');
const T3 = new Date('2026-10-09T10:00:00Z');
const NOW = new Date('2026-10-22T12:00:00Z');
const marketing = (to) => ({ to, kind: 'marketing' });
const transactional = (to) => ({ to, kind: 'transactional' });

let stateDir;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = path.join(stateDir, 'nested', 'dir'); // does not exist yet
});
afterEach(async () => {
  delete process.env.STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

test('unsubscribe blocks marketing but not transactional mail', async () => {
  await recordUnsubscribe('jane@example.com', T1);
  assert.deepEqual(await mayEmail(marketing('jane@example.com'), NOW), { allowed: false, reason: 'unsubscribed' });
  assert.deepEqual(await mayEmail(transactional('jane@example.com'), NOW), { allowed: true, reason: null });
});

test('an address with no events is allowed for marketing', async () => {
  assert.deepEqual(await mayEmail(marketing('new@example.com'), NOW), { allowed: true, reason: null });
});

test('aliases of the same person are treated as one', async () => {
  await recordUnsubscribe('"Jane Doe" <<EMAIL>>', T1);
  for (const to of ['<EMAIL>', '<EMAIL>', '<EMAIL>']) {
    assert.equal((await mayEmail(marketing(to), NOW)).reason, 'unsubscribed', to);
  }
  await recordUnsubscribe('mailto:Jane+x@Example.COM.', T1);
  assert.equal((await mayEmail(marketing('jane@example.com'), NOW)).allowed, false);
});

test('out-of-order events: the latest timestamp decides, not arrival order', async () => {
  // Resubscribe arrives first, then the older unsubscribe shows up late.
  await recordResubscribe('amy@example.com', T2);
  await recordUnsubscribe('amy@example.com', T1);
  assert.equal((await mayEmail(marketing('amy@example.com'), NOW)).allowed, true);

  // A newer unsubscribe overrides the resubscribe.
  await recordUnsubscribe('amy@example.com', T3);
  assert.equal((await mayEmail(marketing('amy@example.com'), NOW)).reason, 'unsubscribed');

  // Late duplicate of the old resubscribe must not undo the newer unsubscribe.
  await recordResubscribe('amy@example.com', T2);
  assert.equal((await mayEmail(marketing('amy@example.com'), NOW)).reason, 'unsubscribed');
});

test('a resubscribe after an unsubscribe re-enables marketing', async () => {
  await recordUnsubscribe('bo@example.com', T1);
  await recordResubscribe('bo@example.com', T2);
  assert.deepEqual(await mayEmail(marketing('bo@example.com'), NOW), { allowed: true, reason: null });
});

test('equal timestamps: unsubscribe wins', async () => {
  await recordResubscribe('cy@example.com', T1);
  await recordUnsubscribe('cy@example.com', T1);
  assert.equal((await mayEmail(marketing('cy@example.com'), NOW)).reason, 'unsubscribed');
});

test('repeated delivery of the same event is idempotent', async () => {
  await recordUnsubscribe('di@example.com', T1);
  await recordUnsubscribe('di@example.com', T1);
  await recordUnsubscribe('DI@example.com', T1);
  assert.equal((await mayEmail(marketing('di@example.com'), NOW)).reason, 'unsubscribed');
});

test('unparseable recipient and unknown kind are blocked', async () => {
  assert.deepEqual(await mayEmail(marketing('not-an-address'), NOW), { allowed: false, reason: 'invalid_recipient' });
  assert.deepEqual(await mayEmail({ to: 'x@example.com', kind: 'newsletter' }, NOW), { allowed: false, reason: 'unknown_kind' });
});

test('recording rejects bad input instead of storing it', async () => {
  await assert.rejects(recordUnsubscribe('nobody', T1), TypeError);
  await assert.rejects(recordUnsubscribe('ok@example.com', 'yesterday'), TypeError);
});

test('state survives a restart and is shared by separate processes', async () => {
  const script = (body) => `
    const m = await import(${JSON.stringify(botUrl)} + '?v=' + Math.random());
    ${body}`;
  const env = { ...process.env, STATE_DIR: process.env.STATE_DIR };

  // 20 workers record unsubscribes for the same person at once.
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    run(process.execPath, ['--input-type=module', '-e',
      script(`await m.recordUnsubscribe(${i % 2 ? '"<EMAIL>"' : '"<EMAIL>"'}, new Date(${T1.getTime()} + ${i}));`)], { env })));

  // A fresh process sees the result.
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e',
    script(`console.log(JSON.stringify(await m.mayEmail({ to: "<EMAIL>", kind: "marketing" }, new Date())));`)], { env });
  assert.deepEqual(JSON.parse(stdout), { allowed: false, reason: 'unsubscribed' });
});
