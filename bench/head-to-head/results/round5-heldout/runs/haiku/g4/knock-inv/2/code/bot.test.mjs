import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(path.join(here, 'bot.mjs')).href;
const { reserve, release } = await import(botUrl);

const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = new Date('2026-10-22T09:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);

let stateDir;
let seq = 0;
// Each test gets its own lead so tests don't share history.
const lead = () => `lead_${seq++}_${Math.random().toString(36).slice(2)}`;
const req = (userId, over = {}) => ({ userId, maxPerWindow: 3, windowHours: 24, minGapMinutes: 0, ...over });

before(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'bot-test-'));
  process.env.STATE_DIR = stateDir;
});
after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test('allows up to maxPerWindow then denies with window_limit_reached', async () => {
  const u = lead();
  for (let i = 0; i < 3; i++) {
    const r = await reserve(req(u), at(i * MIN));
    assert.equal(r.allowed, true);
    assert.equal(r.reason, null);
    assert.equal(typeof r.reservationId, 'string');
  }
  const denied = await reserve(req(u), at(10 * MIN));
  assert.deepEqual(denied, { allowed: false, reason: 'window_limit_reached', reservationId: null });
});

test('window is rolling: a slot frees 24h after the send it counted', async () => {
  const u = lead();
  await reserve(req(u), at(0));
  await reserve(req(u), at(1 * HOUR));
  await reserve(req(u), at(2 * HOUR));
  assert.equal((await reserve(req(u), at(3 * HOUR))).reason, 'window_limit_reached');
  // Exactly 24h after the first send, that send is out of the window.
  assert.equal((await reserve(req(u), at(24 * HOUR))).allowed, true);
  // The 1h and 2h sends are still in the window, so this one is denied.
  assert.equal((await reserve(req(u), at(24 * HOUR + MIN))).reason, 'window_limit_reached');
});

test('min gap is enforced from the latest counted send', async () => {
  const u = lead();
  const g = req(u, { minGapMinutes: 90 });
  assert.equal((await reserve(g, at(0))).allowed, true);
  assert.deepEqual(await reserve(g, at(30 * MIN)), { allowed: false, reason: 'min_gap_not_elapsed', reservationId: null });
  assert.equal((await reserve(g, at(89 * MIN))).reason, 'min_gap_not_elapsed');
  assert.equal((await reserve(g, at(90 * MIN))).allowed, true);
  // Gap is measured from the 90-minute send, not from the first one.
  assert.equal((await reserve(g, at(150 * MIN))).reason, 'min_gap_not_elapsed');
  assert.equal((await reserve(g, at(180 * MIN))).allowed, true);
});

test('window limit is checked before gap, and each limit has its own code', async () => {
  const u = lead();
  const g = req(u, { maxPerWindow: 1, minGapMinutes: 60 });
  await reserve(g, at(0));
  assert.equal((await reserve(g, at(MIN))).reason, 'window_limit_reached');
  const loose = req(u, { maxPerWindow: 5, minGapMinutes: 60 });
  assert.equal((await reserve(loose, at(MIN))).reason, 'min_gap_not_elapsed');
});

test('per-call limits are honoured, so different campaigns can differ', async () => {
  const u = lead();
  assert.equal((await reserve(req(u, { maxPerWindow: 1 }), at(0))).allowed, true);
  assert.equal((await reserve(req(u, { maxPerWindow: 1 }), at(MIN))).allowed, false);
  // Same history, larger limit: allowed again.
  assert.equal((await reserve(req(u, { maxPerWindow: 2 }), at(2 * MIN))).allowed, true);
});

test('maxPerWindow of 0 denies everything', async () => {
  const r = await reserve(req(lead(), { maxPerWindow: 0 }), at(0));
  assert.equal(r.reason, 'window_limit_reached');
});

test('release frees the slot and the gap; released sends stop counting', async () => {
  const u = lead();
  const g = req(u, { maxPerWindow: 1, minGapMinutes: 90 });
  const first = await reserve(g, at(0));
  assert.equal(first.allowed, true);
  assert.equal((await reserve(g, at(MIN))).allowed, false);
  await release(first.reservationId);
  const second = await reserve(g, at(2 * MIN));
  assert.equal(second.allowed, true, 'slot should be free after release, gap too');
});

test('release is idempotent and accepts null from a denied reserve', async () => {
  const u = lead();
  const r = await reserve(req(u, { maxPerWindow: 1 }), at(0));
  await release(r.reservationId);
  await release(r.reservationId);
  await release(null);
  await release(undefined);
  const denied = await reserve(req(lead(), { maxPerWindow: 0 }), at(0));
  await release(denied.reservationId);
});

test('a second release of the same id does not free a second slot', async () => {
  const u = lead();
  const g = req(u, { maxPerWindow: 2 });
  const a = await reserve(g, at(0));
  await reserve(g, at(MIN));
  await release(a.reservationId);
  await release(a.reservationId);
  assert.equal((await reserve(g, at(2 * MIN))).allowed, true);
  assert.equal((await reserve(g, at(3 * MIN))).allowed, false);
});

test('history survives a restart (fresh module instance reads the same file)', async () => {
  const u = lead();
  await reserve(req(u, { maxPerWindow: 1 }), at(0));
  const fresh = await import(`${botUrl}?restart=${Date.now()}-${Math.random()}`);
  assert.equal((await fresh.reserve(req(u, { maxPerWindow: 1 }), at(MIN))).reason, 'window_limit_reached');
});

test('a corrupt history file throws instead of silently resetting', async () => {
  const u = lead();
  await reserve(req(u), at(0));
  const leadsDir = path.join(stateDir, 'leads');
  // Corrupt every lead file so the test does not depend on which file is hashed where.
  for (const f of await readdir(leadsDir)) {
    if (f.endsWith('.json')) await writeFile(path.join(leadsDir, f), '{not json');
  }
  await assert.rejects(reserve(req(u), at(MIN)), SyntaxError);
  // Restore clean state for later tests in this file.
  for (const f of await readdir(leadsDir)) {
    if (f.endsWith('.json')) await rm(path.join(leadsDir, f));
  }
});

test('validates inputs', async () => {
  const d = at(0);
  await assert.rejects(reserve(null, d), TypeError);
  await assert.rejects(reserve(req(''), d), TypeError);
  await assert.rejects(reserve(req('x', { maxPerWindow: -1 }), d), TypeError);
  await assert.rejects(reserve(req('x', { maxPerWindow: 1.5 }), d), TypeError);
  await assert.rejects(reserve(req('x', { windowHours: 0 }), d), TypeError);
  await assert.rejects(reserve(req('x', { minGapMinutes: -5 }), d), TypeError);
  await assert.rejects(reserve(req('x'), '2026-10-22'), TypeError);
  await assert.rejects(reserve(req('x'), new Date('nope')), TypeError);
  await assert.rejects(release('not-a-valid-id'), TypeError);
});

test('STATE_DIR is created when missing', async () => {
  const saved = process.env.STATE_DIR;
  const dir = path.join(stateDir, 'nested', 'new');
  process.env.STATE_DIR = dir;
  try {
    const r = await reserve(req(lead()), at(0));
    assert.equal(r.allowed, true);
    assert.ok((await readdir(dir)).includes('leads'));
  } finally {
    process.env.STATE_DIR = saved;
  }
});

test('concurrent reserves across processes never exceed the limit', async () => {
  const u = lead();
  const script = `
    const { reserve } = await import(${JSON.stringify(botUrl)});
    const r = await reserve(${JSON.stringify(req(u, { maxPerWindow: 3 }))}, new Date(${T0.getTime()}));
    process.stdout.write(JSON.stringify(r));
  `;
  const N = 15;
  const outs = await Promise.all(
    Array.from({ length: N }, () =>
      run(process.execPath, ['--input-type=module', '-e', script], { env: process.env }),
    ),
  );
  const results = outs.map((o) => JSON.parse(o.stdout));
  const allowed = results.filter((r) => r.allowed);
  assert.equal(allowed.length, 3, `expected exactly 3 allowed, got ${allowed.length}`);
  for (const r of results.filter((x) => !x.allowed)) {
    assert.equal(r.reason, 'window_limit_reached');
  }
});

test('a reservation made in one process can be released from another', async () => {
  const u = lead();
  const g = req(u, { maxPerWindow: 1 });
  const made = await reserve(g, at(0));
  assert.equal(made.allowed, true);
  const script = `
    const { release } = await import(${JSON.stringify(botUrl)});
    await release(${JSON.stringify(made.reservationId)});
  `;
  await run(process.execPath, ['--input-type=module', '-e', script], { env: process.env });
  assert.equal((await reserve(g, at(MIN))).allowed, true);
});
