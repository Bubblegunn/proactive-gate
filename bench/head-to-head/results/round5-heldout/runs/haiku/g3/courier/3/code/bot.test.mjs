import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  canonicalAddress,
  recordUnsubscribe,
  recordResubscribe,
  mayEmail,
} from './bot.mjs';

const botUrl = new URL('./bot.mjs', import.meta.url).href;
const MARKETING = (to) => ({ to, kind: 'marketing' });
const TRANSACTIONAL = (to) => ({ to, kind: 'transactional' });
const NOW = new Date('2026-10-22T12:00:00Z');

let dir;
let prevStateDir;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bot-test-'));
  prevStateDir = process.env.STATE_DIR;
  process.env.STATE_DIR = path.join(dir, 'state');
});

afterEach(async () => {
  if (prevStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = prevStateDir;
  await rm(dir, { recursive: true, force: true });
});

test('canonicalAddress normalizes header and typed forms', () => {
  assert.equal(canonicalAddress('  Jane.Doe+shop@Example.COM '), 'jane.doe@example.com');
  assert.equal(canonicalAddress('"Jane" <jane@example.com>'), 'jane@example.com');
  assert.equal(canonicalAddress('mailto:jane@example.com'), 'jane@example.com');
  assert.equal(canonicalAddress('<EMAIL>'), '<EMAIL>');
  assert.equal(canonicalAddress('not an address'), null);
  assert.equal(canonicalAddress('a@localhost'), null);
  assert.equal(canonicalAddress(42), null);
});

test('no events: marketing allowed, transactional allowed', async () => {
  assert.deepEqual(await mayEmail(MARKETING('a@example.com'), NOW), { allowed: true, reason: null });
  assert.deepEqual(await mayEmail(TRANSACTIONAL('a@example.com'), NOW), { allowed: true, reason: null });
});

test('unsubscribe blocks marketing for every spelling, keeps transactional', async () => {
  await recordUnsubscribe('Jane <Jane@Example.com>', new Date('2026-10-01T00:00:00Z'));
  assert.deepEqual(await mayEmail(MARKETING('jane@example.com'), NOW), { allowed: false, reason: 'unsubscribed' });
  assert.deepEqual(await mayEmail(MARKETING('jane+promo@example.com'), NOW), { allowed: false, reason: 'unsubscribed' });
  assert.deepEqual(await mayEmail(TRANSACTIONAL('jane@example.com'), NOW), { allowed: true, reason: null });
  assert.deepEqual(await mayEmail(MARKETING('other@example.com'), NOW), { allowed: true, reason: null });
});

test('resubscribe after unsubscribe re-allows marketing', async () => {
  await recordUnsubscribe('jane@example.com', new Date('2026-10-01T00:00:00Z'));
  await recordResubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, true);
});

test('resubscribe before unsubscribe does not clear the opt-out', async () => {
  await recordResubscribe('jane@example.com', new Date('2026-10-01T00:00:00Z'));
  await recordUnsubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, false);
});

test('out-of-order delivery: decided by at, not arrival order', async () => {
  // Arrives: resubscribe(Oct 5), then the older unsubscribe(Oct 1). Still resubscribed.
  await recordResubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  await recordUnsubscribe('jane@example.com', new Date('2026-10-01T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, true);

  // A newer unsubscribe (Oct 9) arrives late, after the resubscribe. Blocked again.
  await recordUnsubscribe('jane@example.com', new Date('2026-10-09T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, false);
});

test('equal timestamps: unsubscribe wins', async () => {
  const t = new Date('2026-10-05T00:00:00Z');
  await recordResubscribe('jane@example.com', t);
  await recordUnsubscribe('jane@example.com', t);
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, false);
});

test('duplicate webhook deliveries are harmless', async () => {
  const t = new Date('2026-10-01T00:00:00Z');
  await recordUnsubscribe('jane@example.com', t);
  await recordUnsubscribe('jane@example.com', t);
  await recordResubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  await recordResubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, true);
});

test('torn write from a killed worker does not hide the next event', async () => {
  const stateDir = process.env.STATE_DIR;
  await recordUnsubscribe('jane@example.com', new Date('2026-10-01T00:00:00Z'));
  const [file] = (await readdir(path.join(stateDir, 'optout-events'))).map((f) =>
    path.join(stateDir, 'optout-events', f));
  await appendFile(file, '\n{"id":"half", "type":"unsub'); // no newline, partial JSON
  await recordResubscribe('jane@example.com', new Date('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, true);
  await recordUnsubscribe('jane@example.com', new Date('2026-10-09T00:00:00Z'));
  assert.equal((await mayEmail(MARKETING('jane@example.com'), NOW)).allowed, false);
});

test('invalid recipient and unknown kind are refused', async () => {
  assert.deepEqual(await mayEmail(MARKETING('nope'), NOW), { allowed: false, reason: 'invalid_recipient' });
  assert.deepEqual(await mayEmail({ to: 'a@example.com', kind: 'newsletter' }, NOW), {
    allowed: false,
    reason: 'unknown_message_kind',
  });
});

test('invalid inputs to record functions throw', async () => {
  await assert.rejects(recordUnsubscribe('nope', new Date()), TypeError);
  await assert.rejects(recordUnsubscribe('a@example.com', '2026-10-01'), TypeError);
  await assert.rejects(recordResubscribe('a@example.com', new Date('x')), TypeError);
});

test('STATE_DIR is created when missing', async () => {
  await recordUnsubscribe('a@example.com', new Date('2026-10-01T00:00:00Z'));
  const files = await readdir(path.join(process.env.STATE_DIR, 'optout-events'));
  assert.equal(files.length, 1);
});

test('state survives a restart (fresh module instance reads the same files)', async () => {
  await recordUnsubscribe('jane@example.com', new Date('2026-10-01T00:00:00Z'));
  const fresh = await import(`${botUrl}?restart=${Date.now()}`);
  assert.equal((await fresh.mayEmail(MARKETING('jane@example.com'), NOW)).allowed, false);
});

test('concurrent writers in separate processes lose no events', async () => {
  const workers = 4;
  const perWorker = 60;
  const script = `
    const m = await import(${JSON.stringify(botUrl)});
    const w = Number(process.argv[1]);
    for (let i = 0; i < ${perWorker}; i++) {
      await m.recordUnsubscribe('shared@example.com', new Date(Date.UTC(2026, 9, 1, 0, 0, i)));
      await m.recordUnsubscribe('w' + w + '-' + i + '@example.com', new Date());
    }`;
  const runs = Array.from({ length: workers }, (_, w) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(w)], {
      env: { ...process.env, STATE_DIR: process.env.STATE_DIR },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${w} exited ${code}`))));
  }));
  await Promise.all(runs);

  const dirPath = path.join(process.env.STATE_DIR, 'optout-events');
  const files = await readdir(dirPath);
  // one file per unique per-worker address, plus the shared address
  assert.equal(files.length, workers * perWorker + 1);
  const sharedFile = (await Promise.all(files.map(async (f) => ({ f, text: await readFile(path.join(dirPath, f), 'utf8') }))))
    .find(({ text }) => text.includes('"key":"shared@example.com"'));
  const lines = sharedFile.text.split('\n').filter(Boolean);
  assert.equal(lines.length, workers * perWorker);
  for (const line of lines) JSON.parse(line); // every line is intact JSON
  assert.equal((await mayEmail(MARKETING('shared@example.com'), NOW)).allowed, false);
});
