import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = process.argv[2];
const fresh = () => join(mkdtempSync(join(tmpdir(), "r4-")), "state");
const H = 3600 * 1000;
const T0 = Date.parse("2026-06-10T09:00:00Z");
const at = (ms) => new Date(T0 + ms);
async function inproc() {
  process.env.STATE_DIR = fresh();
  const bot = await load(dir);
  return { bot, can: (userId, ms, kind) => bot.canSend({ userId, now: at(ms), kind }) };
}
const D = (ms) => ({ $date: at(ms).toISOString() });
const r = new Report();
await r.crit("1 free-form text only inside 24 hours of the customer's last message", async (why) => {
  const { bot, can } = await inproc();
  await bot.recordOptIn("u", at(-48 * H));
  await bot.recordInbound("u", at(0));
  const a = [await can("u", 1 * H, "freeform"), await can("u", 23 * H + 59 * 60000, "freeform"), await can("u", 24 * H + 60000, "freeform"), await can("u", 40 * H, "freeform")];
  const ok = a[0].allowed === true && a[1].allowed === true && a[2].allowed === false && a[3].allowed === false;
  if (!ok) why(a.map((x) => x.allowed).join(","));
  return ok;
});
await r.crit("2 approved templates work outside the window; free-form never works without a message", async (why) => {
  const { bot, can } = await inproc();
  await bot.recordOptIn("u", at(-48 * H));
  await bot.recordInbound("u", at(0));
  await bot.recordOptIn("v", at(-48 * H));
  const a = [await can("u", 30 * H, "template"), await can("u", 100 * H, "template"), await can("v", 1 * H, "freeform"), await can("v", 1 * H, "template")];
  const ok = a[0].allowed === true && a[1].allowed === true && a[2].allowed === false && a[3].allowed === true;
  if (!ok) why(a.map((x) => x.allowed).join(","));
  return ok;
});
await r.crit("3 a newer message extends the window and an older late webhook cannot shorten it", async (why) => {
  const { bot, can } = await inproc();
  await bot.recordOptIn("u", at(-48 * H));
  await bot.recordInbound("u", at(0));
  await bot.recordInbound("u", at(20 * H));
  const a = [await can("u", 30 * H, "freeform"), await can("u", 44 * H + 60000, "freeform")];
  await bot.recordInbound("u", at(5 * H)); // arrives late, happened earlier
  const b = [await can("u", 30 * H, "freeform"), await can("u", 43 * H, "freeform")];
  const ok = a[0].allowed === true && a[1].allowed === false && b[0].allowed === true && b[1].allowed === true;
  if (!ok) why(a.concat(b).map((x) => x.allowed).join(","));
  return ok;
});
await r.crit("4 state is shared between worker processes and survives restarts", async (why) => {
  const st = fresh();
  const w1 = await runProc(dir, st, [
    { fn: "recordOptIn", args: ["u", D(-48 * H)] }, { fn: "recordInbound", args: ["u", D(0)] }]);
  const w2 = await runProc(dir, st, [
    { fn: "canSend", args: [{ userId: "u", now: D(2 * H), kind: "freeform" }] },
    { fn: "canSend", args: [{ userId: "u", now: D(25 * H), kind: "freeform" }] },
    { fn: "canSend", args: [{ userId: "u", now: D(25 * H), kind: "template" }] }]);
  const ok = w2[0] && w2[0].allowed === true && w2[1] && w2[1].allowed === false && w2[2] && w2[2].allowed === true;
  if (!ok) why(JSON.stringify([w1, w2]));
  return ok;
});
await r.crit("5 an opt-out stops every kind of message", async (why) => {
  const { bot, can } = await inproc();
  await bot.recordOptIn("u", at(-48 * H));
  await bot.recordInbound("u", at(0));
  const before = await can("u", 1 * H, "freeform");
  await bot.recordOptOut("u", at(2 * H));
  const a = [await can("u", 3 * H, "freeform"), await can("u", 3 * H, "template"), await can("u", 60 * H, "template")];
  const ok = before.allowed === true && a.every((x) => x.allowed === false);
  if (!ok) why([before].concat(a).map((x) => x.allowed).join(","));
  return ok;
});
await r.crit("6 nothing is sent to a customer who never opted in", async (why) => {
  const { bot, can } = await inproc();
  const a = [await can("nobody", 0, "freeform"), await can("nobody", 0, "template")];
  await bot.recordInbound("w", at(0));
  const b = [await can("w", 1 * H, "template")];
  const ok = a.every((x) => x.allowed === false && typeof x.rule === "string" && x.rule) && b[0].allowed === false;
  if (!ok) why(a.concat(b).map((x) => x.allowed).join(","));
  return ok;
});
r.print();
