import { load, Report } from "./lib.mjs";
const dir = process.argv[2];
const r = new Report();
const NOW = new Date("2026-06-10T15:00:00Z"); // Wednesday 11:00 in New York
const base = (x = {}) => ({ id: "u", email: "a@example.com", timeZone: "America/New_York", unsubscribedAt: null, lastBounce: null, lastDigestAt: null, ...x });
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const H = 3600e3, D = 24 * H;
async function ask(user, now = NOW) {
  const bot = await load(dir);
  const x = await bot.shouldSendDigest(user, now);
  if (!x || typeof x.allowed !== "boolean") throw new Error("no boolean allowed");
  return x;
}
async function pair(blocked, why, label) {
  const ctrl = await ask(base());
  if (!ctrl.allowed) { why("control person (nothing wrong) was refused: " + ctrl.reason); return false; }
  const x = await ask(blocked);
  if (x.allowed) { why(label + " was allowed"); return false; }
  if (typeof x.reason !== "string" || !x.reason.trim()) { why("refusal without reason"); return false; }
  return true;
}
await r.crit("1 unsubscribed people get nothing", (why) => pair(base({ unsubscribedAt: ago(2 * D) }), why, "unsubscribed person"));
await r.crit("2 a hard-bounced address is suppressed", (why) => pair(base({ lastBounce: { type: "hard", at: ago(3 * D) } }), why, "hard bounce"));
await r.crit("3 a soft bounce alone does not block the digest", async (why) => {
  const x = await ask(base({ lastBounce: { type: "soft", at: ago(1 * D) } }));
  if (!x.allowed) { why("soft bounce blocked: " + x.reason); return false; }
  return true;
});
await r.crit("4 a digest sent an hour ago blocks, one sent 8 days ago does not", async (why) => {
  const a = await ask(base({ lastDigestAt: ago(1 * H) })), b = await ask(base({ lastDigestAt: ago(8 * D) }));
  if (a.allowed) { why("digest from 1 hour ago did not block"); return false; }
  if (!b.allowed) { why("digest from 8 days ago blocked: " + b.reason); return false; }
  return true;
});
await r.crit("5 no invented time-of-day or day-of-week block (email has no contact window)", async (why) => {
  const cases = [["Sunday 03:00 New York", new Date("2026-06-14T07:00:00Z")], ["Saturday 23:30 New York", new Date("2026-06-21T03:30:00Z")],
    ["Christmas day noon", new Date("2026-12-25T17:00:00Z")], ["03:00 in Tokyo", new Date("2026-06-09T18:00:00Z")]];
  let ok = true;
  for (const [n, t] of cases) {
    const u = base({ timeZone: n.includes("Tokyo") ? "Asia/Tokyo" : "America/New_York" });
    const x = await ask(u, t);
    if (!x.allowed) { why(`${n} blocked: ${x.reason}`); ok = false; }
  }
  return ok;
});
await r.crit("6 missing or unknown optional fields do not block and do not throw", async (why) => {
  let ok = true;
  for (const [n, u] of [["no timeZone key", { id: "u", email: "a@b.co" }], ["null timeZone", base({ timeZone: null })], ["undefined fields", { id: "u", email: "a@b.co", timeZone: undefined, unsubscribedAt: undefined, lastBounce: undefined, lastDigestAt: undefined }]]) {
    try { const x = await ask(u); if (!x.allowed) { why(`${n} blocked: ${x.reason}`); ok = false; } }
    catch (e) { why(`${n} threw: ${String(e.message).slice(0, 60)}`); ok = false; }
  }
  return ok;
});
r.print();
