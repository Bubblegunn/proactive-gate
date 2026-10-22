import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(path.join(here, 'bot.mjs')).href;
const now = new Date('2026-10-23T12:00:00Z');

async function freshState() {
  const dir = await mkdtemp(path.join(tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = path.join(dir, 'state'); // directory does not exist yet
  return process.env.STATE_DIR;
}

// Runs one bot call in a separate Node process, as a separate worker would.
function runWorker(stateDir, script) {
  return new Promise((resolve, reject) => {
    const code = `import * as bot from ${JSON.stringify(botUrl)}; ${script}`;
    execFile(process.execPath, ['--input-type=module', '-e', code],
      { env: { ...process.env, STATE_DIR: stateDir } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)));
  });
}

test('new address has no marketing opt-in; receipts still allowed', async () => {
  await freshState();
  const { mayEmail } = await import(botUrl);
  const m = await mayEmail('new@example.com', 'marketing', now);
  assert.equal(m.allowed, false);
  assert.match(m.reason, /no recorded opt-in/);
  const r = await mayEmail('new@example.com', 'receipt', now);
  assert.equal(r.allowed, true);
});

test('opt-in, unsubscribe, resubscribe cycle for marketing', async () => {
  await freshState();
  const { mayEmail, resubscribe, unsubscribe } = await import(botUrl);
  await resubscribe('Cycle@Example.com');
  assert.equal((await mayEmail('cycle@example.com', 'marketing', now)).allowed, true);
  await unsubscribe('cycle@example.com');
  const off = await mayEmail('cycle@example.com', 'marketing', now);
  assert.equal(off.allowed, false);
  assert.match(off.reason, /unsubscribed/);
  assert.equal((await mayEmail('cycle@example.com', 'receipt', now)).allowed, true);
  await resubscribe('cycle@example.com');
  assert.equal((await mayEmail('cycle@example.com', 'marketing', now)).allowed, true);
});

test('normalization: case, spaces, zero-width characters', async () => {
  await freshState();
  const { mayEmail, resubscribe, unsubscribe } = await import(botUrl);
  await resubscribe('  Mixed.Case@Example.COM​ ');
  assert.equal((await mayEmail('mixed.case@example.com', 'marketing', now)).allowed, true);
  await unsubscribe('\tMIXED.CASE@example.com ');
  assert.equal((await mayEmail(' mixed.case@EXAMPLE.com', 'marketing', now)).allowed, false);
});

test('plus-tags and dots are different addresses', async () => {
  await freshState();
  const { mayEmail, resubscribe, unsubscribe } = await import(botUrl);
  await resubscribe('a+news@example.com');
  await unsubscribe('a+news@example.com');
  assert.equal((await mayEmail('a@example.com', 'marketing', now)).allowed, false);
  assert.equal((await mayEmail('a+news@example.com', 'marketing', now)).allowed, false);
});

test('invalid address is denied with a reason, not thrown', async () => {
  await freshState();
  const { mayEmail, unsubscribe } = await import(botUrl);
  for (const kind of ['marketing', 'receipt']) {
    const res = await mayEmail('not an email', kind, now);
    assert.equal(res.allowed, false);
    assert.match(res.reason, /not a valid email/);
  }
  await assert.rejects(unsubscribe('not an email'), TypeError);
});

test('bad kind or now is rejected', async () => {
  await freshState();
  const { mayEmail } = await import(botUrl);
  await assert.rejects(mayEmail('a@example.com', 'promo', now), TypeError);
  await assert.rejects(mayEmail('a@example.com', 'marketing', new Date('x')), TypeError);
});

test('missing STATE_DIR rejects so the worker does not send', async () => {
  const saved = process.env.STATE_DIR;
  delete process.env.STATE_DIR;
  try {
    const { mayEmail } = await import(botUrl);
    await assert.rejects(mayEmail('a@example.com', 'marketing', now), /STATE_DIR/);
  } finally {
    process.env.STATE_DIR = saved;
  }
});

test('many workers unsubscribing in the same second are all recorded', async () => {
  const stateDir = await freshState();
  await runWorker(stateDir, "await bot.resubscribe('crowd@example.com');");
  const N = 24;
  await Promise.all(Array.from({ length: N }, () =>
    runWorker(stateDir, "await bot.unsubscribe('crowd@example.com');")));
  const out = await runWorker(stateDir,
    "console.log(JSON.stringify(await bot.mayEmail('crowd@example.com', 'marketing', new Date())));");
  assert.equal(JSON.parse(out).allowed, false);
  // Every unsubscribe must be a separate complete line in the log.
  const [file] = (await readdir(path.join(stateDir, 'subs'))).map((f) => path.join(stateDir, 'subs', f));
  const { readFile } = await import('node:fs/promises');
  const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.filter((l) => l.event === 'unsubscribe').length, N);
});

test('a fresh worker process sees earlier records', async () => {
  const stateDir = await freshState();
  await runWorker(stateDir, "await bot.resubscribe('later@example.com'); await bot.unsubscribe('later@example.com');");
  const out = await runWorker(stateDir,
    "console.log(JSON.stringify(await bot.mayEmail('LATER@example.com', 'marketing', new Date())));");
  assert.equal(JSON.parse(out).allowed, false);
});

test('a torn line from a killed writer does not hide the next record', async () => {
  const stateDir = await freshState();
  await runWorker(stateDir, "await bot.resubscribe('torn@example.com');");
  const [file] = (await readdir(path.join(stateDir, 'subs'))).map((f) => path.join(stateDir, 'subs', f));
  // Simulate a writer killed mid-write: partial JSON with no newline.
  await appendFile(file, '{"email":"torn@example.com","event":"unsub');
  await runWorker(stateDir, "await bot.unsubscribe('torn@example.com');");
  const out = await runWorker(stateDir,
    "console.log(JSON.stringify(await bot.mayEmail('torn@example.com', 'marketing', new Date())));");
  assert.equal(JSON.parse(out).allowed, false);
});
