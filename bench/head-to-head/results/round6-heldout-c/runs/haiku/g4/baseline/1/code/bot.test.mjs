import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = new URL('./bot.mjs', import.meta.url).href;
const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-10-23T08:00:00.000Z');

let stateRoot;
let stateDir;
let reserve;

beforeEach(async () => {
  stateRoot = await mkdtemp(path.join(os.tmpdir(), 'bot-test-'));
  // Nested, not yet existing: bot.mjs must create it.
  stateDir = path.join(stateRoot, 'a', 'b', 'state');
  process.env.STATE_DIR = stateDir;
  ({ reserve } = await import(`${botUrl}?case=${Math.random()}`));
});

afterEach(async () => {
  delete process.env.STATE_DIR;
  await rm(stateRoot, { recursive: true, force: true });
});

const at = (ms) => new Date(T0.getTime() + ms);

test('allows 5 messages, blocks the 6th, retryAt is when the oldest leaves the window', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await reserve('cust-1', 'sms', at(i * 1000));
    assert.equal(r.allowed, true);
    assert.equal(r.retryAt, null);
    assert.equal(typeof r.reason, 'string');
  }
  const blocked = await reserve('cust-1', 'sms', at(5000));
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.retryAt, new Date(T0.getTime() + DAY));
  assert.match(blocked.reason, /limit 5/);
  assert.match(blocked.reason, /2026-10-24T08:00:00\.000Z/);
});

test('window boundary: still blocked 1 ms before retryAt, allowed exactly at retryAt', async () => {
  for (let i = 0; i < 5; i++) await reserve('cust-b', 'push', at(i));
  const first = await reserve('cust-b', 'push', at(10));
  assert.equal(first.allowed, false);
  const retry = first.retryAt.getTime();

  const justBefore = await reserve('cust-b', 'push', new Date(retry - 1));
  assert.equal(justBefore.allowed, false);
  assert.equal(justBefore.retryAt.getTime(), retry);

  const atRetry = await reserve('cust-b', 'push', new Date(retry));
  assert.equal(atRetry.allowed, true);
  assert.equal(atRetry.retryAt, null);
});

test('denied calls are not counted', async () => {
  for (let i = 0; i < 5; i++) await reserve('cust-d', 'chat', at(i * 1000));
  for (let i = 0; i < 20; i++) {
    const r = await reserve('cust-d', 'chat', at(6000 + i));
    assert.equal(r.allowed, false);
    // Still the first send that expires, not any of the denied attempts.
    assert.deepEqual(r.retryAt, new Date(T0.getTime() + DAY));
  }
  const later = await reserve('cust-d', 'chat', new Date(T0.getTime() + DAY + 1000));
  assert.equal(later.allowed, true);
});

test('limit counts all channels together', async () => {
  const channels = ['sms', 'push', 'chat', 'sms', 'push'];
  for (const [i, ch] of channels.entries()) {
    assert.equal((await reserve('cust-c', ch, at(i))).allowed, true);
  }
  const blocked = await reserve('cust-c', 'chat', at(10));
  assert.equal(blocked.allowed, false);
});

test('sliding window: only sends older than 24h stop counting', async () => {
  // Sends at 0h,1h,2h,3h,4h. The 0h send leaves the window at 24h, the 1h send at 25h.
  // At 24.5h only the 0h send has expired, so 4 are live and one more is allowed.
  for (let h = 0; h < 5; h++) await reserve('cust-s', 'sms', at(h * 3600_000));
  assert.equal((await reserve('cust-s', 'sms', at(3600_000 * 4.5))).allowed, false);
  const r = await reserve('cust-s', 'sms', at(3600_000 * 24.5));
  assert.equal(r.allowed, true);
  // Now live sends: 1h,2h,3h,4h,24.5h. Next one blocked until 1h+24h = 25h.
  const b = await reserve('cust-s', 'sms', at(3600_000 * 24.6));
  assert.equal(b.allowed, false);
  assert.equal(b.retryAt.getTime(), T0.getTime() + 25 * 3600_000);
});

test('customers are independent', async () => {
  for (let i = 0; i < 5; i++) await reserve('alice', 'sms', at(i));
  assert.equal((await reserve('alice', 'sms', at(9))).allowed, false);
  assert.equal((await reserve('bob', 'sms', at(9))).allowed, true);
});

test('state survives a restart: a separate process sees the counted sends', async () => {
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const t = new Date(${T0.getTime()});
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await reserve('cust-r', 'push', new Date(t.getTime() + i))).allowed);
    console.log(JSON.stringify(out));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STATE_DIR: stateDir },
  });
  assert.deepEqual(JSON.parse(stdout), [true, true, true]);

  // This process: 2 more allowed, then blocked (total 5).
  assert.equal((await reserve('cust-r', 'sms', at(10))).allowed, true);
  assert.equal((await reserve('cust-r', 'sms', at(11))).allowed, true);
  assert.equal((await reserve('cust-r', 'sms', at(12))).allowed, false);
});

test('concurrent processes never exceed the limit for one customer', async () => {
  const procs = 12;
  const perProc = 3;
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const t = new Date(${T0.getTime()});
    const jobs = [];
    for (let i = 0; i < ${perProc}; i++) jobs.push(reserve('shared', 'chat', t));
    const results = await Promise.all(jobs);
    console.log(JSON.stringify(results.map((r) => r.allowed)));
  `;
  const outs = await Promise.all(
    Array.from({ length: procs }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, STATE_DIR: stateDir },
      }),
    ),
  );
  const allowed = outs.flatMap((o) => JSON.parse(o.stdout)).filter(Boolean).length;
  assert.equal(allowed, 5);
});

test('no stray lock directories or temp files remain', async () => {
  for (let i = 0; i < 7; i++) await reserve('cust-clean', 'sms', at(i));
  const names = await readdir(stateDir);
  assert.equal(names.filter((n) => n.endsWith('.lock') || n.endsWith('.tmp')).length, 0);
  assert.equal(names.length, 1);
});

test('invalid input is rejected', async () => {
  await assert.rejects(reserve('', 'sms', T0), TypeError);
  await assert.rejects(reserve('x', 'email', T0), TypeError);
  await assert.rejects(reserve('x', 'sms', Date.now()), TypeError);
  await assert.rejects(reserve('x', 'sms', new Date('nope')), TypeError);
});

test('missing STATE_DIR is an error', async () => {
  delete process.env.STATE_DIR;
  await assert.rejects(reserve('x', 'sms', T0), /STATE_DIR/);
});
