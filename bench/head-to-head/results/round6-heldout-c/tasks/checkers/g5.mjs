import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const T0 = Date.parse("2026-06-01T09:00:00Z");
const at = (h) => new Date(T0 + h * 3600000);

await r.crit("1 free text is allowed within 24 hours of the customer's last message", async (why) => {
  const bot = await load(dir);
  bot.onInbound("u", "hi, my bill looks wrong", at(0));
  const a = bot.check("u", "freeform", at(1));
  const b = bot.check("u", "freeform", at(23));
  why(JSON.stringify([a, b]));
  return a.allowed === true && a.rule === null && b.allowed === true;
});
await r.crit("2 free text is held after 24 hours or for a customer who never wrote, templates still go", async (why) => {
  const bot = await load(dir);
  bot.onInbound("u", "hi", at(0));
  const a = bot.check("u", "freeform", at(24.5));
  const b = bot.check("u", "template", at(24.5));
  const c = bot.check("nobody", "freeform", at(1));
  why(JSON.stringify([a, b, c]));
  return a.allowed === false && typeof a.rule === "string" && a.rule.length > 0 && b.allowed === true && c.allowed === false && typeof c.rule === "string";
});
await r.crit("3 a newer customer message restarts the 24 hour window", async (why) => {
  const bot = await load(dir);
  bot.onInbound("u", "hi", at(0));
  bot.onInbound("u", "any news?", at(20));
  const a = bot.check("u", "freeform", at(40));
  const b = bot.check("u", "freeform", at(45));
  why(JSON.stringify([a, b]));
  return a.allowed === true && b.allowed === false;
});
await r.crit("4 a stop request blocks every kind of message, however it is typed", async (why) => {
  const bad = [];
  for (const txt of ["STOP", " stop ", "Stop.", "stop!", "UNSUBSCRIBE", "Quit"]) {
    const bot = await load(dir);
    bot.onInbound("u", "hello", at(0));
    bot.onInbound("u", txt, at(1));
    const f = bot.check("u", "freeform", at(2));
    const t = bot.check("u", "template", at(2));
    const t2 = bot.check("u", "template", at(30));
    if (f.allowed || t.allowed || t2.allowed || typeof f.rule !== "string" || typeof t.rule !== "string") bad.push(txt);
  }
  why("not blocked: " + JSON.stringify(bad));
  return bad.length === 0;
});
await r.crit("5 a start request lifts the stop", async (why) => {
  const bot = await load(dir);
  bot.onInbound("u", "hello", at(0));
  bot.onInbound("u", "STOP", at(1));
  const a = bot.check("u", "template", at(2));
  bot.onInbound("u", " start ", at(3));
  const b = bot.check("u", "template", at(4));
  const other = bot.check("v", "template", at(4));
  why(JSON.stringify([a, b]));
  return a.allowed === false && b.allowed === true && b.rule === null;
});
await r.crit("6 ordinary sentences that contain stop are not a stop request", async (why) => {
  const bad = [];
  for (const txt of ["please don't stop the delivery", "stopwatch app is broken", "I will stop by your shop tomorrow", "STOP charging me twice for the router"]) {
    const bot = await load(dir);
    bot.onInbound("u", txt, at(0));
    const f = bot.check("u", "freeform", at(1));
    const t = bot.check("u", "template", at(1));
    if (!f.allowed || !t.allowed) bad.push(txt);
  }
  why("wrongly blocked: " + JSON.stringify(bad));
  return bad.length === 0;
});
r.print();
