import { load, Report } from "./lib.mjs";
const bot = await load(process.argv[2]);
const r = new Report();
const now = new Date("2026-01-20T12:00:00Z");
const sec = (ms) => String(Math.floor(ms / 1000));
const ago = (h, m = 0) => sec(now.getTime() - (h * 60 + m) * 60000);
const msg = (type, last, optedIn = true) => ({ type, contact: { optedIn, lastInboundTimestamp: last } });
const ok = (x) => x && x.allowed === true && x.reason === null;
const no = (x) => x && x.allowed === false && typeof x.reason === "string" && x.reason.length > 0;
const d = (m) => bot.decideWhatsApp(m, now);

await r.crit("1 free text is allowed when the patient wrote within the last 24 hours", async (why) => {
  for (const last of [ago(0, 1), ago(5), ago(23, 59)]) {
    const x = d(msg("text", last));
    if (!ok(x)) { why(last + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("2 free text is blocked once the patient's last message is older than 24 hours", async (why) => {
  for (const last of [ago(24, 1), ago(30), ago(24 * 20)]) {
    const x = d(msg("text", last));
    if (!no(x)) { why(last + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("3 an approved template is allowed outside the 24-hour window", async (why) => {
  for (const last of [ago(30), ago(24 * 20), null]) {
    const x = d(msg("template", last));
    if (!ok(x)) { why(String(last) + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("4 a patient who has not opted in gets nothing, not even a template or an in-window text", async (why) => {
  for (const [t, last] of [["template", ago(30)], ["template", null], ["text", ago(1)], ["template", ago(1)]]) {
    const x = d(msg(t, last, false));
    if (!no(x)) { why(t + " " + last + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("5 free text to a patient who never wrote to us is blocked", async (why) => {
  for (const last of [null, undefined, ""]) {
    const x = d(msg("text", last));
    if (!no(x)) { why(JSON.stringify(last) + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("6 different rules give different reason codes", async (why) => {
  const optOut = d(msg("template", ago(1), false));
  const closed = d(msg("text", ago(30)));
  const never = d(msg("text", null));
  if (!no(optOut) || !no(closed) || !no(never)) { why(JSON.stringify([optOut, closed, never])); return false; }
  if (optOut.reason === closed.reason) { why("opt-in and window share a code"); return false; }
  if (optOut.reason === never.reason) { why("opt-in and no-inbound share a code"); return false; }
  return true;
});
r.print();
