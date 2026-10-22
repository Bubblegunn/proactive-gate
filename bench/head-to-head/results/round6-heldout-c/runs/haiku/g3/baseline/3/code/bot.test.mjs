import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const botUrl = pathToFileURL(path.join(here, 'bot.mjs')).href;

async function useStateDir(t) {
  const base = await mkdtemp(path.join(tmpdir(), 'bot-test-'));
  const dir = path.join(base, 'state');
  process.env.STATE_DIR = dir;
  t.after(() => rm(base, { recursive: true, force: true }));
  return dir;
}

// Imports bot.mjs in a fresh process, the way a restarted worker would.
async function childCall(stateDir, code) {
  const script = `const m = await import(${JSON.stringify(botUrl)}); ${code}`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, STATE_DIR: stateDir },
  });
  return stdout;
}

test('unsubscribe blocks marketing but not receipts, whatever the address spelling', async (t) => {
  await useStateDir(t);
  const { unsubscribe, mayEmail } = await import(botUrl + '?a');
  const now = new Date();

  assert.equal((await mayEmail('Ann@Shop.example', 'marketing', now)).allowed, true);
  await unsubscribe('  Ann@Shop.example ');

  const m = await mayEmail('ann@shop.EXAMPLE', 'marketing', now);
  assert.equal(m.allowed, false);
  assert.match(m.reason, /unsubscribed from marketing/);

  const r = await mayEmail('ann@shop.example', 'receipt', now);
  assert.equal(r.allowed, true);
});

test('resubscribe clears the block; a later unsubscribe sets it again', async (t) => {
  await useStateDir(t);
  const { unsubscribe, resubscribe, mayEmail } = await import(botUrl + '?b');
  const now = new Date();

  await unsubscribe('bo@shop.example');
  await resubscribe('bo@shop.example');
  assert.equal((await mayEmail('bo@shop.example', 'marketing', now)).allowed, true);

  await unsubscribe('bo@shop.example');
  assert.equal((await mayEmail('bo@shop.example', 'marketing', now)).allowed, false);
});

test('resubscribe without a prior unsubscribe leaves marketing allowed', async (t) => {
  await useStateDir(t);
  const { resubscribe, mayEmail } = await import(botUrl + '?c');
  await resubscribe('cy@shop.example');
  assert.equal((await mayEmail('cy@shop.example', 'marketing', new Date())).allowed, true);
});

test('malformed address is refused, not thrown; bad arguments throw', async (t) => {
  await useStateDir(t);
  const { unsubscribe, resubscribe, mayEmail } = await import(botUrl + '?d');
  const now = new Date();

  const bad = await mayEmail('no-at-sign', 'receipt', now);
  assert.equal(bad.allowed, false);
  assert.equal(typeof bad.reason, 'string');
  assert.equal((await mayEmail(undefined, 'marketing', now)).allowed, false);

  await assert.rejects(unsubscribe('nope'), TypeError);
  await assert.rejects(resubscribe(42), TypeError);
  await assert.rejects(mayEmail('a@b.example', 'sms', now), TypeError);
  await assert.rejects(mayEmail('a@b.example', 'marketing', 'today'), TypeError);
  await assert.rejects(mayEmail('a@b.example', 'marketing', new Date('x')), TypeError);
});

test('creates a missing STATE_DIR; unset STATE_DIR throws', async (t) => {
  const dir = await useStateDir(t);
  const { unsubscribe } = await import(botUrl + '?e');
  await unsubscribe('dee@shop.example');
  assert.ok((await readdir(path.join(dir, 'suppression'))).length === 1);

  delete process.env.STATE_DIR;
  await assert.rejects(unsubscribe('dee@shop.example'), /STATE_DIR/);
});

test('state survives a restart and is visible to a new process', async (t) => {
  const dir = await useStateDir(t);
  const { unsubscribe } = await import(botUrl + '?f');
  await unsubscribe('eve@shop.example');

  const out = await childCall(
    dir,
    `console.log(JSON.stringify(await m.mayEmail('EVE@shop.example', 'marketing', new Date())));`,
  );
  const res = JSON.parse(out);
  assert.equal(res.allowed, false);
});

test('concurrent unsubscribes from many processes are all recorded', async (t) => {
  const dir = await useStateDir(t);
  const email = 'race@shop.example';
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, () => childCall(dir, `await m.unsubscribe(${JSON.stringify(email)});`)),
  );

  const events = (await readdir(path.join(dir, 'suppression'), { recursive: true })).filter((f) =>
    f.endsWith('-unsubscribe.json'),
  );
  assert.equal(events.length, N);

  const { mayEmail } = await import(botUrl + '?g');
  assert.equal((await mayEmail(email, 'marketing', new Date())).allowed, false);
});

test('an interrupted write (leftover temp file) is ignored', async (t) => {
  const dir = await useStateDir(t);
  const { unsubscribe, mayEmail } = await import(botUrl + '?h');
  await unsubscribe('fay@shop.example');

  // Find the per-address directory and drop a stray temp file into it.
  const [sub] = await readdir(path.join(dir, 'suppression'));
  await mkdir(path.join(dir, 'suppression', sub), { recursive: true });
  await writeFile(path.join(dir, 'suppression', sub, '.tmp-crashed'), '{"partial');

  assert.equal((await mayEmail('fay@shop.example', 'marketing', new Date())).allowed, false);
});
