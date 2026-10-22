// Checker for Z5 (stay quiet: decide). usage: node z5.mjs <dir containing bot.mjs>
// Every case runs in this process against fresh state (a new temp STATE_DIR and fresh user ids).
// Derivation of the expected instants (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   2026-09-04T06:00:00Z = 09:00 on 4 Sep, Europe/Istanbul (UTC+3, no DST)
//   2026-09-04T11:00:00Z = 14:00 on 4 Sep, Europe/Istanbul
//   2026-09-05T06:00:00Z = 09:00 on 5 Sep, Europe/Istanbul (the next local day)
//   2026-09-04T05:00:00Z = 08:00 on 4 Sep, Europe/Istanbul (the crisis candidates, before the normal ones)
//   2026-09-04T12:00:00Z = 15:00 on 4 Sep, Europe/Istanbul (the second normal candidate, six hours after 09:00)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
const bot = await load(dir).catch(() => null);

const MIN = 60 * 1000;
const NOW = Date.parse("2026-09-04T06:00:00Z");
const NEXT_DAY = Date.parse("2026-09-05T06:00:00Z");
const AT_14 = Date.parse("2026-09-04T11:00:00Z");
const CRISIS_START = Date.parse("2026-09-04T05:00:00Z");
const AT_15 = Date.parse("2026-09-04T12:00:00Z");
let seq = 0;
const uid = (tag) => `${tag}-${++seq}`;
const seen = []; // every decision observed, for criterion 5

function freshState() {
  const d = mkdtempSync(join(tmpdir(), "z5-"));
  process.env.STATE_DIR = join(d, "state");
}
function user(over = {}) {
  return { id: uid("u"), timezone: "Europe/Istanbul", accountAgeDays: 90, focusMode: false, ...over };
}
function cand(key, dataPoints = 30, confidence = 0.9) {
  return { id: uid("c"), type: "insight", insight: { key, dataPoints, confidence } };
}
const CALM = { crisis: false, hourStats: {} };
async function call(u, c, atMs, context = CALM) {
  const res = await bot.decide({ user: u, candidate: c, context, now: new Date(atMs) });
  seen.push(res);
  return res;
}
const SUBSET = ["push", "inApp"];
function check(why, label, res, send) {
  if (!res || res.send !== send) {
    why(`${label}: got ${JSON.stringify(res)}, want send ${send}`);
    return false;
  }
  return true;
}

const r = new Report();

await r.crit("1 thin data: a 1 to 2 day account with fewer than 5 data points gets nothing, a mature account gets a message", async (why) => {
  freshState();
  let ok = true;
  ok = check(why, "1-day account, 2 data points", await call(user({ accountAgeDays: 1 }), cand("k-a", 2), NOW), false) && ok;
  ok = check(why, "2-day account, 4 data points", await call(user({ accountAgeDays: 2 }), cand("k-b", 4), NOW), false) && ok;
  const base = await call(user(), cand("k-c"), NOW);
  ok = check(why, "baseline mature account", base, true) && ok;
  if (base && base.send === true) {
    const s = base.surfaces;
    if (!Array.isArray(s) || s.length === 0 || !s.every((x) => SUBSET.includes(x))) {
      why(`baseline surfaces not a non-empty subset of push/inApp: ${JSON.stringify(s)}`);
      ok = false;
    }
  }
  return ok;
});

await r.crit("2 focus and confidence: focusMode true with confidence 0.42 gets nothing, a focus-free account with confidence 0.9 gets a message", async (why) => {
  freshState();
  let ok = true;
  ok = check(why, "focus on, confidence 0.42", await call(user({ focusMode: true }), cand("k-f", 30, 0.42), NOW), false) && ok;
  ok = check(why, "focus off, confidence 0.9", await call(user({ focusMode: false }), cand("k-g", 30, 0.9), NOW), true) && ok;
  return ok;
});

await r.crit("3 same key: the same insight key twice on one local day is shown once, the next local day may show it again", async (why) => {
  freshState();
  let ok = true;
  const u = user();
  ok = check(why, "first showing of k-same", await call(u, cand("k-same"), NOW), true) && ok;
  ok = check(why, "second showing of k-same, same day", await call(u, cand("k-same"), NOW + 30 * MIN), false) && ok;
  ok = check(why, "k-same on the next local day", await call(u, cand("k-same"), NEXT_DAY), true) && ok;
  return ok;
});

await r.crit("4 crisis: while context.crisis is true none of ten strong candidates is shown, and two normal candidates are shown after it clears", async (why) => {
  freshState();
  let ok = true;
  const u = user();
  const crisis = { crisis: true, hourStats: {} };
  for (let i = 0; i < 10; i++) {
    ok = check(why, `crisis candidate ${i + 1}`, await call(u, cand(uid("k-crisis"), 100, 0.99), CRISIS_START + i * MIN, crisis), false) && ok;
  }
  ok = check(why, "normal candidate 1 after the crisis (09:00 local)", await call(u, cand(uid("k-n"), 30, 0.9), NOW), true) && ok;
  ok = check(why, "normal candidate 2 after the crisis (15:00 local, six hours later)", await call(u, cand(uid("k-n"), 30, 0.9), AT_15), true) && ok;
  return ok;
});

await r.crit("5 reasons: every silence has a non-empty reason that does not say error, a shown message has reason null or absent", async (why) => {
  // the scenarios above have run; check every decision seen so far, plus one silence of each kind provoked here
  freshState();
  await call(user({ accountAgeDays: 1 }), cand("k-r1", 2), NOW);
  await call(user({ focusMode: true }), cand("k-r2", 30, 0.42), NOW);
  await call(user(), cand("k-r3"), NOW, { crisis: true, hourStats: {} });
  let ok = true;
  const silences = seen.filter((x) => x && x.send === false);
  if (silences.length === 0) {
    why("no silence observed");
    return false;
  }
  for (const x of silences) {
    if (typeof x.reason !== "string" || x.reason.trim().length === 0) {
      why(`silence without a non-empty reason: ${JSON.stringify(x)}`);
      ok = false;
    } else if (/\berror\b/i.test(x.reason)) {
      why(`silence reason says error: ${x.reason}`);
      ok = false;
    }
  }
  for (const x of seen.filter((x) => x && x.send === true)) {
    if (x.reason !== null && x.reason !== undefined) {
      why(`shown message carries a reason: ${JSON.stringify(x)}`);
      ok = false;
    }
  }
  return ok;
});

await r.crit("6 hour history: at 14:00 local a mostly dismissed hour excludes push but keeps inApp, at 09:00 local a mostly acted hour includes push", async (why) => {
  freshState();
  let ok = true;
  const stats = { hourStats: { 14: { acted: 1, dismissed: 9 }, 9: { acted: 8, dismissed: 1 } } };
  const quiet = await call(user(), cand("k-h14"), AT_14, { crisis: false, hourStats: stats.hourStats });
  ok = check(why, "14:00 local", quiet, true) && ok;
  if (quiet && quiet.send === true) {
    if (Array.isArray(quiet.surfaces) && quiet.surfaces.includes("push")) {
      why(`14:00 local (dismissed hour) includes push: ${JSON.stringify(quiet.surfaces)}`);
      ok = false;
    }
    if (!Array.isArray(quiet.surfaces) || !quiet.surfaces.includes("inApp")) {
      why(`14:00 local (dismissed hour) lacks inApp: ${JSON.stringify(quiet.surfaces)}`);
      ok = false;
    }
  }
  const morning = await call(user(), cand("k-h9"), NOW, { crisis: false, hourStats: stats.hourStats });
  ok = check(why, "09:00 local", morning, true) && ok;
  if (morning && morning.send === true && !(Array.isArray(morning.surfaces) && morning.surfaces.includes("push"))) {
    why(`09:00 local (acted hour) lacks push: ${JSON.stringify(morning.surfaces)}`);
    ok = false;
  }
  return ok;
});

r.print();
