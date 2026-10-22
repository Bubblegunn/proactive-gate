import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(path.join(here, 'bot.mjs')).href;
const DAY = 24 * 60 * 60 * 1000;

async function freshState() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = path.join(dir, 'nested', 'state');
  return process.env.STATE_DIR;
}

test('allows 5 sends across channels, blocks the 6th with retryAt = oldest + 24h', async () => {
  await freshState();
  const { reserve } = await import(`${botUrl}?a=1`);
  const t0 = new Date('2026-10-01T10:00:00Z');
  const channels = ['sms', 'push', 'chat', 'sms', 'push'];
  for (let i = 0; i < 5; i++) {
    const r = await reserve('cust-1', channels[i], new Date(t0.getTime() + i * 60_000));
    assert.equal(r.allowed, true);
    assert.equal(r.retryAt, null);
  }
  const blocked = await reserve('cust-1', 'chat', new Date(t0.getTime() + 10 * 60_000));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAt.getTime(), t0.getTime() + DAY);
  assert.match(blocked.reason, /5 proactive/);
});

test('retryAt is exact: blocked one ms before, allowed at it', async () => {
  await freshState();
  const { reserve } = await import(`${botUrl}?a=2`);
  const t0 = Date.parse('2026-10-02T00:00:00Z');
  // Sends at t0, t0+1h, t0+2h, t0+3h, t0+4h
  for (let i = 0; i < 5; i++) {
    await reserve('cust-2', 'push', new Date(t0 + i * 3600_000));
  }
  const blocked = await reserve('cust-2', 'push', new Date(t0 + 5 * 3600_000));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAt.getTime(), t0 + DAY);

  const before = await reserve('cust-2', 'push', new Date(t0 + DAY - 1));
  assert.equal(before.allowed, false);
  assert.equal(before.retryAt.getTime(), t0 + DAY);

  const at = await reserve('cust-2', 'push', new Date(t0 + DAY));
  assert.equal(at.allowed, true);
});

test('blocked calls are not counted', async () => {
  await freshState();
  const { reserve } = await import(`${botUrl}?a=3`);
  const t0 = Date.parse('2026-10-03T00:00:00Z');
  for (let i = 0; i < 5; i++) await reserve('cust-3', 'sms', new Date(t0 + i));
  for (let i = 0; i < 20; i++) {
    const r = await reserve('cust-3', 'sms', new Date(t0 + 100 + i));
    assert.equal(r.allowed, false);
  }
  // Only the first 5 sends are in the window, so the limit lifts at t0 + DAY.
  const r = await reserve('cust-3', 'sms', new Date(t0 + DAY));
  assert.equal(r.allowed, true);
});

test('customers do not affect each other', async () => {
  await freshState();
  const { reserve } = await import(`${botUrl}?a=4`);
  const t0 = Date.parse('2026-10-04T00:00:00Z');
  for (let i = 0; i < 5; i++) await reserve('alice', 'chat', new Date(t0 + i));
  assert.equal((await reserve('alice', 'chat', new Date(t0 + 10))).allowed, false);
  assert.equal((await reserve('bob', 'chat', new Date(t0 + 10))).allowed, true);
});

test('state survives a restart (new process sees the count)', async () => {
  const stateDir = await freshState();
  const t0 = Date.parse('2026-10-05T00:00:00Z');
  const code = `
    import { reserve } from ${JSON.stringify(botUrl)};
    const n = Number(process.argv[1]);
    const out = [];
    for (let i = 0; i < n; i++) out.push((await reserve('restart-user', 'push', new Date(${t0} + i))).allowed);
    console.log(JSON.stringify(out));`;
  const run = (n) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, ['--input-type=module', '-e', code, String(n)],
        { env: { ...process.env, STATE_DIR: stateDir } },
        (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)))));
  assert.deepEqual(await run(3), [true, true, true]);
  assert.deepEqual(await run(4), [true, true, false, false]);
});

test('concurrent processes for the same customer never exceed 5', async () => {
  const stateDir = await freshState();
  const code = `
    import { reserve } from ${JSON.stringify(botUrl)};
    const r = await reserve('race-user', 'sms', new Date());
    console.log(JSON.stringify(r.allowed));`;
  const runOne = () =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, ['--input-type=module', '-e', code],
        { env: { ...process.env, STATE_DIR: stateDir } },
        (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)))));
  const results = await Promise.all(Array.from({ length: 12 }, runOne));
  assert.equal(results.filter(Boolean).length, 5);
});

test('rejects invalid input and missing STATE_DIR', async () => {
  const stateDir = await freshState();
  const { reserve } = await import(`${botUrl}?a=5`);
  await assert.rejects(reserve('', 'sms', new Date()), TypeError);
  await assert.rejects(reserve('u', 'email', new Date()), TypeError);
  await assert.rejects(reserve('u', 'sms', Date.now()), TypeError);
  const saved = process.env.STATE_DIR;
  delete process.env.STATE_DIR;
  await assert.rejects(reserve('u', 'sms', new Date()), /STATE_DIR/);
  process.env.STATE_DIR = saved;
  assert.ok(stateDir);
});
