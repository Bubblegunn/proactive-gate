import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(join(here, 'bot.mjs')).href;
const execFileP = promisify(execFile);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;

async function freshState(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = join(dir, 'nested', 'state');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return process.env.STATE_DIR;
}

test('allows 5 messages and blocks the 6th, with retryAt from the oldest', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  const t0 = new Date('2026-10-01T10:00:00Z');
  const channels = ['sms', 'push', 'chat', 'sms', 'push'];
  for (let i = 0; i < 5; i++) {
    const r = await reserve('cust-1', channels[i], new Date(t0.getTime() + i * MIN));
    assert.deepEqual(r, { allowed: true, retryAt: null, reason: r.reason });
    assert.equal(typeof r.reason, 'string');
  }
  const blocked = await reserve('cust-1', 'chat', new Date(t0.getTime() + 5 * MIN));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAt.getTime(), t0.getTime() + DAY);
  assert.match(blocked.reason, /cust-1/);
  assert.match(blocked.reason, /5 proactive/);
  assert.match(blocked.reason, /chat/);
});

test('retryAt is exact: denied one ms earlier, allowed at retryAt', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  for (let i = 0; i < 5; i++) {
    assert.equal((await reserve('cust-2', 'push', new Date(t0 + i * 10 * MIN))).allowed, true);
  }
  const probe = await reserve('cust-2', 'sms', new Date(t0 + 50 * MIN));
  assert.equal(probe.allowed, false);
  assert.equal(probe.retryAt.getTime(), t0 + DAY);

  const early = await reserve('cust-2', 'sms', new Date(t0 + DAY - 1));
  assert.equal(early.allowed, false);
  assert.equal(early.retryAt.getTime(), t0 + DAY);

  const onTime = await reserve('cust-2', 'sms', new Date(t0 + DAY));
  assert.equal(onTime.allowed, true);
  // The window now holds the messages at t0+10..40min and the one at t0+24h (5 total).
  // The oldest in-window message is t0+10min, so the next block lasts until t0+10min+24h.
  const next = await reserve('cust-2', 'sms', new Date(t0 + DAY + MIN));
  assert.equal(next.allowed, false);
  assert.equal(next.retryAt.getTime(), t0 + 10 * MIN + DAY + 0);
});

test('a denied call counts nothing', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  for (let i = 0; i < 5; i++) await reserve('cust-3', 'chat', new Date(t0 + i));
  for (let i = 0; i < 10; i++) {
    assert.equal((await reserve('cust-3', 'chat', new Date(t0 + 100 + i))).allowed, false);
  }
  // If the 10 denied calls had been counted, nothing would be allowed at t0+DAY.
  const r = await reserve('cust-3', 'chat', new Date(t0 + DAY));
  assert.equal(r.allowed, true);
});

test('customers do not affect each other', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  for (let i = 0; i < 5; i++) await reserve('alice', 'sms', new Date(t0 + i));
  assert.equal((await reserve('alice', 'sms', new Date(t0 + 9))).allowed, false);
  for (let i = 0; i < 5; i++) {
    assert.equal((await reserve('bob', 'push', new Date(t0 + 9))).allowed, true);
  }
  assert.equal((await reserve('bob', 'push', new Date(t0 + 10))).allowed, false);
});

test('a message older than 24h does not count, and the window slides', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  for (let i = 0; i < 5; i++) await reserve('cust-4', 'sms', new Date(t0 + i * HOUR));
  // At t0+25h the window is (t0+1h, t0+25h]. The entry at t0+1h is exactly 24h old,
  // so it is out. t0+2h..t0+4h are in: 3 messages, so two more fit and the third is blocked.
  assert.equal((await reserve('cust-4', 'sms', new Date(t0 + 25 * HOUR))).allowed, true);
  assert.equal((await reserve('cust-4', 'sms', new Date(t0 + 25 * HOUR + 1))).allowed, true);
  assert.equal((await reserve('cust-4', 'sms', new Date(t0 + 25 * HOUR + 2))).allowed, false);
});

test('state survives a restart (fresh module instance in a new process)', async (t) => {
  const dir = await freshState(t);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await reserve('cust-5', 'sms', new Date(${t0} + i))).allowed);
    console.log(JSON.stringify(out));
  `;
  const run = () => execFileP(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STATE_DIR: dir },
  });
  // First process stores 3 messages; the second process sees 3 already stored,
  // so it allows 2 more and blocks the 3rd.
  assert.deepEqual(JSON.parse((await run()).stdout), [true, true, true]);
  assert.deepEqual(JSON.parse((await run()).stdout), [true, true, false]);
});

test('concurrent processes never exceed the limit', async (t) => {
  const dir = await freshState(t);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  const start = Date.now() + 1500;
  const N = 12;
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const wait = ${start} - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const chans = ['sms', 'push', 'chat'];
    const r = await reserve('shared', chans[process.argv[1] % 3], new Date(${t0}));
    console.log(JSON.stringify(r.allowed));
  `;
  const runs = Array.from({ length: N }, (_, i) =>
    execFileP(process.execPath, ['--input-type=module', '-e', script, String(i)], {
      env: { ...process.env, STATE_DIR: dir },
    }),
  );
  const results = (await Promise.all(runs)).map((r) => JSON.parse(r.stdout));
  assert.equal(results.filter(Boolean).length, 5);
  assert.equal(results.filter((x) => !x).length, N - 5);
});

test('concurrent processes with a shared customer and different customers', async (t) => {
  const dir = await freshState(t);
  const t0 = new Date('2026-10-01T00:00:00Z').getTime();
  const start = Date.now() + 1500;
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const wait = ${start} - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const user = process.argv[1];
    const r = await reserve(user, 'push', new Date(${t0}));
    console.log(JSON.stringify(r.allowed));
  `;
  const users = ['a', 'a', 'a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'b', 'b', 'c'];
  const results = await Promise.all(users.map((u) =>
    execFileP(process.execPath, ['--input-type=module', '-e', script, u], {
      env: { ...process.env, STATE_DIR: dir },
    }).then((r) => JSON.parse(r.stdout)),
  ));
  const allowedBy = (u) => results.filter((ok, i) => users[i] === u && ok).length;
  assert.equal(allowedBy('a'), 5);
  assert.equal(allowedBy('b'), 5);
  assert.equal(allowedBy('c'), 1);
});

test('a stale lock left by a crashed process is recovered', async (t) => {
  const dir = await freshState(t);
  const { reserve } = await import(botUrl);
  const key = createHash('sha256').update('cust-6').digest('hex');
  const lockDir = join(dir, 'customers', `${key}.lock`);
  await mkdir(lockDir, { recursive: true });
  const { utimes } = await import('node:fs/promises');
  const old = new Date(Date.now() - 60 * 1000);
  await utimes(lockDir, old, old);
  const r = await reserve('cust-6', 'sms', new Date('2026-10-01T00:00:00Z'));
  assert.equal(r.allowed, true);
  assert.deepEqual((await readdir(join(dir, 'customers'))).filter((f) => f.endsWith('.lock')), []);
});

test('corrupt state fails closed', async (t) => {
  const dir = await freshState(t);
  const { reserve } = await import(botUrl);
  const key = createHash('sha256').update('cust-7').digest('hex');
  await mkdir(join(dir, 'customers'), { recursive: true });
  await writeFile(join(dir, 'customers', `${key}.json`), '{"not":"an array"}');
  await assert.rejects(reserve('cust-7', 'sms', new Date()));
  // The lock must be released even though the call failed.
  assert.deepEqual((await readdir(join(dir, 'customers'))).filter((f) => f.endsWith('.lock')), []);
});

test('invalid input is rejected', async (t) => {
  await freshState(t);
  const { reserve } = await import(botUrl);
  await assert.rejects(reserve('', 'sms', new Date()), TypeError);
  await assert.rejects(reserve('x', 'email', new Date()), TypeError);
  await assert.rejects(reserve('x', 'sms', Date.now()), TypeError);
  await assert.rejects(reserve('x', 'sms', new Date('nope')), TypeError);
});
