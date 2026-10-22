import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { reserve, release, REASONS } from './bot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = new Date('2026-10-22T10:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);

let stateDir;
const originalStateDir = process.env.STATE_DIR;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'bot-test-'));
  process.env.STATE_DIR = stateDir;
});

afterEach(async () => {
  process.env.STATE_DIR = originalStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const req = (overrides = {}) => ({
  userId: 'lead_204',
  maxPerWindow: 3,
  windowHours: 24,
  minGapMinutes: 90,
  ...overrides,
});

test('allows sends spaced by the gap and stops at the window cap with its own reason', async () => {
  const r1 = await reserve(req(), at(0));
  const r2 = await reserve(req(), at(2 * HOUR));
  const r3 = await reserve(req(), at(4 * HOUR));
  assert.equal(r1.allowed, true);
  assert.equal(r2.allowed, true);
  assert.equal(r3.allowed, true);
  assert.ok(r1.reservationId);

  const r4 = await reserve(req(), at(23 * HOUR));
  assert.deepEqual(r4, { allowed: false, reason: REASONS.WINDOW_LIMIT, reservationId: null });
  assert.notEqual(REASONS.MIN_GAP, REASONS.WINDOW_LIMIT);
});

test('blocks a send inside the minimum gap with the gap reason', async () => {
  await reserve(req(), at(0));
  const r = await reserve(req(), at(89 * MIN));
  assert.deepEqual(r, { allowed: false, reason: REASONS.MIN_GAP, reservationId: null });

  const ok = await reserve(req(), at(90 * MIN));
  assert.equal(ok.allowed, true);
});

test('uses a rolling window: an old send stops counting after windowHours', async () => {
  await reserve(req(), at(0));
  await reserve(req(), at(2 * HOUR));
  await reserve(req(), at(4 * HOUR));

  // At 23h the first send (23h old) still counts, so the cap holds.
  assert.equal((await reserve(req(), at(23 * HOUR))).allowed, false);
  // At 25h the first send is outside the window; the others leave a 21h gap.
  const later = await reserve(req(), at(25 * HOUR));
  assert.equal(later.allowed, true);
});

test('per-call limits are honoured and leads are independent', async () => {
  assert.equal((await reserve(req({ maxPerWindow: 1 }), at(0))).allowed, true);
  assert.equal((await reserve(req({ maxPerWindow: 1 }), at(3 * HOUR))).reason, REASONS.WINDOW_LIMIT);
  assert.equal((await reserve(req({ userId: 'lead_999', maxPerWindow: 1 }), at(0))).allowed, true);
});

test('release frees the slot, is idempotent, and ignores unknown ids', async () => {
  const r = await reserve(req({ maxPerWindow: 1, minGapMinutes: 0 }), at(0));
  assert.equal((await reserve(req({ maxPerWindow: 1, minGapMinutes: 0 }), at(1 * MIN))).allowed, false);

  assert.equal(await release(r.reservationId), true);
  assert.equal(await release(r.reservationId), false);
  assert.equal(await release('not-a-real-id'), false);
  assert.equal((await reserve(req({ maxPerWindow: 1, minGapMinutes: 0 }), at(2 * MIN))).allowed, true);
});

test('release works from a different process than the one that reserved', async () => {
  const reserved = await runChild(
    `const { reserve } = await import(${JSON.stringify(join(HERE, 'bot.mjs'))});
     console.log(JSON.stringify(await reserve({ userId: 'lead_204', maxPerWindow: 1, windowHours: 24, minGapMinutes: 0 }, new Date(${T0.getTime()}))));`,
  );
  assert.equal(reserved.allowed, true);

  const freed = await runChild(
    `const { release } = await import(${JSON.stringify(join(HERE, 'bot.mjs'))});
     console.log(JSON.stringify(await release(${JSON.stringify(reserved.reservationId)})));`,
  );
  assert.equal(freed, true);

  assert.equal((await reserve(req({ maxPerWindow: 1, minGapMinutes: 0 }), at(1 * MIN))).allowed, true);
});

test('a lock left behind by a crashed worker is broken and does not block sends', async () => {
  const lockPath = join(stateDir, 'locks', `${await keyOf('lead_204')}.lock`);
  await mkdir(lockPath, { recursive: true });
  const old = new Date(Date.now() - HOUR);
  await utimes(lockPath, old, old);

  const r = await reserve(req(), at(0));
  assert.equal(r.allowed, true);
});

test('concurrent workers cannot exceed the cap for one lead', async () => {
  const startAt = Date.now() + 1500;
  const script = `
    const { reserve } = await import(${JSON.stringify(join(HERE, 'bot.mjs'))});
    const wait = Number(process.argv[1]) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await reserve({ userId: 'lead_204', maxPerWindow: 3, windowHours: 24, minGapMinutes: 0 }, new Date(${T0.getTime()}));
    console.log(JSON.stringify(r));`;
  const results = await Promise.all(
    Array.from({ length: 12 }, () => runChild(script, [String(startAt)])),
  );
  assert.equal(results.filter((r) => r.allowed).length, 3);
  assert.ok(results.filter((r) => !r.allowed).every((r) => r.reason === REASONS.WINDOW_LIMIT));
});

test('concurrent workers with a gap: only one of many simultaneous sends goes out', async () => {
  const startAt = Date.now() + 1500;
  const script = `
    const { reserve } = await import(${JSON.stringify(join(HERE, 'bot.mjs'))});
    const wait = Number(process.argv[1]) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const r = await reserve({ userId: 'lead_204', maxPerWindow: 3, windowHours: 24, minGapMinutes: 90 }, new Date(${T0.getTime()}));
    console.log(JSON.stringify(r));`;
  const results = await Promise.all(
    Array.from({ length: 12 }, () => runChild(script, [String(startAt)])),
  );
  assert.equal(results.filter((r) => r.allowed).length, 1);
  assert.ok(results.filter((r) => !r.allowed).every((r) => r.reason === REASONS.MIN_GAP));
});

test('invalid input is rejected', async () => {
  await assert.rejects(reserve(req({ maxPerWindow: 0 }), at(0)), TypeError);
  await assert.rejects(reserve(req({ windowHours: 1000 }), at(0)), TypeError);
  await assert.rejects(reserve(req({ userId: '' }), at(0)), TypeError);
  await assert.rejects(reserve(req(), 'yesterday'), TypeError);
});

// ---------------------------------------------------------------------------

async function keyOf(userId) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(userId).digest('hex');
}

function runChild(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], {
      env: { ...process.env, STATE_DIR: stateDir },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      resolve(JSON.parse(out.trim()));
    });
  });
}
