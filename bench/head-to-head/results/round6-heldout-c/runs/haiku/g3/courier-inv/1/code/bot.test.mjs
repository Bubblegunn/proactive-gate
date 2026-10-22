import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const botUrl = new URL("./bot.mjs", import.meta.url).href;

async function freshDir() {
  const base = await mkdtemp(join(tmpdir(), "bot-test-"));
  return join(base, "state", "nested"); // does not exist yet
}

test("unsubscribe blocks marketing, not receipts", async () => {
  process.env.STATE_DIR = await freshDir();
  const bot = await import(`${botUrl}?a`);
  const now = new Date();

  assert.equal((await bot.mayEmail("a@example.com", "marketing", now)).allowed, true);
  await bot.unsubscribe("a@example.com");

  const m = await bot.mayEmail("a@example.com", "marketing", now);
  assert.equal(m.allowed, false);
  assert.match(m.reason, /unsubscribed from marketing/);

  const r = await bot.mayEmail("a@example.com", "receipt", now);
  assert.equal(r.allowed, true);
});

test("addresses are normalized (case and stray spaces)", async () => {
  process.env.STATE_DIR = await freshDir();
  const bot = await import(`${botUrl}?b`);
  const now = new Date();
  await bot.unsubscribe("  Bob@Example.COM ");
  assert.equal((await bot.mayEmail("bob@example.com", "marketing", now)).allowed, false);
  assert.equal((await bot.mayEmail("\tBOB@example.com\n", "marketing", now)).allowed, false);
});

test("resubscribe re-allows marketing; latest event wins", async () => {
  process.env.STATE_DIR = await freshDir();
  const bot = await import(`${botUrl}?c`);
  const now = new Date();
  await bot.unsubscribe("c@example.com");
  await bot.resubscribe("c@example.com");
  assert.equal((await bot.mayEmail("c@example.com", "marketing", now)).allowed, true);
  await bot.unsubscribe("c@example.com");
  assert.equal((await bot.mayEmail("c@example.com", "marketing", now)).allowed, false);
});

test("invalid input fails closed with a reason", async () => {
  process.env.STATE_DIR = await freshDir();
  const bot = await import(`${botUrl}?d`);
  const now = new Date();
  for (const bad of ["", "no-at-sign", "@x.com", "a@", undefined, 42]) {
    const res = await bot.mayEmail(bad, "marketing", now);
    assert.equal(res.allowed, false, `expected deny for ${JSON.stringify(bad)}`);
    assert.ok(res.reason.length > 0);
  }
  const unknown = await bot.mayEmail("ok@example.com", "sms", now);
  assert.equal(unknown.allowed, false);
  await assert.rejects(bot.mayEmail("ok@example.com", "marketing", "not a date"), TypeError);
  await assert.rejects(bot.unsubscribe("nope"), TypeError);
});

test("throws when STATE_DIR is unset", async () => {
  delete process.env.STATE_DIR;
  const bot = await import(`${botUrl}?e`);
  await assert.rejects(bot.unsubscribe("x@example.com"), /STATE_DIR/);
});

test("state survives a restart (fresh process sees earlier writes)", async () => {
  const dir = await freshDir();
  process.env.STATE_DIR = dir;
  const bot = await import(`${botUrl}?f`);
  await bot.unsubscribe("persist@example.com");

  const script = `
    import { mayEmail } from ${JSON.stringify(botUrl)};
    const r = await mayEmail("persist@example.com", "marketing", new Date());
    process.stdout.write(JSON.stringify(r));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, STATE_DIR: dir },
  });
  assert.equal(JSON.parse(stdout).allowed, false);
});

test("a partial trailing line is ignored until completed", async () => {
  const dir = await freshDir();
  process.env.STATE_DIR = dir;
  const bot = await import(`${botUrl}?g`);
  await bot.unsubscribe("partial@example.com");
  // Simulate another worker mid-write: no newline yet.
  await appendFile(join(dir, "suppression.log"), '{"v":1,"op":"resubscribe","email":"partial@example.com"');
  assert.equal((await bot.mayEmail("partial@example.com", "marketing", new Date())).allowed, false);
});

test("concurrent writers from several processes lose no unsubscribes", async () => {
  const dir = await freshDir();
  const procs = 8;
  const perProc = 50;
  const script = (p) =>
    `import { unsubscribe } from ${JSON.stringify(botUrl)};` +
    `for (let i = 0; i < ${perProc}; i++) await unsubscribe("p${p}-" + i + "@Example.com");`;
  await Promise.all(
    Array.from({ length: procs }, (_, p) =>
      run(process.execPath, ["--input-type=module", "-e", script(p)], {
        env: { ...process.env, STATE_DIR: dir },
      }),
    ),
  );

  const log = await readFile(join(dir, "suppression.log"), "utf8");
  const lines = log.split("\n").filter(Boolean);
  assert.equal(lines.length, procs * perProc);
  for (const line of lines) JSON.parse(line); // every line intact

  process.env.STATE_DIR = dir;
  const bot = await import(`${botUrl}?h`);
  for (let p = 0; p < procs; p++) {
    for (let i = 0; i < perProc; i++) {
      const res = await bot.mayEmail(`p${p}-${i}@example.com`, "marketing", new Date());
      assert.equal(res.allowed, false, `p${p}-${i} should be unsubscribed`);
    }
  }
});
