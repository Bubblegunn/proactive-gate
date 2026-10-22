import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { recordUnsubscribe, recordResubscribe, mayEmail } from './bot.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const marketing = (to) => ({ to, kind: 'marketing' });
const transactional = (to) => ({ to, kind: 'transactional' });
const NOW = new Date('2026-10-22T12:00:00Z');
const d = (s) => new Date(s);

let stateDir;
let savedStateDir;

beforeEach(async () => {
  savedStateDir = process.env.STATE_DIR;
  stateDir = await mkdtemp(join(tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = stateDir;
});

afterEach(async () => {
  if (savedStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = savedStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

test('unsubscribed person gets no marketing but still gets transactional mail', async () => {
  await recordUnsubscribe('jane@example.com', d('2026-10-01T00:00:00Z'));
  assert.deepEqual(await mayEmail(marketing('jane@example.com'), NOW), {
    allowed: false,
    reason: 'unsubscribed',
  });
  assert.deepEqual(await mayEmail(transactional('jane@example.com'), NOW), {
    allowed: true,
    reason: null,
  });
});

test('a person who never unsubscribed can receive marketing', async () => {
  assert.deepEqual(await mayEmail(marketing('nobody@example.com'), NOW), {
    allowed: true,
    reason: null,
  });
});

test('resubscribe after unsubscribe re-enables marketing', async () => {
  await recordUnsubscribe('a@example.com', d('2026-10-01T00:00:00Z'));
  await recordResubscribe('a@example.com', d('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).allowed, true);
});

test('a later unsubscribe overrides an earlier resubscribe', async () => {
  await recordResubscribe('a@example.com', d('2026-10-01T00:00:00Z'));
  await recordUnsubscribe('a@example.com', d('2026-10-05T00:00:00Z'));
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).reason, 'unsubscribed');
});

test('out of order: a late-arriving unsubscribe older than a resubscribe does not suppress', async () => {
  await recordResubscribe('a@example.com', d('2026-10-05T00:00:00Z'));
  await recordUnsubscribe('a@example.com', d('2026-10-01T00:00:00Z')); // arrives late
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).allowed, true);
});

test('out of order: a late-arriving unsubscribe newer than a resubscribe suppresses', async () => {
  await recordUnsubscribe('a@example.com', d('2026-10-09T00:00:00Z'));
  await recordResubscribe('a@example.com', d('2026-10-05T00:00:00Z')); // arrives late
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).reason, 'unsubscribed');
});

test('same timestamp for unsubscribe and resubscribe: treated as unsubscribed', async () => {
  const t = d('2026-10-05T00:00:00Z');
  await recordResubscribe('a@example.com', t);
  await recordUnsubscribe('a@example.com', t);
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).reason, 'unsubscribed');
});

test('addresses are matched across case, display names, plus-tags and Gmail dots', async () => {
  await recordUnsubscribe('"Jane Doe" <<EMAIL>>', d('2026-10-01T00:00:00Z'));
  assert.equal((await mayEmail(marketing('<EMAIL>'), NOW)).reason, 'unsubscribed');
  assert.equal((await mayEmail(marketing('<EMAIL>'), NOW)).reason, 'unsubscribed');
  assert.equal((await mayEmail(marketing('<EMAIL>'), NOW)).reason, 'unsubscribed');
  // Non-Gmail dots are significant, so a different address is not affected.
  assert.equal((await mayEmail(marketing('j.ane@example.com'), NOW)).allowed, true);
});

test('invalid recipient is denied for both kinds', async () => {
  for (const kind of ['marketing', 'transactional']) {
    assert.deepEqual(await mayEmail({ to: 'not-an-address', kind }, NOW), {
      allowed: false,
      reason: 'invalid_recipient',
    });
  }
});

test('unknown kind is denied', async () => {
  assert.equal((await mayEmail({ to: 'a@example.com', kind: 'promo' }, NOW)).reason, 'unknown_kind');
});

test('invalid Date arguments throw', async () => {
  await assert.rejects(recordUnsubscribe('a@example.com', 'yesterday'), TypeError);
  await assert.rejects(mayEmail(marketing('a@example.com'), null), TypeError);
});

test('missing STATE_DIR throws instead of falling back to local state', async () => {
  delete process.env.STATE_DIR;
  await assert.rejects(recordUnsubscribe('a@example.com', NOW));
  await assert.rejects(mayEmail(marketing('a@example.com'), NOW));
});

test('a torn line from a crashed writer does not hide the next event', async () => {
  await recordUnsubscribe('a@example.com', d('2026-10-01T00:00:00Z'));
  const dir = join(stateDir, 'suppression');
  const [file] = await readdir(dir);
  await appendFile(join(dir, file), '\n{"id":"x","kind":"unsub'); // crash mid-write
  await recordUnsubscribe('a@example.com', d('2026-10-02T00:00:00Z'));
  assert.equal((await mayEmail(marketing('a@example.com'), NOW)).reason, 'unsubscribed');
});

test('state survives a restart: a fresh process sees the unsubscribe', async () => {
  await recordUnsubscribe('a@example.com', d('2026-10-01T00:00:00Z'));
  const script = `
    import { mayEmail } from ${JSON.stringify(join(here, 'bot.mjs'))};
    const r = await mayEmail({ to: 'a@example.com', kind: 'marketing' }, new Date());
    process.stdout.write(JSON.stringify(r));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STATE_DIR: stateDir },
  });
  assert.deepEqual(JSON.parse(stdout), { allowed: false, reason: 'unsubscribed' });
});

test('concurrent workers in separate processes: every event is kept', async () => {
  const N = 20;
  const script = `
    import { recordUnsubscribe, recordResubscribe } from ${JSON.stringify(join(here, 'bot.mjs'))};
    const i = Number(process.argv[1]);
    const at = new Date(Date.UTC(2026, 9, 1, 0, 0, i));
    if (i % 2 === 0) await recordUnsubscribe('race@example.com', at);
    else await recordResubscribe('race@example.com', at);`;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      run(process.execPath, ['--input-type=module', '-e', script, String(i)], {
        env: { ...process.env, STATE_DIR: stateDir },
      }),
    ),
  );
  const dir = join(stateDir, 'suppression');
  const [file] = await readdir(dir);
  const lines = (await readFile(join(dir, file), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, N);
  // Unsubscribes are at even seconds 0..18; the latest is 18. Resubscribes are odd, latest 19.
  // Resubscribe at :19 is later, so the person is resubscribed.
  assert.equal((await mayEmail(marketing('race@example.com'), NOW)).allowed, true);
});
