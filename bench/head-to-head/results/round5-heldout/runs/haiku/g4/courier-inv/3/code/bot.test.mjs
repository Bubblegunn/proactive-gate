import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reserve, release } from "./bot.mjs";

const execFileAsync = promisify(execFile);
const BOT_URL = new URL("./bot.mjs", import.meta.url).href;
const T0 = new Date("2026-10-22T10:00:00Z");
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

let stateDir;
const previousStateDir = process.env.STATE_DIR;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "bot-state-"));
  process.env.STATE_DIR = stateDir;
});

afterEach(async () => {
  if (previousStateDir === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = previousStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

const req = (overrides = {}) => ({
  userId: "lead_204",
  maxPerWindow: 3,
  windowHours: 24,
  minGapMinutes: 0,
  ...overrides,
});

test("allows up to maxPerWindow and then reports window_limit_reached", async () => {
  for (let i = 0; i < 3; i++) {
    const r = await reserve(req(), new Date(T0.getTime() + i * MIN));
    assert.equal(r.allowed, true);
    assert.equal(typeof r.reservationId, "string");
  }
  const denied = await reserve(req(), new Date(T0.getTime() + 10 * MIN));
  assert.deepEqual(denied, { allowed: false, reason: "window_limit_reached", reservationId: null });
});

test("window is rolling: a send stops counting exactly windowHours later", async () => {
  await reserve(req({ maxPerWindow: 1 }), T0);
  const still = await reserve(req({ maxPerWindow: 1 }), new Date(T0.getTime() + 24 * HOUR - 1));
  assert.equal(still.reason, "window_limit_reached");
  const later = await reserve(req({ maxPerWindow: 1 }), new Date(T0.getTime() + 24 * HOUR));
  assert.equal(later.allowed, true);
});

test("min gap is enforced from the last counted send", async () => {
  const gap = req({ maxPerWindow: 10, minGapMinutes: 90 });
  assert.equal((await reserve(gap, T0)).allowed, true);
  const early = await reserve(gap, new Date(T0.getTime() + 89 * MIN));
  assert.deepEqual(early, { allowed: false, reason: "min_gap_not_elapsed", reservationId: null });
  assert.equal((await reserve(gap, new Date(T0.getTime() + 90 * MIN))).allowed, true);
});

test("when both limits trip, the window limit is reported", async () => {
  await reserve(req({ maxPerWindow: 1, minGapMinutes: 90 }), T0);
  const r = await reserve(req({ maxPerWindow: 1, minGapMinutes: 90 }), new Date(T0.getTime() + MIN));
  assert.equal(r.reason, "window_limit_reached");
});

test("limits come from each call and different leads do not share counts", async () => {
  assert.equal((await reserve(req({ maxPerWindow: 1 }), T0)).allowed, true);
  assert.equal((await reserve(req({ maxPerWindow: 1, userId: "lead_999" }), T0)).allowed, true);
  assert.equal((await reserve(req({ maxPerWindow: 2 }), T0)).allowed, true);
});

test("release frees the slot and the gap is measured from the previous send", async () => {
  const gap = req({ maxPerWindow: 1, minGapMinutes: 90 });
  const first = await reserve(gap, T0);
  assert.equal(await release(first.reservationId), true);
  // Nothing was delivered, so neither the window nor the gap should hold.
  assert.equal((await reserve(gap, new Date(T0.getTime() + MIN))).allowed, true);
});

test("release is idempotent", async () => {
  const r = await reserve(req(), T0);
  assert.equal(await release(r.reservationId), true);
  assert.equal(await release(r.reservationId), false);
});

test("release works from a different process than the one that reserved", async () => {
  const r = await reserve(req({ maxPerWindow: 1 }), T0);
  const script = `
    import { release } from ${JSON.stringify(BOT_URL)};
    console.log(JSON.stringify(await release(${JSON.stringify(r.reservationId)})));`;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, STATE_DIR: stateDir },
  });
  assert.equal(JSON.parse(stdout), true);
  assert.equal((await reserve(req({ maxPerWindow: 1 }), T0)).allowed, true);
});

test("history survives a restart: a fresh process sees the earlier sends", async () => {
  const script = `
    import { reserve } from ${JSON.stringify(BOT_URL)};
    const r = await reserve({ userId: "lead_204", maxPerWindow: 1, windowHours: 24, minGapMinutes: 0 }, new Date(${JSON.stringify(T0.toISOString())}));
    console.log(JSON.stringify(r.allowed));`;
  const run = () =>
    execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, STATE_DIR: stateDir },
    });
  assert.equal(JSON.parse((await run()).stdout), true);
  assert.equal(JSON.parse((await run()).stdout), false);
  const files = await readdir(join(stateDir, "leads"));
  assert.equal(files.length, 1);
});

test("concurrent workers never exceed maxPerWindow", async () => {
  const script = `
    import { reserve } from ${JSON.stringify(BOT_URL)};
    const at = new Date(${JSON.stringify(T0.toISOString())});
    let allowed = 0;
    await Promise.all(Array.from({ length: 10 }, () =>
      reserve({ userId: "lead_race", maxPerWindow: 3, windowHours: 24, minGapMinutes: 0 }, at)
        .then((r) => { if (r.allowed) allowed++; })));
    console.log(String(allowed));`;
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, STATE_DIR: stateDir },
      }),
    ),
  );
  const total = results.reduce((sum, r) => sum + Number(r.stdout.trim()), 0);
  assert.equal(total, 3);
});

test("a corrupt history file is an error, not a silent reset", async () => {
  const r = await reserve(req(), T0);
  assert.equal(r.allowed, true);
  const [file] = await readdir(join(stateDir, "leads"));
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(stateDir, "leads", file), "{not json");
  await assert.rejects(reserve(req(), T0), SyntaxError);
});

test("invalid input throws", async () => {
  await assert.rejects(reserve(req({ userId: "" }), T0), TypeError);
  await assert.rejects(reserve(req({ maxPerWindow: -1 }), T0), TypeError);
  await assert.rejects(reserve(req({ windowHours: 0 }), T0), TypeError);
  await assert.rejects(reserve(req(), "2026-10-22"), TypeError);
  await assert.rejects(release("nope"), TypeError);
});

test("missing STATE_DIR is an error", async () => {
  delete process.env.STATE_DIR;
  await assert.rejects(reserve(req(), T0), /STATE_DIR is not set/);
});
