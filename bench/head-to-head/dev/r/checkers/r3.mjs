import { load, Report } from "./lib.mjs";
const bot = await load(process.argv[2]);
const H = { "List-Unsubscribe": "<https://shop.example/u/abc123>, <mailto:unsub@shop.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
const M = (o = {}) => ({ kind: "marketing", headers: { ...H }, postalAddress: "12 Main Street, Springfield, IL 62701, USA", ...o });
const R = (o = {}) => ({ email: "a@example.com", country: "US", status: "active", marketingConsent: null, ...o });
const ev = (message, recipient) => bot.evaluateEmail({ message, recipient });
const al = (x) => !!x && x.allowed === true;
const bl = (x) => !!x && x.allowed === false;
const r = new Report();
await r.crit("1 marketing needs a List-Unsubscribe header", async (why) => {
  const a = [ev(M(), R()), ev(M({ headers: { "List-Unsubscribe-Post": H["List-Unsubscribe-Post"] } }), R()), ev(M({ headers: {} }), R())];
  const ok = al(a[0]) && bl(a[1]) && bl(a[2]);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("2 marketing needs the one-click header (RFC 8058)", async (why) => {
  const a = [ev(M({ headers: { "List-Unsubscribe": H["List-Unsubscribe"] } }), R()), ev(M({ headers: { ...H, "List-Unsubscribe-Post": "" } }), R())];
  const ok = bl(a[0]) && bl(a[1]);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("3 marketing needs a postal address", async (why) => {
  const a = [ev(M({ postalAddress: null }), R()), ev(M({ postalAddress: "   " }), R()), ev(M({ postalAddress: "" }), R())];
  const ok = a.every(bl);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
await r.crit("4 unsubscribed, complained and hard-bounced addresses are suppressed", async (why) => {
  const a = ["unsubscribed", "complained", "hard_bounce"].map((s) => ev(M(), R({ status: s, marketingConsent: true })));
  const soft = ev(M(), R({ status: "soft_bounce" }));
  const ok = a.every(bl) && al(soft);
  if (!ok) why(a.map((x) => x && x.allowed).join(",") + " soft=" + (soft && soft.allowed));
  return ok;
});
await r.crit("5 EU and UK recipients need recorded consent; US recipients with no answer may be mailed", async (why) => {
  const a = [];
  for (const c of ["DE", "FR", "GB", "IE"]) a.push(ev(M(), R({ country: c, marketingConsent: null })), ev(M(), R({ country: c, marketingConsent: false })));
  const consented = ["DE", "GB"].map((c) => ev(M(), R({ country: c, marketingConsent: true })));
  const us = [ev(M(), R({ country: "US", marketingConsent: null })), ev(M(), R({ country: "US", marketingConsent: true }))];
  const ok = a.every(bl) && consented.every(al) && us.every(al);
  if (!ok) why(JSON.stringify([a, consented, us].map((g) => g.map((x) => x && x.allowed))));
  return ok;
});
await r.crit("6 transactional email is not held back by marketing rules", async (why) => {
  const bare = M({ kind: "transactional", headers: {}, postalAddress: null });
  const a = [ev(bare, R()), ev(bare, R({ status: "unsubscribed" })), ev(bare, R({ country: "DE", marketingConsent: null })), ev(bare, R({ country: "GB", status: "unsubscribed", marketingConsent: false }))];
  const ok = a.every(al) && a.every((x) => typeof x.rule === "string" && x.rule);
  if (!ok) why(a.map((x) => x && x.allowed).join(","));
  return ok;
});
r.print();
