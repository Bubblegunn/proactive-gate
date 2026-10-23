import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const now = new Date("2026-06-10T15:00:00Z");
const CUST = "+14155550100", ALERTS = "32665", PROMO = "32666";
const inb = (bot, body, from = CUST, to = PROMO) => bot.handleInbound({ from, to, body, now });
const can = (bot, phone = CUST, sender = PROMO) => bot.canSend({ phone, sender, now });
const r = new Report();
await r.crit("1 STOP and its standard synonyms opt the customer out", async (why) => {
  for (const w of ["STOP", "stop", "  Stop \n", "STOPALL", "Unsubscribe", "CANCEL", "end", "QUIT"]) {
    const bot = await load(dir);
    if ((await can(bot)).allowed !== true) { why("blocked before any message"); return false; }
    inb(bot, w);
    if (can(bot).allowed !== false) { why("not opted out by " + JSON.stringify(w)); return false; }
  }
  return true;
});
await r.crit("2 ordinary sentences containing a keyword do not opt out", async (why) => {
  for (const w of ["Please don't stop the order alerts", "stop by tomorrow?", "I can't stop laughing", "Stopping by at 5", "what does STOP do?", "cancel my 5pm order"]) {
    const bot = await load(dir);
    inb(bot, w);
    if (can(bot).allowed !== true) { why("opted out by " + JSON.stringify(w)); return false; }
  }
  return true;
});
await r.crit("3 STOP and HELP get a reply; HELP does not opt out", async (why) => {
  const bot = await load(dir);
  const h = inb(bot, "HELP");
  const stillOk = can(bot).allowed === true;
  const hl = inb(bot, "help");
  const s = inb(bot, "STOP");
  const ok = typeof h === "string" && h.trim() && typeof hl === "string" && hl.trim() && typeof s === "string" && s.trim() && stillOk && h !== s;
  if (!ok) why(JSON.stringify({ h, s, stillOk }));
  return ok;
});
await r.crit("4 START and UNSTOP resubscribe after STOP", async (why) => {
  for (const w of ["START", "unstop"]) {
    const bot = await load(dir);
    inb(bot, "STOP");
    const mid = can(bot).allowed;
    inb(bot, w);
    const end = can(bot).allowed;
    if (mid !== false || end !== true) { why(w + ": " + mid + "," + end); return false; }
  }
  return true;
});
await r.crit("5 phone numbers match across formats", async (why) => {
  const bot = await load(dir);
  inb(bot, "STOP");
  const a = ["+14155550100", "(415) 555-0100", "415-555-0100", "+1 415 555 0100", "4155550100"].map((p) => can(bot, p).allowed);
  const other = [can(bot, "(415) 555-0101").allowed, can(bot, "+14155550199").allowed];
  const ok = a.every((x) => x === false) && other.every((x) => x === true);
  if (!ok) why(JSON.stringify([a, other]));
  return ok;
});
await r.crit("6 an opt-out applies to the programme that received it", async (why) => {
  const bot = await load(dir);
  inb(bot, "STOP", CUST, PROMO);
  const ok = can(bot, CUST, PROMO).allowed === false && can(bot, CUST, ALERTS).allowed === true && can(bot, "+14155550177", PROMO).allowed === true;
  if (!ok) why([can(bot, CUST, PROMO).allowed, can(bot, CUST, ALERTS).allowed, can(bot, "+14155550177", PROMO).allowed].join(","));
  return ok;
});
r.print();
