// Checker for Z2 (weekly digest text: trySend, handleInbound, optOut). usage: node z2.mjs <dir containing bot.mjs>
// Every case runs against fresh state (a new temp STATE_DIR, fresh user and message ids). Multi-process cases use procz.mjs.
// Derivation of the expected instants (each clock reading cross-checked with Intl.DateTimeFormat outside this file):
//   America/New_York, 15 Jun 2026 (EDT, UTC-4):  11:59Z = 07:59, 12:00Z = 08:00, 00:59Z on 16 Jun = 20:59, 01:00Z = 21:00
//   America/New_York, 8 Mar 2026 (EDT, DST began 07:00Z): 11:59Z = 07:59, 12:00Z = 08:00
//   America/New_York, 1 Nov 2026 (EST, UTC-5, DST ended 06:00Z): 12:59Z = 07:59, 13:00Z = 08:00
//   America/Phoenix, 15 Jun 2026 (MST, UTC-7, no DST): 14:59Z = 07:59, 15:00Z = 08:00, 03:59Z on 16 Jun = 20:59, 04:00Z = 21:00
//   Baseline instant for criteria 2 to 6: 2026-09-04T15:00:00Z = 11:00 in New York (EDT), so inside the window.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Report, load } from "./lib.mjs";
import { runProc } from "./procz.mjs";

const dir = process.argv[2];
const bot = await load(dir).catch(() => null);

const NY = "America/New_York";
const PHX = "America/Phoenix";
const NOW = "2026-09-04T15:00:00Z";
const MIN = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
const uid = (tag) => `${tag}-${++seq}`;
const at = (iso, minutesBefore = 0) => new Date(Date.parse(iso) - minutesBefore * MIN).toISOString();
const msg = (id, createdAt) => ({ id, channel: "sms", createdAt });
const roots = [];
// Each case gets its own state directory; the bot reads STATE_DIR at call time.
function freshState() {
  const d = mkdtempSync(join(tmpdir(), "z2-"));
  roots.push(d);
  const state = join(d, "state");
  process.env.STATE_DIR = state;
  return state;
}
const trySend = (u, message, nowIso) => bot.trySend({ user: u, message, now: new Date(nowIso) });
const refused = (res) => res && typeof res === "object" && res.sent === false && typeof res.reason === "string" && res.reason.trim().length > 0;
const r = new Report();

await r.crit("1 window: no digest outside 08:00 to 21:00 recipient-local, across DST and in Phoenix", async (why) => {
  freshState();
  const cases = [
    [NY, "2026-06-15T11:59:00Z", false], [NY, "2026-06-15T12:00:00Z", true],
    [NY, "2026-06-16T00:59:00Z", true], [NY, "2026-06-16T01:00:00Z", false],
    [NY, "2026-03-08T11:59:00Z", false], [NY, "2026-03-08T12:00:00Z", true],
    [NY, "2026-11-01T12:59:00Z", false], [NY, "2026-11-01T13:00:00Z", true],
    [PHX, "2026-06-15T14:59:00Z", false], [PHX, "2026-06-15T15:00:00Z", true],
    [PHX, "2026-06-16T03:59:00Z", true], [PHX, "2026-06-16T04:00:00Z", false],
  ];
  let ok = true;
  for (const [zone, instant, want] of cases) {
    const u = { id: uid("win"), timezone: zone };
    const res = await trySend(u, msg(uid("m"), at(instant, 10)), instant);
    if (!res || res.sent !== want) {
      ok = false;
      why(`${zone} ${instant}: sent ${JSON.stringify(res && res.sent)}, want ${want}`);
    }
  }
  return ok;
});

await r.crit("2 keywords: STOP words in any case or with punctuation revoke, ordinary words do not", async (why) => {
  freshState();
  let ok = true;
  const stops = ["STOP", "stop", "  Stop.  ", "QUIT", "End", "Revoke", "opt out", "CANCEL", "unsubscribe!"];
  for (const text of stops) {
    const u = { id: uid("kw"), timezone: NY };
    await bot.handleInbound({ userId: u.id, channel: "sms", text, now: new Date(NOW) });
    const res = await trySend(u, msg(uid("m"), at(NOW, 10)), NOW);
    if (!refused(res)) {
      ok = false;
      why(`"${text}" did not revoke (${JSON.stringify(res)})`);
    }
  }
  const keep = ["please stop by tomorrow", "thanks", "stopping", "I will not stop by"];
  for (const text of keep) {
    const u = { id: uid("kp"), timezone: NY };
    await bot.handleInbound({ userId: u.id, channel: "sms", text, now: new Date(NOW) });
    const res = await trySend(u, msg(uid("m"), at(NOW, 10)), NOW);
    if (!res || res.sent !== true) {
      ok = false;
      why(`"${text}" revoked the digest (${JSON.stringify(res && res.sent)})`);
    }
  }
  return ok;
});

await r.crit("3 revocation: a STOP is seen by a second process and still holds after a restart", async (why) => {
  const state = freshState();
  const u = { id: uid("rv"), timezone: NY };
  await runProc(dir, state, [{ fn: "handleInbound", args: [{ userId: u.id, channel: "sms", text: "STOP", now: { $date: NOW } }] }]);
  const [second] = await runProc(dir, state, [{ fn: "trySend", args: [{ user: u, message: msg(uid("m"), at(NOW, 10)), now: { $date: NOW } }] }]);
  if (!refused(second)) {
    why(`second process sent after STOP (${JSON.stringify(second)})`);
    return false;
  }
  const [third] = await runProc(dir, state, [{ fn: "trySend", args: [{ user: u, message: msg(uid("m"), at(NOW, 10)), now: { $date: NOW } }] }]);
  if (!refused(third)) {
    why(`third process after restart sent (${JSON.stringify(third)})`);
    return false;
  }
  return true;
});

await r.crit("4 optOut route: optOut(userId, sms) refuses the next trySend, leaves others alone, survives a new process", async (why) => {
  const state = freshState();
  const a = { id: uid("oa"), timezone: NY };
  const b = { id: uid("ob"), timezone: NY };
  await bot.optOut(a.id, "sms");
  const refusedA = await trySend(a, msg(uid("m"), at(NOW, 10)), NOW);
  if (!refused(refusedA)) {
    why(`in-process trySend after optOut: ${JSON.stringify(refusedA)}`);
    return false;
  }
  const other = await trySend(b, msg(uid("m"), at(NOW, 10)), NOW);
  if (!other || other.sent !== true) {
    why(`other user affected by optOut: ${JSON.stringify(other)}`);
    return false;
  }
  const [second] = await runProc(dir, state, [{ fn: "trySend", args: [{ user: a, message: msg(uid("m"), at(NOW, 10)), now: { $date: NOW } }] }]);
  if (!refused(second)) {
    why(`second process sent after optOut (${JSON.stringify(second)})`);
    return false;
  }
  return true;
});

await r.crit("5 dedupe: the same message id from 10 processes at once, and again after a restart, is sent once (3 repetitions, each with fresh state and a fresh message id)", async (why) => {
  for (let rep = 1; rep <= 3; rep++) {
    const state = freshState();
    const u = { id: uid("dd"), timezone: NY };
    const m = msg(uid("same"), at(NOW, 10));
    const plan = [{ fn: "trySend", args: [{ user: u, message: m, now: { $date: NOW } }] }];
    const results = await Promise.all(Array.from({ length: 10 }, () => runProc(dir, state, plan)));
    const sent = results.map((r2) => r2[0]).filter((x) => x && x.sent === true).length;
    if (sent !== 1) {
      why(`repeat ${rep}: 10 concurrent processes sent ${sent} times, want 1`);
      return false;
    }
    const [again] = await runProc(dir, state, plan);
    if (!again || again.sent !== false) {
      why(`repeat ${rep}: same id after restart sent again (${JSON.stringify(again)})`);
      return false;
    }
  }
  return true;
});

await r.crit("6 staleness: a digest created three days ago is dropped, one created 10 minutes ago is sent", async (why) => {
  freshState();
  const old = await trySend({ id: uid("st"), timezone: NY }, msg(uid("m"), at(NOW, 3 * 24 * 60)), NOW);
  if (!refused(old)) {
    why(`three-day-old digest: ${JSON.stringify(old)}`);
    return false;
  }
  const fresh = await trySend({ id: uid("st"), timezone: NY }, msg(uid("m"), at(NOW, 10)), NOW);
  if (!fresh || fresh.sent !== true) {
    why(`ten-minute-old digest: ${JSON.stringify(fresh)}`);
    return false;
  }
  return true;
});

r.print();
