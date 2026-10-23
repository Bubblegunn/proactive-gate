import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load, Report } from "./lib.mjs";
import { runProc } from "./procz.mjs";
const dir = process.argv[2];
const r = new Report();
const fresh = () => mkdtempSync(join(tmpdir(), "k3-"));
const at = (sec) => new Date(Date.UTC(2026, 5, 10, 10, 0, sec));
const NOW = new Date("2026-06-10T12:00:00Z");
async function setup() { process.env.STATE_DIR = fresh(); return load(dir); }
const inb = (bot, userId, channel, text, sec) => bot.handleInbound({ userId, channel, text, receivedAt: at(sec) });
const can = async (bot, u, ch) => (await bot.canSend(u, ch, NOW)).allowed;
await r.crit("1 STOP keywords opt out of SMS, in any case and with spaces, and get a confirmation", async (why) => {
  const bot = await setup(); let ok = true; let i = 0;
  for (const w of ["STOP", "stop", "  Stop  ", "STOPALL", "UNSUBSCRIBE", "Cancel", "END", "quit", "STOP\n"]) {
    const u = "u" + ++i;
    const res = await inb(bot, u, "sms", w, 10);
    if (await can(bot, u, "sms")) { why(`"${w.trim()}" did not block`); ok = false; }
    if (!res || typeof res.reply !== "string" || !res.reply.trim()) { why(`"${w.trim()}" got no confirmation reply`); ok = false; }
  }
  return ok;
});
await r.crit("2 ordinary messages containing those words do not opt out", async (why) => {
  const bot = await setup(); let ok = true; let i = 0;
  for (const w of ["please don't stop the order updates", "stopwatch sale?", "Thanks!", "I can't stop laughing at this", "what does END mean", "Where do I start?", "quitters never win"]) {
    const u = "n" + ++i;
    await inb(bot, u, "sms", w, 10);
    if (!(await can(bot, u, "sms"))) { why(`"${w}" opted the person out`); ok = false; }
  }
  return ok;
});
await r.crit("3 opt-out is per channel and per person", async (why) => {
  const bot = await setup();
  await inb(bot, "a", "sms", "STOP", 10);
  await inb(bot, "b", "email", "unsubscribe", 10);
  const got = [await can(bot, "a", "sms"), await can(bot, "a", "email"), await can(bot, "b", "email"), await can(bot, "b", "sms"), await can(bot, "c", "sms")];
  if (JSON.stringify(got) !== JSON.stringify([false, true, false, true, true])) { why("got " + JSON.stringify(got)); return false; }
  return true;
});
await r.crit("4 an opt-out handled by one worker process is seen by another, after a restart", async (why) => {
  const st = fresh();
  const A = await runProc(dir, st, [{ fn: "handleInbound", args: [{ userId: "u1", channel: "sms", text: "STOP", receivedAt: { $date: at(10).toISOString() } }] }]);
  if (A[0] && A[0].error) { why("handleInbound threw: " + A[0].error); return false; }
  const B = await runProc(dir, st, [["u1", "sms"], ["u1", "email"], ["u2", "sms"]].map(([u, c]) => ({ fn: "canSend", args: [u, c, { $date: NOW.toISOString() }] })));
  const got = B.map((x) => x && x.allowed);
  if (JSON.stringify(got) !== JSON.stringify([false, true, true])) { why("got " + JSON.stringify(got)); return false; }
  return true;
});
await r.crit("5 START resubscribes; HELP answers and changes nothing", async (why) => {
  const bot = await setup(); let ok = true;
  const h0 = await inb(bot, "u", "sms", "HELP", 5);
  if (!h0 || typeof h0.reply !== "string" || !h0.reply.trim()) { why("HELP got no reply"); ok = false; }
  if (!(await can(bot, "u", "sms"))) { why("HELP blocked a subscribed person"); ok = false; }
  await inb(bot, "u", "sms", "STOP", 10);
  const h1 = await inb(bot, "u", "sms", "help", 15);
  if (await can(bot, "u", "sms")) { why("HELP re-enabled an opted-out person"); ok = false; }
  if (!h1 || typeof h1.reply !== "string" || !h1.reply.trim()) { why("HELP after STOP got no reply"); ok = false; }
  await inb(bot, "u", "sms", "START", 20);
  if (!(await can(bot, "u", "sms"))) { why("START did not resubscribe"); ok = false; }
  await inb(bot, "w", "sms", "STOP", 10); await inb(bot, "w", "sms", "UNSTOP", 20);
  if (!(await can(bot, "w", "sms"))) { why("UNSTOP did not resubscribe"); ok = false; }
  return ok;
});
await r.crit("6 messages handled out of order: the one the person sent last decides", async (why) => {
  const call = (userId, text, sec) => ({ fn: "handleInbound", args: [{ userId, channel: "sms", text, receivedAt: { $date: at(sec).toISOString() } }] });
  const st = fresh();
  await runProc(dir, st, [call("x", "STOP", 20)]);
  await runProc(dir, st, [call("x", "START", 10)]);
  await runProc(dir, st, [call("y", "STOP", 10)]);
  await runProc(dir, st, [call("y", "START", 20)]);
  await runProc(dir, st, [call("y", "STOP", 5)]);
  const res = await runProc(dir, st, ["x", "y"].map((u) => ({ fn: "canSend", args: [u, "sms", { $date: NOW.toISOString() }] })));
  const got = res.map((v) => v && v.allowed);
  if (JSON.stringify(got) !== JSON.stringify([false, true])) { why("got " + JSON.stringify(got) + ", want [false,true]"); return false; }
  return true;
});
r.print();
