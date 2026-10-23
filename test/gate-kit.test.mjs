import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const KIT_PATH = join(here, "..", "skills", "proactive-gate", "references", "gate-kit.mjs");
const KIT_SOURCE = readFileSync(KIT_PATH, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "gate-kit-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const NY = "America/New_York";
const LON = "Europe/London";
const PHX = "America/Phoenix";
const KOL = "Asia/Kolkata";
const LH = "Australia/Lord_Howe";
const AKL = "Pacific/Auckland";
const SAO = "America/Sao_Paulo";

// Returns epoch ms for a UTC wall time; month is 1-based.
function utc(y, m, d, hh = 0, mm = 0) {
  return Date.UTC(y, m - 1, d, hh, mm);
}

let loads = 0;

// Writes a kit source (plus an export line) to the scratch dir and imports it; returns {kit, url, source}.
async function loadKit(source) {
  loads += 1;
  const names = [...source.matchAll(/^function (gk\w+)\(/gm)].map((m) => m[1]);
  const file = join(scratch, `kit-${loads}-${process.pid}.mjs`);
  writeFileSync(file, `${source}\nexport { ${names.join(", ")} };\n`);
  const url = pathToFileURL(file).href;
  return { kit: await import(url), url, source };
}

// Runs one child node process that imports the kit at url and prints JSON of the expression's value; killed after timeoutMs.
function runChild(url, expression, timeoutMs = 20000) {
  const script = `import * as kit from ${JSON.stringify(url)};
const result = ${expression};
process.stdout.write(JSON.stringify(result));
`;
  const file = join(scratch, `child-${loads}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(JSON.parse(out));
      else reject(new Error(`child exited ${code}: ${err}`));
    });
  });
}

// Registers every check on the given test function; the real kit uses node:test, mutants use a collector.
function runChecks(env, t) {
  const { kit, url, source } = env;

  t.test("source shape: no export, gk names, documented functions", () => {
    assert.equal(/^export\b/m.test(source), false, "no export keyword");
    const lines = source.split("\n");
    for (const m of source.matchAll(/^(?:async )?(?:function|const|let|var|class) (\w+)/gm)) {
      assert.ok(m[1].startsWith("gk"), `top-level name ${m[1]} must start with gk`);
    }
    for (const m of source.matchAll(/^import \* as (\w+) from /gm)) {
      assert.ok(m[1].startsWith("gk"), `import name ${m[1]} must start with gk`);
    }
    lines.forEach((line, i) => {
      const fn = /^function (\w+)\(/.exec(line);
      if (fn) assert.ok(i > 0 && lines[i - 1].startsWith("// "), `${fn[1]} needs a one-line comment above it`);
    });
  });

  t.test("zone validation", () => {
    assert.equal(kit.gkZoneOk(NY), true);
    assert.equal(kit.gkZoneOk(LON), true);
    assert.equal(kit.gkZoneOk("UTC"), true);
    for (const bad of ["UTC+2", "", null, undefined, "Nowhere/City", 5]) {
      assert.equal(kit.gkZoneOk(bad), false, `zone ${String(bad)} must be rejected`);
    }
  });

  t.test("local fields use a 24-hour clock with weekday and minutes", () => {
    const noon = kit.gkLocal(utc(2026, 3, 8, 12, 0), NY);
    assert.deepEqual(
      { y: noon.y, m: noon.m, d: noon.d, hh: noon.hh, mm: noon.mm, dow: noon.dow, minutes: noon.minutes, day: noon.day },
      { y: 2026, m: 3, d: 8, hh: 8, mm: 0, dow: 0, minutes: 480, day: "2026-03-08" },
    );
    const midnight = kit.gkLocal(utc(2026, 3, 8, 5, 0), NY);
    assert.equal(midnight.hh, 0, "local midnight is 00, never 24");
    assert.equal(midnight.minutes, 0);
    const kolkata = kit.gkLocal(utc(2026, 1, 15, 2, 30), KOL);
    assert.equal(kolkata.hh, 8);
    assert.equal(kolkata.mm, 0);
  });

  t.test("gkInstant: New York gap (23h day) and fold (25h day)", () => {
    assert.equal(kit.gkInstant(2026, 3, 8, 2, 30, NY), utc(2026, 3, 8, 7, 0), "gap gives 03:00 EDT");
    assert.equal(kit.gkInstant(2026, 11, 1, 1, 30, NY), utc(2026, 11, 1, 5, 30), "fold gives the earlier 01:30 EDT");
    assert.equal(kit.gkInstant(2026, 3, 8, 8, 0, NY), utc(2026, 3, 8, 12, 0));
  });

  t.test("gkInstant: London gap and fold, Lord Howe 30-minute gap, Auckland gap, fixed zones", () => {
    assert.equal(kit.gkInstant(2026, 3, 29, 1, 30, LON), utc(2026, 3, 29, 1, 0));
    assert.equal(kit.gkInstant(2026, 10, 25, 1, 30, LON), utc(2026, 10, 25, 0, 30));
    assert.equal(kit.gkInstant(2026, 10, 4, 2, 15, LH), utc(2026, 10, 3, 15, 30));
    assert.equal(kit.gkInstant(2026, 9, 27, 2, 30, AKL), utc(2026, 9, 26, 14, 0));
    assert.equal(kit.gkInstant(2026, 1, 15, 8, 0, KOL), utc(2026, 1, 15, 2, 30));
    assert.equal(kit.gkInstant(2026, 3, 8, 8, 0, PHX), utc(2026, 3, 8, 15, 0));
  });

  t.test("gkInstant round-trips through gkLocal for ordinary times", () => {
    const samples = [
      [NY, 2026, 7, 14, 9, 45],
      [LON, 2026, 12, 1, 23, 59],
      [KOL, 2026, 5, 5, 6, 0],
      [LH, 2026, 1, 20, 10, 30],
      [AKL, 2026, 6, 30, 17, 15],
    ];
    for (const [zone, y, m, d, hh, mm] of samples) {
      const local = kit.gkLocal(kit.gkInstant(y, m, d, hh, mm, zone), zone);
      assert.deepEqual([local.y, local.m, local.d, local.hh, local.mm], [y, m, d, hh, mm], zone);
    }
  });

  t.test("window edges: 07:59 / 08:00 / 20:59 / 21:00 on both NY DST days and in Phoenix", () => {
    const cases = [
      [NY, utc(2026, 3, 8, 11, 59), false],
      [NY, utc(2026, 3, 8, 12, 0), true],
      [NY, utc(2026, 3, 9, 0, 59), true],
      [NY, utc(2026, 3, 9, 1, 0), false],
      [NY, utc(2026, 11, 1, 12, 59), false],
      [NY, utc(2026, 11, 1, 13, 0), true],
      [NY, utc(2026, 11, 2, 1, 59), true],
      [NY, utc(2026, 11, 2, 2, 0), false],
      [PHX, utc(2026, 3, 8, 14, 59), false],
      [PHX, utc(2026, 3, 8, 15, 0), true],
      [PHX, utc(2026, 3, 9, 3, 59), true],
      [PHX, utc(2026, 3, 9, 4, 0), false],
    ];
    for (const [zone, t, expected] of cases) {
      assert.equal(kit.gkInWindow(t, zone, "08:00", "21:00"), expected, `${zone} ${new Date(t).toISOString()}`);
    }
  });

  t.test("wrapping quiet window 22:00-07:00 and the empty window", () => {
    assert.equal(kit.gkInWindow(utc(2026, 3, 9, 1, 59), NY, "22:00", "07:00"), false, "21:59 is outside");
    assert.equal(kit.gkInWindow(utc(2026, 3, 9, 2, 0), NY, "22:00", "07:00"), true, "22:00 is inside");
    assert.equal(kit.gkInWindow(utc(2026, 3, 8, 10, 59), NY, "22:00", "07:00"), true, "06:59 is inside");
    assert.equal(kit.gkInWindow(utc(2026, 3, 8, 11, 0), NY, "22:00", "07:00"), false, "07:00 is outside");
    assert.equal(kit.gkInWindow(utc(2026, 3, 8, 16, 0), NY, "08:00", "08:00"), false, "start === end is empty");
  });

  t.test("gkNextOpen: next opening, inside returns t, gap start, wrap, unreachable", () => {
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 2, 0), NY, "08:00", "21:00"), utc(2026, 3, 8, 12, 0), "from 21:00 EST on 03-07");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 7, 0), NY, "08:00", "21:00"), utc(2026, 3, 8, 12, 0), "from 03:00 EDT");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 12, 0), NY, "08:00", "21:00"), utc(2026, 3, 8, 12, 0), "already inside");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 5, 0), NY, "02:30", "04:00"), utc(2026, 3, 8, 7, 0), "window starts in the gap");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 7, 30), NY, "02:30", "04:00"), utc(2026, 3, 8, 7, 30), "inside the gap window");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 12, 0), NY, "22:00", "07:00"), utc(2026, 3, 9, 2, 0), "wrapping window");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 12, 0), NY, "08:00", "08:00"), null, "unreachable window");
    assert.equal(kit.gkNextOpen(utc(2026, 11, 1, 5, 0), NY, "01:30", "02:00"), utc(2026, 11, 1, 5, 30), "earlier 01:30 EDT opening");
    assert.equal(kit.gkNextOpen(utc(2026, 11, 1, 6, 0), NY, "01:30", "02:00"), utc(2026, 11, 1, 6, 30), "after the fold, the later 01:30 EST opening");
  });

  t.test("day, week and month keys", () => {
    assert.equal(kit.gkDayKey(utc(2026, 3, 8, 4, 30), NY), "2026-03-07", "local day, not UTC day");
    assert.equal(kit.gkMonthKey(utc(2026, 3, 8, 4, 30), NY), "2026-03");
    assert.equal(kit.gkWeekKey(utc(2026, 12, 31, 12, 0), "UTC"), "2026-W53");
    assert.equal(kit.gkWeekKey(utc(2027, 1, 1, 12, 0), "UTC"), "2026-W53");
    assert.equal(kit.gkWeekKey(utc(2027, 1, 4, 12, 0), "UTC"), "2027-W01");
    assert.equal(kit.gkWeekKey(utc(2026, 1, 4, 12, 0), "UTC"), "2026-W01", "Sunday ends the week");
    assert.equal(kit.gkWeekKey(utc(2026, 1, 5, 12, 0), "UTC"), "2026-W02", "Monday starts the week");
  });

  t.test("gkNextMidnight: 23h on spring-forward, 25h on fall-back, gap-midnight zones", () => {
    const springStart = utc(2026, 3, 8, 5, 0);
    assert.equal(kit.gkNextMidnight(springStart, NY) - springStart, 23 * 3600000);
    assert.equal(kit.gkNextMidnight(springStart, NY), utc(2026, 3, 9, 4, 0));
    const fallStart = utc(2026, 11, 1, 4, 0);
    assert.equal(kit.gkNextMidnight(fallStart, NY) - fallStart, 25 * 3600000);
    const londonStart = utc(2026, 3, 29, 0, 0);
    assert.equal(kit.gkNextMidnight(londonStart, LON) - londonStart, 23 * 3600000);
    assert.equal(kit.gkNextMidnight(utc(2026, 3, 8, 4, 30), NY), utc(2026, 3, 8, 5, 0), "23:30 EST rolls to 00:00 EST");
    assert.equal(kit.gkNextMidnight(utc(2018, 11, 3, 15, 0), SAO), utc(2018, 11, 4, 3, 0), "midnight does not exist in Sao Paulo 2018");
  });

  t.test("gkFmt: exact recipient text with no ISO date, UTC or GMT", () => {
    assert.equal(kit.gkFmt(utc(2026, 3, 14, 12, 0), NY), "08:00 on 14 Mar (America/New_York)");
    const london = kit.gkFmt(utc(2026, 3, 29, 12, 0), LON);
    assert.equal(london, "13:00 on 29 Mar (Europe/London)");
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(london), false, "no ISO date-time");
    assert.equal(/UTC|GMT/.test(london), false, "no UTC or GMT");
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(london), false, "no year-month-day");
  });

  t.test("gkNormalize trims, lower-cases and strips edge punctuation", () => {
    assert.equal(kit.gkNormalize("  Stop! "), "stop");
    assert.equal(kit.gkNormalize("OPT-OUT."), "opt-out");
    assert.equal(kit.gkNormalize("!! ! stop"), "stop");
    assert.equal(kit.gkNormalize("Hello,   World!!"), "hello, world");
    assert.equal(kit.gkNormalize(42), "");
  });

  t.test("gkIsStop matches the whole message only", () => {
    const stops = ["stop", "STOP", "  Stop! ", "stopall", "unsubscribe", "cancel", "end", "quit", "revoke", "opt out", "OPT OUT", "opt-out", "opt-out.", "optout"];
    for (const text of stops) assert.equal(kit.gkIsStop(text), true, JSON.stringify(text));
    const others = ["stopping", "please stop by tomorrow", "thanks", "", "end of story", "don't stop", "stop it now", "cancel my booking"];
    for (const text of others) assert.equal(kit.gkIsStop(text), false, JSON.stringify(text));
  });

  t.test("gkIsStart matches start and unstop only as the whole message", () => {
    assert.equal(kit.gkIsStart("start"), true);
    assert.equal(kit.gkIsStart("START!"), true);
    assert.equal(kit.gkIsStart("unstop"), true);
    for (const text of ["starting", "start me up please", "", "stop"]) {
      assert.equal(kit.gkIsStart(text), false, JSON.stringify(text));
    }
  });

  t.test("state: read, write, claim, unclaim, count and refund in one directory", () => {
    const dir = join(scratch, `state-${loads}-${Math.random().toString(36).slice(2)}`);
    assert.equal(kit.gkRead(dir, "a"), null, "missing key reads null");
    assert.equal(kit.gkWrite(dir, "a", { v: 1 }), true);
    assert.deepEqual(kit.gkRead(dir, "a"), { v: 1 });
    kit.gkWrite(dir, "a", { v: 2 });
    assert.deepEqual(kit.gkRead(dir, "a"), { v: 2 }, "overwrite replaces");
    assert.equal(kit.gkRead(dir, "b"), null, "keys are isolated");

    assert.equal(kit.gkClaim(dir, "a"), true);
    assert.equal(kit.gkClaim(dir, "a"), false);
    assert.equal(kit.gkClaim(dir, "b"), true, "other keys are independent");
    assert.equal(kit.gkUnclaim(dir, "a"), true);
    assert.equal(kit.gkUnclaim(dir, "a"), false);
    assert.equal(kit.gkClaim(dir, "a"), true, "claimable again after unclaim");

    assert.deepEqual(kit.gkCount(dir, "c", 2), { ok: true, n: 1 });
    assert.deepEqual(kit.gkCount(dir, "c", 2), { ok: true, n: 2 });
    assert.deepEqual(kit.gkCount(dir, "c", 2), { ok: false, n: 2 }, "at limit nothing is added");
    assert.equal(kit.gkRefund(dir, "c"), 1);
    assert.deepEqual(kit.gkCount(dir, "c", 2), { ok: true, n: 2 });

    assert.equal(kit.gkRefund(dir, "fresh"), 0, "refund on a fresh key stays at zero");
    assert.equal(kit.gkRefund(dir, "fresh"), 0, "refund never goes below zero");
  });

  t.test("concurrency: two processes share a limit of exactly 5, one in-process claim wins", async () => {
    const dir = join(scratch, `conc-${loads}-${Math.random().toString(36).slice(2)}`);
    const body = `Array.from({ length: 12 }, () => kit.gkCount(${JSON.stringify(dir)}, "k", 5).ok)`;
    const [a, b] = await Promise.all([runChild(url, body), runChild(url, body)]);
    assert.equal([...a, ...b].filter(Boolean).length, 5, "total successful counts");

    const claimDir = join(scratch, `claim-${loads}-${Math.random().toString(36).slice(2)}`);
    const claims = await Promise.all(
      Array.from({ length: 12 }, () => Promise.resolve().then(() => kit.gkClaim(claimDir, "only"))),
    );
    assert.equal(claims.filter(Boolean).length, 1, "exactly one claim wins");
  });

  t.test("concurrency: 800 contended increments never exceed the limit of 300", async () => {
    const dir = join(scratch, `stress-${loads}-${Math.random().toString(36).slice(2)}`);
    const body = `Array.from({ length: 400 }, () => kit.gkCount(${JSON.stringify(dir)}, "s", 300).ok)`;
    const [a, b] = await Promise.all([runChild(url, body), runChild(url, body)]);
    assert.equal([...a, ...b].filter(Boolean).length, 300);
  });

  t.test("restart: a claim made by one process is still held by a new process", async () => {
    const dir = join(scratch, `restart-${loads}-${Math.random().toString(36).slice(2)}`);
    assert.equal(kit.gkClaim(dir, "once"), true);
    assert.equal(await runChild(url, `kit.gkClaim(${JSON.stringify(dir)}, "once")`), false);
  });

  t.test("gkNextOpen re-enters a window through a fall-back fold (NY repro)", () => {
    assert.equal(kit.gkNextOpen(Date.parse("2024-11-03T05:45:03Z"), NY, "00:30", "01:30"), Date.parse("2024-11-03T06:00:00Z"));
  });

  t.test("gkNextOpen re-enters a window through a spring-forward-free transition (London repro)", () => {
    assert.equal(kit.gkNextOpen(Date.parse("2024-10-27T00:38:00Z"), LON, "00:30", "01:30"), Date.parse("2024-10-27T01:00:00Z"));
  });

  t.test("gkNextOpen across a midnight-wrapping window and fold (Havana repro)", () => {
    assert.equal(kit.gkNextOpen(Date.parse("2024-11-03T04:36:00Z"), "America/Havana", "23:30", "00:30"), Date.parse("2024-11-03T05:00:00Z"));
  });

  t.test("gkNextOpen across a half-hour fold (St_Johns repro)", () => {
    assert.equal(kit.gkNextOpen(Date.parse("2024-11-03T04:02:00Z"), "America/St_Johns", "00:30", "01:30"), Date.parse("2024-11-03T04:30:00Z"));
  });

  t.test("gkNextOpen across a spring-forward in Africa/Casablanca (repro)", () => {
    assert.equal(kit.gkNextOpen(Date.parse("2024-03-10T01:46:00Z"), "Africa/Casablanca", "01:30", "02:30"), Date.parse("2024-03-10T02:00:00Z"));
  });

  t.test("zone argument: unknown or missing zone throws RangeError in every zone function", () => {
    const t0 = utc(2026, 3, 8, 12, 0);
    const calls = [
      ["gkLocal", (z) => kit.gkLocal(t0, z)],
      ["gkDayKey", (z) => kit.gkDayKey(t0, z)],
      ["gkWeekKey", (z) => kit.gkWeekKey(t0, z)],
      ["gkMonthKey", (z) => kit.gkMonthKey(t0, z)],
      ["gkNextMidnight", (z) => kit.gkNextMidnight(t0, z)],
      ["gkFmt", (z) => kit.gkFmt(t0, z)],
      ["gkInWindow", (z) => kit.gkInWindow(t0, z, "08:00", "21:00")],
      ["gkNextOpen", (z) => kit.gkNextOpen(t0, z, "08:00", "21:00")],
      ["gkNextOpen (empty window)", (z) => kit.gkNextOpen(t0, z, "08:00", "08:00")],
      ["gkInstant", (z) => kit.gkInstant(2026, 3, 8, 8, 0, z)],
    ];
    for (const bad of ["UTC+2", "", null, undefined, "Nowhere/City"]) {
      for (const [name, fn] of calls) {
        assert.throws(() => fn(bad), /unknown time zone/, `${name} with ${String(bad)}`);
      }
    }
  });

  t.test("time argument: null, undefined, NaN, Infinity and strings throw TypeError", () => {
    const callsAt = (x) => [
      () => kit.gkLocal(x, NY),
      () => kit.gkDayKey(x, NY),
      () => kit.gkWeekKey(x, NY),
      () => kit.gkMonthKey(x, NY),
      () => kit.gkNextMidnight(x, NY),
      () => kit.gkFmt(x, NY),
      () => kit.gkInWindow(x, NY, "08:00", "21:00"),
      () => kit.gkNextOpen(x, NY, "08:00", "21:00"),
      () => kit.gkNextOpen(x, NY, "08:00", "08:00"),
    ];
    for (const bad of [null, undefined, NaN, Infinity, "1700000000000"]) {
      callsAt(bad).forEach((fn, i) => assert.throws(fn, /epoch time must be a finite number/, `call ${i} with ${String(bad)}`));
    }
    assert.equal(kit.gkDayKey(0, "UTC"), "1970-01-01", "zero is a valid time");
  });

  t.test("time-of-day strings: HH:MM only, and 24:00 only as an end", () => {
    const t0 = utc(2026, 3, 8, 12, 0);
    for (const bad of ["7:00", "08:60", "24:00x", "24:01", "08:00:00", "8:00", "", "-1:00", "23:5", "25:00"]) {
      assert.throws(() => kit.gkInWindow(t0, NY, bad, "21:00"), RangeError, `start ${JSON.stringify(bad)}`);
      assert.throws(() => kit.gkInWindow(t0, NY, "08:00", bad), RangeError, `end ${JSON.stringify(bad)}`);
    }
    assert.throws(() => kit.gkInWindow(t0, NY, "24:00", "21:00"), RangeError, "24:00 as a start");
    assert.throws(() => kit.gkNextOpen(t0, NY, "24:00", "21:00"), RangeError, "24:00 as a start for gkNextOpen");
    assert.equal(kit.gkInWindow(utc(2026, 3, 9, 3, 30), NY, "22:00", "24:00"), true, "23:30 EDT is inside 22:00-24:00");
    assert.equal(kit.gkInWindow(utc(2026, 3, 9, 4, 0), NY, "22:00", "24:00"), false, "00:00 EDT is outside 22:00-24:00");
    assert.equal(kit.gkInWindow(utc(2026, 3, 8, 5, 0), NY, "00:00", "01:00"), true, "00:00 is a valid start");
    assert.equal(kit.gkNextOpen(utc(2026, 3, 8, 16, 0), NY, "22:00", "24:00"), utc(2026, 3, 9, 2, 0), "24:00 end is usable in gkNextOpen");
  });

  t.test("gkCount limit must be a non-negative integer", () => {
    const dir = join(scratch, `limit-${loads}-${Math.random().toString(36).slice(2)}`);
    for (const bad of [-1, 1.5, "5", NaN, null, undefined]) {
      assert.throws(() => kit.gkCount(dir, "k", bad), /limit must be a non-negative integer/, `limit ${String(bad)}`);
    }
    assert.deepEqual(kit.gkCount(dir, "k", 0), { ok: false, n: 0 }, "limit 0 is valid and admits nothing");
  });

  t.test("keys must be strings: numbers, null, undefined and objects throw TypeError", () => {
    const dir = join(scratch, `keys-${loads}-${Math.random().toString(36).slice(2)}`);
    for (const bad of [5, null, undefined, {}]) {
      const keyError = /key must be a string/;
      assert.throws(() => kit.gkRead(dir, bad), keyError, `read ${String(bad)}`);
      assert.throws(() => kit.gkWrite(dir, bad, {}), keyError, `write ${String(bad)}`);
      assert.throws(() => kit.gkClaim(dir, bad), keyError, `claim ${String(bad)}`);
      assert.throws(() => kit.gkCount(dir, bad, 1), keyError, `count ${String(bad)}`);
    }
  });

  t.test("gkRead does not create its directory", () => {
    const dir = join(scratch, `nocreate-${loads}-${Math.random().toString(36).slice(2)}`);
    assert.equal(kit.gkRead(dir, "a"), null);
    assert.equal(existsSync(dir), false, "read must not create the directory");
  });

  t.test("stale lock: a 60-second-old lock is broken and gkCount recovers", async () => {
    const dir = join(scratch, `stale-${loads}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, createHash("sha1").update("k").digest("hex") + ".lock");
    mkdirSync(lock);
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    assert.deepEqual(await runChild(url, `kit.gkCount(${JSON.stringify(dir)}, "k", 5)`, 5000), { ok: true, n: 1 });
  });

  t.test("stale lock: two processes breaking one stale lock never exceed the limit", async () => {
    const dir = join(scratch, `stale2-${loads}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, createHash("sha1").update("k").digest("hex") + ".lock");
    mkdirSync(lock);
    const old = Date.now() / 1000 - 60;
    utimesSync(lock, old, old);
    const body = `Array.from({ length: 20 }, () => kit.gkCount(${JSON.stringify(dir)}, "k", 5).ok)`;
    const [a, b] = await Promise.all([runChild(url, body, 5000), runChild(url, body, 5000)]);
    assert.equal([...a, ...b].filter(Boolean).length, 5, "total successful counts");
  });
}

// Loads a mutated source, runs every check, and returns the list of failing checks.
async function failuresOf(source) {
  const env = await loadKit(source);
  const failures = [];
  const jobs = [];
  runChecks(env, {
    test: (name, fn) => {
      jobs.push(
        Promise.resolve()
          .then(fn)
          .catch((error) => {
            failures.push(`${name}: ${error.message.split("\n")[0]}`);
          }),
      );
    },
  });
  await Promise.all(jobs);
  return failures;
}

// Each mutant changes one line of the kit; the checks must fail on it.
const MUTANTS = [
  {
    name: "gkInWindow end inclusive",
    from: "return m >= s && m < e;",
    to: "return m >= s && m <= e;",
  },
  {
    name: "gkInWindow start exclusive",
    from: "return m >= s && m < e;",
    to: "return m > s && m < e;",
  },
  {
    name: "gkInWindow wrap condition inverted",
    from: "if (s < e) return",
    to: "if (s > e) return",
  },
  {
    name: "gkInWindow wrap uses and instead of or",
    from: "return m >= s || m < e;",
    to: "return m >= s && m < e;",
  },
  {
    name: "gkNextOpen ignores the next-day candidate",
    from: "for (let k = -1; k <= 3; k += 1) {",
    to: "for (let k = 0; k <= 0; k += 1) {",
  },
  {
    name: "gkNextOpen treats the window start as UTC wall time",
    from: "cands.push(...gkCandidates(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), sh, sm, zone));",
    to: "cands.push(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), sh, sm));",
  },
  {
    name: "gkInstant returns the instant before the gap transition",
    from: "  return [hi];",
    to: "  return [lo];",
  },
  {
    name: "gkInstant picks the later instant on fold",
    from: "return Math.min(...gkCandidates(y, m, d, hh, mm, zone));",
    to: "return Math.max(...gkCandidates(y, m, d, hh, mm, zone));",
  },
  {
    name: "gkDayKey uses the UTC day",
    from: "  return gkLocal(t, zone).day;",
    to: "  return new Date(t).toISOString().slice(0, 10);",
  },
  {
    name: "gkWeekKey counts from Sunday",
    from: "const isoDow = (date.getUTCDay() + 6) % 7;",
    to: "const isoDow = date.getUTCDay();",
  },
  {
    name: "gkNextMidnight adds 24h to today's midnight",
    from: "return gkInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, zone);",
    to: "return gkInstant(cur.y, cur.m, cur.d, 0, 0, zone) + 86400000;",
  },
  {
    name: "gkFmt uses a 12-hour clock",
    from: "const hh = String(p.hh).padStart(2, \"0\");",
    to: "const hh = String(p.hh % 12 || 12).padStart(2, \"0\");",
  },
  {
    name: "gkIsStop drops revoke",
    from: "\"quit\", \"revoke\", ",
    to: "\"quit\", ",
  },
  {
    name: "gkIsStop matches substrings",
    from: "return words.has(gkNormalize(text));",
    to: "return [...words].some((w) => gkNormalize(text).includes(w));",
  },
  {
    name: "gkClaim is not exclusive",
    from: "{ flag: \"wx\" }",
    to: "{ flag: \"w\" }",
  },
  {
    name: "gkCount ignores the limit",
    from: "if (n < limit) {",
    to: "if (true) {",
  },
  {
    name: "gkCount takes no lock",
    from: "const lock = gkAcquire(dir, key);\n  try {\n    const n = gkReadCount(dir, key);\n    if (n < limit)",
    to: "const lock = gkPathFor(dir, key, \".lock\");\n  try {\n    const n = gkReadCount(dir, key);\n    if (n < limit)",
  },
  {
    name: "gkRefund goes below zero",
    from: "Math.max(0, gkReadCount(dir, key) - 1)",
    to: "gkReadCount(dir, key) - 1",
  },
  {
    name: "gkLocal uses a 24-hour cycle that prints 24",
    from: "hourCycle: \"h23\",",
    to: "hourCycle: \"h24\",",
  },
  {
    name: "gkNextOpen has no offset-transition candidates (fold re-entry)",
    from: "  const cands = gkTransitions(t, t + 50 * 3600000, zone);",
    to: "  const cands = [];",
  },
  {
    name: "zone check removed from gkRequireZone",
    from: "  if (!gkZoneOk(zone)) throw new RangeError",
    to: "  if (false) throw new RangeError",
  },
  {
    name: "time check removed from gkRequireTime (null read as 0)",
    from: "if (typeof t !== \"number\" || !Number.isFinite(t))",
    to: "if (Number.isNaN(t))",
  },
  {
    name: "24:00 accepted as a start",
    from: "if (isEnd && text === \"24:00\") return 1440;",
    to: "if (text === \"24:00\") return 1440;",
  },
  {
    name: "key type check removed",
    from: "if (typeof key !== \"string\") throw",
    to: "if (false) throw",
  },
  {
    name: "limit check removed from gkCount",
    from: "if (!Number.isInteger(limit) || limit < 0) throw",
    to: "if (false) throw",
  },
  {
    name: "stale lock is never broken",
    from: "  if (age <= 10000) return;",
    to: "  return;",
  },
  {
    name: "gkRead creates its directory",
    from: "function gkRead(dir, key) {\n  try {",
    to: "function gkRead(dir, key) {\n  gkFs.mkdirSync(dir, { recursive: true });\n  try {",
  },
];

const realEnv = await loadKit(KIT_SOURCE);
runChecks(realEnv, { test });

for (const mutant of MUTANTS) {
  test(`gate-kit mutant is caught: ${mutant.name}`, async (t) => {
    const occurrences = KIT_SOURCE.split(mutant.from).length - 1;
    assert.equal(occurrences, 1, `mutant anchor must occur exactly once, found ${occurrences}`);
    const mutated = KIT_SOURCE.replace(mutant.from, () => mutant.to);
    const failures = await failuresOf(mutated);
    t.diagnostic(failures.length > 0 ? `caught by ${failures.join(" | ")}` : "not caught");
    assert.ok(failures.length > 0, "the checks must fail on the mutant");
  });
}
