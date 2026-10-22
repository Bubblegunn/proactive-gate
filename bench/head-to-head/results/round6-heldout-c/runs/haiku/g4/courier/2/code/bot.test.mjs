import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { reserve } from './bot.mjs';

const DAY = 24 * 60 * 60 * 1000;
const MODULE_URL = pathToFileURL(path.resolve('bot.mjs')).href;

async function withStateDir(fn) {
  const base = await mkdtemp(path.join(tmpdir(), 'bot-test-'));
  // Nested, not yet existing: reserve() must create the missing parents.
  const stateDir = path.join(base, 'a', 'b', 'state');
  const previous = process.env.STATE_DIR;
  process.env.STATE_DIR = stateDir;
  try {
    await fn(stateDir);
  } finally {
    process.env.STATE_DIR = previous;
    await rm(base, { recursive: true, force: true });
  }
}

test('allows 5 sends, blocks the 6th, retryAt is oldest send + 24h', async () => {
  await withStateDir(async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      const r = await reserve('cust-1', 'sms', new Date(t0.getTime() + i * 1000));
      assert.equal(r.allowed, true);
      assert.equal(r.retryAt, null);
      assert.equal(typeof r.reason, 'string');
    }
    const blocked = await reserve('cust-1', 'push', new Date(t0.getTime() + 10_000));
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAt.getTime(), t0.getTime() + DAY);
    assert.match(blocked.reason, /5 proactive/);
    assert.match(blocked.reason, /all channels/);
  });
});

test('blocked calls are not counted', async () => {
  await withStateDir(async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 5; i++) await reserve('cust-2', 'chat', t0);
    for (let i = 0; i < 20; i++) {
      const r = await reserve('cust-2', 'chat', new Date(t0.getTime() + 1000 * i));
      assert.equal(r.allowed, false);
    }
    // At t0+24h15s the five sends at t0 have aged out. The blocked calls at t0+1s..t0+20s
    // would still be in the window if they had been stored, so a full 5 new sends
    // proves they were not.
    const later = new Date(t0.getTime() + DAY + 15_000);
    for (let i = 0; i < 5; i++) {
      assert.equal((await reserve('cust-2', 'chat', later)).allowed, true, `send ${i + 1}`);
    }
    assert.equal((await reserve('cust-2', 'chat', later)).allowed, false);
  });
});

test('retryAt is exact: blocked 1 ms before, allowed at retryAt', async () => {
  await withStateDir(async () => {
    const t0 = new Date('2026-10-01T10:00:00.000Z');
    const times = [0, 100, 200, 300, 400].map((d) => new Date(t0.getTime() + d));
    for (const t of times) assert.equal((await reserve('cust-3', 'sms', t)).allowed, true);
    const probe = new Date(t0.getTime() + 500);
    const blocked = await reserve('cust-3', 'sms', probe);
    assert.equal(blocked.allowed, false);
    const retry = blocked.retryAt;
    assert.equal(retry.getTime(), t0.getTime() + DAY);

    const justBefore = new Date(retry.getTime() - 1);
    assert.equal((await reserve('cust-3', 'sms', justBefore)).allowed, false);
    const atRetry = await reserve('cust-3', 'sms', retry);
    assert.equal(atRetry.allowed, true);
  });
});

test('limit counts all channels together', async () => {
  await withStateDir(async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    const channels = ['sms', 'push', 'chat', 'sms', 'push'];
    for (const [i, ch] of channels.entries()) {
      assert.equal((await reserve('cust-4', ch, new Date(t0.getTime() + i))).allowed, true);
    }
    assert.equal((await reserve('cust-4', 'chat', new Date(t0.getTime() + 9))).allowed, false);
  });
});

test('sliding window: sends spread over more than 24h are allowed as they age out', async () => {
  await withStateDir(async () => {
    const h = 3600_000;
    const t0 = new Date('2026-10-01T00:00:00Z').getTime();
    const at = (hours) => new Date(t0 + hours * h);
    // Sends at 0h, 6h, 12h, 18h, 19h fill the window.
    for (const hours of [0, 6, 12, 18, 19]) {
      assert.equal((await reserve('cust-5', 'push', at(hours))).allowed, true);
    }
    const blocked = await reserve('cust-5', 'push', at(20));
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAt.getTime(), t0 + DAY, 'the 0h send ages out at 24h');
    // At 24h the 0h send is out of the window, so one more fits.
    assert.equal((await reserve('cust-5', 'push', at(24))).allowed, true);
    // Now the window holds 6h, 12h, 18h, 19h, 24h. The next free slot is when 6h ages out.
    const again = await reserve('cust-5', 'push', new Date(t0 + 24 * h + 1000));
    assert.equal(again.allowed, false);
    assert.equal(again.retryAt.getTime(), t0 + 6 * h + DAY);
  });
});

test('different customers do not affect each other', async () => {
  await withStateDir(async () => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 5; i++) await reserve('cust-A', 'sms', t0);
    assert.equal((await reserve('cust-A', 'sms', t0)).allowed, false);
    assert.equal((await reserve('cust-B', 'sms', t0)).allowed, true);
    assert.equal((await reserve('cust-B/../../x', 'sms', t0)).allowed, true, 'odd ids are hashed, not used as paths');
  });
});

test('state survives a restart (fresh process sees earlier sends)', async () => {
  await withStateDir(async (stateDir) => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    for (let i = 0; i < 5; i++) await reserve('cust-R', 'chat', t0);
    const out = await runChild(
      `const r = await reserve('cust-R', 'chat', new Date('${t0.toISOString()}'));
       console.log(JSON.stringify({ allowed: r.allowed }));`,
      stateDir,
    );
    assert.equal(JSON.parse(out).allowed, false);
  });
});

test('concurrent processes never exceed the limit', async () => {
  await withStateDir(async (stateDir) => {
    const t0 = new Date('2026-10-01T10:00:00Z').toISOString();
    const script = `
      const results = [];
      for (let i = 0; i < 4; i++) {
        results.push((await reserve('cust-C', 'sms', new Date('${t0}'))).allowed);
      }
      console.log(JSON.stringify(results));`;
    const outs = await Promise.all(Array.from({ length: 10 }, () => runChild(script, stateDir)));
    const allowed = outs.flatMap((o) => JSON.parse(o)).filter(Boolean).length;
    assert.equal(allowed, 5, `expected exactly 5 allowed across 40 attempts, got ${allowed}`);
  });
});

test('invalid input throws TypeError', async () => {
  await withStateDir(async () => {
    const d = new Date();
    await assert.rejects(reserve('', 'sms', d), TypeError);
    await assert.rejects(reserve(42, 'sms', d), TypeError);
    await assert.rejects(reserve('c', 'email', d), TypeError);
    await assert.rejects(reserve('c', 'sms', Date.now()), TypeError);
    await assert.rejects(reserve('c', 'sms', new Date('nope')), TypeError);
  });
});

test('corrupt state file rejects instead of allowing a send', async () => {
  await withStateDir(async (stateDir) => {
    const t0 = new Date('2026-10-01T10:00:00Z');
    await reserve('cust-X', 'sms', t0);
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update('cust-X', 'utf8').digest('hex');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(stateDir, 'users', `${key}.json`), '{not json');
    await assert.rejects(reserve('cust-X', 'sms', t0));
  });
});

function runChild(body, stateDir) {
  const code = `import { reserve } from ${JSON.stringify(MODULE_URL)};\n${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, STATE_DIR: stateDir },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (status) => {
      if (status !== 0) reject(new Error(`child failed: ${err}`));
      else resolve(out.trim());
    });
  });
}
