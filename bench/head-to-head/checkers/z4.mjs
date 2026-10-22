// Checker for Z4 (ready notices and suggestions: decide, REASON_CODES). usage: node z4.mjs <dir containing bot.mjs>
// Every case runs in this process against fresh state (a new temp STATE_DIR and fresh user ids).
// Derivation of the expected instants (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   2026-09-04T09:00:00Z = 12:00 on 4 Sep, Europe/Istanbul (UTC+3, no DST)
//   2026-09-04T00:00:00Z = 03:00 on 4 Sep, Europe/Istanbul (quiet hours)
//   2026-09-04T09:10:00Z, 09:20:00Z, 09:30:00Z = 12:10, 12:20, 12:30 on 4 Sep
//   2026-09-05T09:00:00Z = 12:00 on 5 Sep, Europe/Istanbul (the next local day)
//   Account ages are arithmetic on NOW (2 and 30 days before), not expected outputs.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
const bot = await load(dir).catch(() => null);

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse("2026-09-04T09:00:00Z");
let seq = 0;
const uid = (tag) => `${tag}-${++seq}`;
const seen = []; // every decision the checker has observed, for criterion 6

function freshState() {
  const d = mkdtempSync(join(tmpdir(), "z4-"));
  process.env.STATE_DIR = join(d, "state");
}
// profileCreatedAt defaults to 30 days ago (an established profile); criteria that test the profile pass NOW explicitly.
function user(accountDays, profileAt = NOW - 30 * DAY, over = {}) {
  return {
    id: uid("u"),
    timezone: "Europe/Istanbul",
    createdAt: new Date(NOW - accountDays * DAY).toISOString(),
    profileCreatedAt: new Date(profileAt).toISOString(),
    ...over,
  };
}
const CAP2 = { dailyNudgeCap: 2 };
async function call(u, origin, atMs, config = CAP2, id = uid("cand")) {
  const res = await bot.decide({ user: u, candidate: { id, origin }, now: new Date(atMs), config });
  seen.push(res);
  return res;
}
function check(why, label, res, send) {
  if (!res || res.send !== send) {
    why(`${label}: got ${JSON.stringify(res)}, want send ${send}`);
    return false;
  }
  return true;
}

const r = new Report();

await r.crit("1 new account: a suggestion is held for a 2-day account even when its profile is new, and allowed for a 30-day account", async (why) => {
  freshState();
  let ok = true;
  ok = check(why, "2-day account, inferred, profile created now", await call(user(2, NOW), "inferred", NOW), false) && ok;
  ok = check(why, "30-day account, inferred, profile created now", await call(user(30, NOW), "inferred", NOW), true) && ok;
  return ok;
});

await r.crit("2 new account: a requested notice passes the new-account hold", async (why) => {
  freshState();
  return check(why, "2-day account whose profile was created now, requested", await call(user(2, NOW), "requested", NOW), true);
});

await r.crit("3 quiet hours: a requested notice at 03:00 local is held, and the same user at 12:00 local is sent", async (why) => {
  freshState();
  const u2 = user(2);
  const u30 = user(30);
  let ok = true;
  ok = check(why, "2-day account, requested at 03:00 local", await call(u2, "requested", Date.parse("2026-09-04T00:00:00Z")), false) && ok;
  ok = check(why, "2-day account, requested at 12:00 local", await call(u2, "requested", NOW), true) && ok;
  ok = check(why, "30-day account, requested at 03:00 local", await call(u30, "requested", Date.parse("2026-09-04T00:00:00Z")), false) && ok;
  return ok;
});

await r.crit("4 cap: the nudge cap bounds suggestions per local day for cap 2 and cap 3, and resets on the next local day", async (why) => {
  freshState();
  let ok = true;
  const a = user(30);
  ok = check(why, "cap 2, suggestion 1", await call(a, "inferred", NOW, CAP2), true) && ok;
  ok = check(why, "cap 2, suggestion 2", await call(a, "inferred", NOW + 10 * MIN, CAP2), true) && ok;
  ok = check(why, "cap 2, suggestion 3 (refused)", await call(a, "inferred", NOW + 20 * MIN, CAP2), false) && ok;
  const b = user(30);
  const cap3 = { dailyNudgeCap: 3 };
  ok = check(why, "cap 3, suggestion 1", await call(b, "inferred", NOW, cap3), true) && ok;
  ok = check(why, "cap 3, suggestion 2", await call(b, "inferred", NOW + 10 * MIN, cap3), true) && ok;
  ok = check(why, "cap 3, suggestion 3", await call(b, "inferred", NOW + 20 * MIN, cap3), true) && ok;
  ok = check(why, "cap 3, suggestion 4 (refused)", await call(b, "inferred", NOW + 30 * MIN, cap3), false) && ok;
  ok = check(why, "cap 2 user, next local day 12:00", await call(a, "inferred", Date.parse("2026-09-05T09:00:00Z"), CAP2), true) && ok;
  return ok;
});

await r.crit("5 reminders: twenty reminders neither fail nor use the cap, and a full cap still allows reminders", async (why) => {
  freshState();
  let ok = true;
  const u = user(30);
  for (let i = 0; i < 20; i++) {
    ok = check(why, `reminder ${i + 1}`, await call(u, "reminder", NOW + i * MIN, CAP2), true) && ok;
  }
  ok = check(why, "suggestion 1 after 20 reminders", await call(u, "inferred", NOW + 20 * MIN, CAP2), true) && ok;
  ok = check(why, "suggestion 2 after 20 reminders", await call(u, "inferred", NOW + 21 * MIN, CAP2), true) && ok;
  ok = check(why, "suggestion 3 (cap full)", await call(u, "inferred", NOW + 22 * MIN, CAP2), false) && ok;
  ok = check(why, "reminder with the cap full", await call(u, "reminder", NOW + 23 * MIN, CAP2), true) && ok;
  return ok;
});

await r.crit("6 reason codes: every refusal has a string reasonCode listed in REASON_CODES, and no code says error", async (why) => {
  freshState();
  // provoke each refusal this checker knows how to cause, then check everything observed so far
  const young = user(2);
  await call(young, "inferred", NOW);
  await call(user(30), "requested", Date.parse("2026-09-04T00:00:00Z"));
  const capped = user(30);
  await call(capped, "inferred", NOW, CAP2);
  await call(capped, "inferred", NOW + MIN, CAP2);
  await call(capped, "inferred", NOW + 2 * MIN, CAP2);

  let ok = true;
  const codes = bot.REASON_CODES;
  if (!Array.isArray(codes) || codes.length === 0) {
    why("REASON_CODES is not a non-empty array");
    return false;
  }
  if (!codes.every((c) => typeof c === "string" && c.length > 0)) {
    why("REASON_CODES holds a value that is not a non-empty string");
    ok = false;
  }
  const refusals = seen.filter((res) => res && res.send === false);
  if (refusals.length === 0) {
    why("no refusal observed");
    return false;
  }
  for (const res of refusals) {
    if (typeof res.reasonCode !== "string") {
      why(`refusal without a string reasonCode: ${JSON.stringify(res)}`);
      ok = false;
    } else if (!codes.includes(res.reasonCode)) {
      why(`reasonCode ${res.reasonCode} not in REASON_CODES`);
      ok = false;
    } else if (/error/i.test(res.reasonCode)) {
      why(`reasonCode ${res.reasonCode} says error`);
      ok = false;
    }
  }
  return ok;
});

r.print();
