import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reserve, release } from "./bot.mjs";

const BOT_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "bot.mjs")).href;
const H = 3_600_000;
const MIN = 60_000;
const T0 = new Date("2026-10-22T09:00:00Z");

let stateDir;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "bot-test-"));
  process.env.STATE_DIR = stateDir;
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const req = (over = {}) => ({ userId: "lead_204", maxPerWindow: 3, windowHours: 24, minGapMinutes: 0, ...over });
const at = (ms) => new Date(T0.getTime() + ms);

test("caps sends per window", async () => {
  for (let i = 0; i < 3; i++) {
    assert.equal((await reserve(req(), at(i * MIN))).allowed, true);
  }
  const fourth = await reserve(req(), at(10 * MIN));
  assert.deepEqual(fourth, { allowed: false, reason: "max_per_window_reached", reservationId: null });
});

test("enforces minimum gap from the last live send", async () => {
  const first = await reserve(req({ minGapMinutes: 90 }), at(0));
  assert.equal(first.allowed, true);
  assert.equal((await reserve(req({ minGapMinutes: 90 }), at(89 * MIN))).reason, "min_gap_not_elapsed");
  assert.equal((await reserve(req({ minGapMinutes: 90 }), at(90 * MIN))).allowed, true);
});

test("window slides: a send stops counting exactly windowHours later", async () => {
  const r = req({ maxPerWindow: 2, windowHours: 24 });
  assert.equal((await reserve(r, at(0))).allowed, true);
  assert.equal((await reserve(r, at(10 * H))).allowed, true);
  assert.equal((await reserve(r, at(20 * H))).reason, "max_per_window_reached");
  // The send at t0 is 24h old now, so it no longer counts.
  assert.equal((await reserve(r, at(24 * H))).allowed, true);
});

test("per-call limits apply to the same lead", async () => {
  assert.equal((await reserve(req({ maxPerWindow: 1 }), at(0))).allowed, true);
  assert.equal((await reserve(req({ maxPerWindow: 5 }), at(MIN))).allowed, true);
});

test("leads are independent", async () => {
  assert.equal((await reserve(req({ maxPerWindow: 1 }), at(0))).allowed, true);
  assert.equal((await reserve(req({ userId: "lead_999", maxPerWindow: 1 }), at(0))).allowed, true);
});

test("release frees the slot and is idempotent", async () => {
  const r = req({ maxPerWindow: 1, minGapMinutes: 90 });
  const first = await reserve(r, at(0));
  assert.equal((await reserve(r, at(MIN))).allowed, false);
  await release(first.reservationId);
  await release(first.reservationId); // second release is a no-op
  // Released send no longer counts toward the cap or the gap.
  assert.equal((await reserve(r, at(2 * MIN))).allowed, true);
});

test("released slot does not hold the gap open", async () => {
  const r = req({ maxPerWindow: 5, minGapMinutes: 90 });
  const first = await reserve(r, at(0));
  await release(first.reservationId);
  assert.equal((await reserve(r, at(MIN))).allowed, true);
});

test("state survives a fresh module instance (worker restart)", async () => {
  const r = req({ maxPerWindow: 1 });
  assert.equal((await reserve(r, at(0))).allowed, true);
  const fresh = await import(`${BOT_URL}?restart=1`);
  assert.equal((await fresh.reserve(r, at(MIN))).reason, "max_per_window_reached");
});

test("concurrent calls in one process never exceed the cap", async () => {
  const results = await Promise.all(Array.from({ length: 25 }, () => reserve(req(), at(0))));
  assert.equal(results.filter((x) => x.allowed).length, 3);
});

test("malformed input throws; corrupt state is not silently reset", async () => {
  await assert.rejects(reserve(req({ maxPerWindow: 0 }), at(0)), TypeError);
  await assert.rejects(reserve(req(), new Date("nope")), TypeError);
  await assert.rejects(release("not-a-reservation"), TypeError);
  await reserve(req(), at(0));
  const { readdir, writeFile } = await import("node:fs/promises");
  const [leadFile] = (await readdir(path.join(stateDir, "leads"))).filter((f) => f.endsWith(".json"));
  await writeFile(path.join(stateDir, "leads", leadFile), "{not json");
  await assert.rejects(reserve(req(), at(MIN)));
});

function runChild(script, env) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
  });
}

test("concurrent processes share one budget", async () => {
  const script = `
    const { reserve } = await import(${JSON.stringify(BOT_URL)});
    const r = await reserve({ userId: "lead_204", maxPerWindow: 3, windowHours: 24, minGapMinutes: 0 }, new Date(${T0.getTime()}));
    console.log(JSON.stringify(r));`;
  const outs = await Promise.all(Array.from({ length: 12 }, () => runChild(script, { STATE_DIR: stateDir })));
  const allowed = outs.map((o) => JSON.parse(o)).filter((r) => r.allowed);
  assert.equal(allowed.length, 3);
});

test("a different process can release a reservation", async () => {
  const r = req({ maxPerWindow: 1 });
  const first = await reserve(r, at(0));
  assert.equal((await reserve(r, at(MIN))).allowed, false);
  await runChild(`
    const { release } = await import(${JSON.stringify(BOT_URL)});
    await release(${JSON.stringify(first.reservationId)});`, { STATE_DIR: stateDir });
  assert.equal((await reserve(r, at(2 * MIN))).allowed, true);
});

test("STATE_DIR is required", async () => {
  delete process.env.STATE_DIR;
  await assert.rejects(reserve(req(), at(0)), /STATE_DIR/);
  process.env.STATE_DIR = stateDir;
});
