import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(join(here, '..', 'bot.mjs')).href;
const { unsubscribe, resubscribe, mayEmail } = await import(botUrl);

const NOW = new Date('2026-10-23T12:00:00Z');

async function freshState() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-state-'));
  process.env.STATE_DIR = dir;
  return dir;
}

// Runs a separate Node process, the way a worker would, and resolves when it exits.
function runWorker(stateDir, code) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--input-type=module', '-e', `const m = await import(${JSON.stringify(botUrl)}); ${code}`],
      { env: { ...process.env, STATE_DIR: stateDir } },
      (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
    );
    child.on('error', reject);
  });
}

test('unsubscribe blocks marketing but not receipts', async () => {
  await freshState();
  await unsubscribe('buyer@example.com');
  const marketing = await mayEmail('buyer@example.com', 'marketing', NOW);
  assert.equal(marketing.allowed, false);
  assert.match(marketing.reason, /unsubscribed from marketing/);
  const receipt = await mayEmail('buyer@example.com', 'receipt', NOW);
  assert.equal(receipt.allowed, true);
});

test('addresses match regardless of case and stray spaces', async () => {
  await freshState();
  await unsubscribe('  Buyer@Example.COM ');
  assert.equal((await mayEmail('buyer@example.com', 'marketing', NOW)).allowed, false);
  assert.equal((await mayEmail('\tBUYER@example.com\n', 'marketing', NOW)).allowed, false);
});

test('resubscribe clears the marketing block; a later unsubscribe blocks again', async () => {
  await freshState();
  await unsubscribe('a@example.com');
  await resubscribe('A@example.com');
  assert.equal((await mayEmail('a@example.com', 'marketing', NOW)).allowed, true);
  await unsubscribe('a@example.com');
  assert.equal((await mayEmail('a@example.com', 'marketing', NOW)).allowed, false);
});

test('unknown address with no record: marketing allowed, receipt allowed', async () => {
  await freshState();
  assert.equal((await mayEmail('new@example.com', 'marketing', NOW)).allowed, true);
  assert.equal((await mayEmail('new@example.com', 'receipt', NOW)).allowed, true);
});

test('invalid address and unknown kind are blocked with a reason', async () => {
  await freshState();
  const bad = await mayEmail('not-an-address', 'marketing', NOW);
  assert.equal(bad.allowed, false);
  assert.ok(bad.reason.length > 0);
  const kind = await mayEmail('ok@example.com', 'promo', NOW);
  assert.equal(kind.allowed, false);
  assert.ok(kind.reason.length > 0);
});

test('missing STATE_DIR and invalid now throw instead of allowing', async () => {
  const saved = process.env.STATE_DIR;
  delete process.env.STATE_DIR;
  await assert.rejects(mayEmail('a@example.com', 'marketing', NOW), /STATE_DIR/);
  await assert.rejects(unsubscribe('a@example.com'), /STATE_DIR/);
  process.env.STATE_DIR = saved;
  await freshState();
  await assert.rejects(mayEmail('a@example.com', 'marketing', new Date('nope')), TypeError);
});

test('state survives into a new process and is shared across workers', async () => {
  const dir = await freshState();
  await Promise.all(
    Array.from({ length: 6 }, () =>
      runWorker(dir, "for (let i = 0; i < 20; i++) await m.unsubscribe('Shared@Example.com');"),
    ),
  );
  // Fresh process sees the earlier workers' records.
  const out = await runWorker(
    dir,
    "console.log(JSON.stringify(await m.mayEmail('shared@example.com', 'marketing', new Date())));",
  );
  assert.equal(JSON.parse(out).allowed, false);

  const files = await readdir(join(dir, 'suppression'));
  assert.equal(files.length, 1);
  const lines = (await readFile(join(dir, 'suppression', files[0]), 'utf8'))
    .split('\n')
    .filter(Boolean);
  assert.equal(lines.length, 120);
  for (const line of lines) assert.equal(JSON.parse(line).event, 'unsubscribe');
});

test('a torn line left by a killed writer does not hide the next record', async () => {
  const dir = await freshState();
  await unsubscribe('torn@example.com');
  const [file] = await readdir(join(dir, 'suppression'));
  // Simulate a writer killed mid-record: partial JSON with no closing brace.
  await appendFile(join(dir, 'suppression', file), '\n{"at":"2026-10-23T11:');
  await resubscribe('torn@example.com');
  assert.equal((await mayEmail('torn@example.com', 'marketing', NOW)).allowed, true);
  await unsubscribe('torn@example.com');
  assert.equal((await mayEmail('torn@example.com', 'marketing', NOW)).allowed, false);
});

test('an unsubscribe is durable when the worker is killed right after it resolves', async () => {
  const dir = await freshState();
  await runWorker(dir, "await m.unsubscribe('killed@example.com'); process.kill(process.pid, 'SIGKILL');")
    .catch(() => {});
  assert.equal((await mayEmail('killed@example.com', 'marketing', NOW)).allowed, false);
});
