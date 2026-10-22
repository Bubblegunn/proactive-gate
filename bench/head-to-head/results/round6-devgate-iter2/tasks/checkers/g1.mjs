import { load, D, Report } from "./lib.mjs";
const dir = process.argv[2];
const bot = await load(dir);
const r = new Report();
const user = (tz, extra = {}) => ({ phone: "+13125550142", timeZone: tz, marketingConsent: true, optedOutAt: null, ...extra });
const mk = (to, kind = "marketing") => ({ kind, body: "Hello", to });
const chk = (to, iso, kind) => bot.checkSms(mk(to, kind), D(iso));
const ok = (x) => x && x.allowed === true;
const no = (x) => x && x.allowed === false && typeof x.reason === "string" && x.reason.length > 0;

// 2026-01-15: Chicago is CST (UTC-6)
await r.crit("1 marketing text at night is blocked with a reason", async (why) => {
  for (const iso of ["2026-01-15T05:30:00Z", "2026-01-15T09:00:00Z", "2026-01-15T13:59:00Z", "2026-01-16T03:30:00Z"]) {
    const x = chk(user("America/Chicago"), iso);
    if (!no(x)) { why(iso + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("2 daytime allowed, window is 08:00 up to 21:00 local", async (why) => {
  const cases = [["2026-01-15T14:00:00Z", true], ["2026-01-15T18:00:00Z", true], ["2026-01-16T02:59:00Z", true], ["2026-01-16T03:00:00Z", false], ["2026-01-15T13:59:00Z", false]];
  for (const [iso, exp] of cases) {
    const x = chk(user("America/Chicago"), iso);
    if (exp ? !ok(x) : !no(x)) { why(iso + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("3 uses the customer's own time zone, not the server's", async (why) => {
  const iso = "2026-07-01T15:30:00Z";
  const exp = { "America/New_York": true, "America/Los_Angeles": true, "Asia/Tokyo": false, "Pacific/Honolulu": false, "Europe/London": true };
  for (const [tz, e] of Object.entries(exp)) {
    const x = chk(user(tz), iso);
    if (e ? !ok(x) : !no(x)) { why(tz + " -> " + JSON.stringify(x)); return false; }
  }
  return true;
});
await r.crit("4 follows daylight saving changes", async (why) => {
  const a = chk(user("America/Los_Angeles"), "2026-03-08T15:30:00Z"); // PDT 08:30
  const b = chk(user("America/Los_Angeles"), "2026-03-08T14:30:00Z"); // PDT 07:30
  const c = chk(user("America/Los_Angeles"), "2026-11-01T15:30:00Z"); // PST 07:30
  const d = chk(user("America/Los_Angeles"), "2026-11-01T16:30:00Z"); // PST 08:30
  if (!ok(a) || !no(b) || !no(c) || !ok(d)) { why(JSON.stringify([a, b, c, d])); return false; }
  return true;
});
await r.crit("5 no consent or STOP blocks marketing, with a code different from quiet hours", async (why) => {
  const noon = "2026-01-15T18:00:00Z";
  const a = chk(user("America/Chicago", { marketingConsent: false }), noon);
  const b = chk(user("America/Chicago", { optedOutAt: "2026-01-10T12:00:00Z" }), noon);
  const q = chk(user("America/Chicago"), "2026-01-15T05:30:00Z");
  if (!no(a) || !no(b) || !no(q)) { why(JSON.stringify([a, b, q])); return false; }
  if (a.reason === q.reason || b.reason === q.reason) { why("same reason code as quiet hours"); return false; }
  return true;
});
await r.crit("6 transactional text is allowed at night", async (why) => {
  for (const iso of ["2026-01-15T05:30:00Z", "2026-01-16T04:00:00Z"]) {
    const x = chk(user("America/Chicago"), iso, "transactional");
    if (!ok(x) || x.reason !== null) { why(JSON.stringify(x)); return false; }
  }
  const y = chk(user("America/Chicago", { marketingConsent: false }), "2026-01-15T05:30:00Z", "transactional");
  if (!ok(y)) { why("transactional blocked for user without marketing consent: " + JSON.stringify(y)); return false; }
  return true;
});
r.print();
