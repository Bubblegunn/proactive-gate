// Checker for H6 (check: legal gate for SMS and email marketing, synchronous). usage: node h6.mjs <dir containing bot.mjs>
//
// Rules the expectations follow (from prompts/h6.txt):
//   US sms: 08:00 <= local < 21:00 (47 CFR 64.1200). Needs a valid IANA time zone.
//   KR sms or email: consents.ad. KR sms also needs consents.night from 21:00 up to 08:00 local (email exempt).
//   IN sms: consents.promotional, plus the band flag for the local time: 00:00-06:00 band00to06,
//           06:00-08:00 band06to08, 08:00-10:00 band08to10, 21:00-24:00 band21to24, 10:00-21:00 none.
//           Needs a valid time zone (UTC+5:30, not whole hours).
//   DE and FR, email and sms: consents.marketing, or user.existingCustomer === true.
//   Any other country: allowed, sources [] (US email: allowed, sources any allowlisted array).
//
// Time-zone clock readings used for the expectations (derived with Intl.DateTimeFormat, cross-checked outside this file):
//   US (America/New_York): 2026-06-15 is EDT (UTC-4). 2026-03-08 02:00 EST -> EDT at 07:00Z. 2026-11-01 02:00 EDT -> EST at 06:00Z.
//   KR (Asia/Seoul, UTC+9, no DST). IN (Asia/Kolkata, UTC+5:30, no DST). DE/FR: CEST/CEST (UTC+2) on 2026-06-15.
// Each "allowed" or "refused" expectation below states its local clock in a comment.
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];

// Allowlist: the URL must be https and its hostname must be one of these, or end with one of the suffixes.
// law.cornell.edu is tolerated on purpose: it is the standard public text of 47 CFR 64.1200, although it is a
// university site and not the legislator's or regulator's own site. Remove it if that tolerance is withdrawn.
const OFFICIAL_HOSTS = [
  "law.cornell.edu", "www.law.cornell.edu",
  "ecfr.gov", "www.ecfr.gov",
  "govinfo.gov", "www.govinfo.gov",
  "congress.gov", "www.congress.gov",
  "uscode.house.gov",
  "fcc.gov", "www.fcc.gov",
  "law.go.kr", "www.law.go.kr",
  "trai.gov.in", "www.trai.gov.in",
  "eur-lex.europa.eu",
  "europa.eu",
  "legifrance.gouv.fr", "www.legifrance.gouv.fr",
  "gesetze-im-internet.de", "www.gesetze-im-internet.de",
  "federalregister.gov", "www.federalregister.gov",
  "egazette.nic.in", "indiacode.nic.in",
  "elaw.klri.re.kr",
  "www.moleg.go.kr",
];
const OFFICIAL_SUFFIXES = [".europa.eu", ".gov.in", ".nic.in", ".go.kr"];

const hostOk = (host) => OFFICIAL_HOSTS.includes(host) || OFFICIAL_SUFFIXES.some((s) => host.endsWith(s));
const officialUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && hostOk(x.hostname);
  } catch {
    return false;
  }
};

let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = { check: () => { throw e; } };
}
const r = new Report();

const U = (fields) => {
  const user = { id: "u1" };
  return Object.assign(user, fields);
};
const NY = "America/New_York";
const SEOUL = "Asia/Seoul";
const KOLKATA = "Asia/Kolkata";
const BERLIN = "Europe/Berlin";
const PARIS = "Europe/Paris";

// Source host expectations per country (criterion 5 only): at least one URL must be on a host valid for the country.
// DE and FR accept any EU official host (*.europa.eu) or their own national official host.
const HOST = {
  US: /(^|\.)(cornell\.edu|ecfr\.gov|govinfo\.gov|fcc\.gov|congress\.gov|uscode\.house\.gov|federalregister\.gov)$/,
  KR: /(\.go\.kr|^elaw\.klri\.re\.kr)$/,
  IN: /(\.gov\.in|\.nic\.in)$/,
  DE: /(^|\.)(europa\.eu|gesetze-im-internet\.de)$/,
  FR: /(^|\.)(europa\.eu|legifrance\.gouv\.fr)$/,
};

// Case shape: { name, user, message, at, want (true|false), reasonRe? (only for the time zone refusals), src: "need"|"empty"|"any"|"none", host? }
const sms = (channel = "sms") => ({ channel, kind: "marketing" });
const C = (name, user, message, at, want, extra = {}) => ({ name, user, message, at, want, src: "none", ...extra });

// ---- criterion 1: US SMS window and DST edges, US email ----
const usUser = U({ country: "US", timezone: NY, consents: {} });
const group1 = [
  C("US sms 2026-06-15 12:00Z = 08:00 EDT", usUser, sms(), "2026-06-15T12:00:00Z", true, { src: "need", host: HOST.US }),
  C("US sms 2026-06-15 11:59Z = 07:59 EDT", usUser, sms(), "2026-06-15T11:59:00Z", false, { src: "need", host: HOST.US }),
  C("US sms 2026-06-16 00:59Z = 20:59 EDT", usUser, sms(), "2026-06-16T00:59:00Z", true, { src: "need", host: HOST.US }),
  C("US sms 2026-06-16 01:00Z = 21:00 EDT", usUser, sms(), "2026-06-16T01:00:00Z", false, { src: "need", host: HOST.US }),
  C("US sms 2026-03-08 11:59Z = 07:59 EDT (DST started at 07:00Z)", usUser, sms(), "2026-03-08T11:59:00Z", false, { src: "need", host: HOST.US }),
  C("US sms 2026-03-08 12:00Z = 08:00 EDT", usUser, sms(), "2026-03-08T12:00:00Z", true, { src: "need", host: HOST.US }),
  C("US sms 2026-11-01 12:59Z = 07:59 EST (DST ends at 06:00Z)", usUser, sms(), "2026-11-01T12:59:00Z", false, { src: "need", host: HOST.US }),
  C("US sms 2026-11-01 13:00Z = 08:00 EST", usUser, sms(), "2026-11-01T13:00:00Z", true, { src: "need", host: HOST.US }),
  C("US email 2026-06-15 05:00Z = 01:00 EDT, no window", usUser, sms("email"), "2026-06-15T05:00:00Z", true, { src: "any" }),
];

// ---- criterion 2: KR consent and night rules ----
const krUser = U({ country: "KR", timezone: SEOUL, consents: {} });
const kr = (consents) => U({ country: "KR", timezone: SEOUL, consents });
const group2 = [
  C("KR sms 2026-06-15 03:00Z = 12:00 KST, no consents", krUser, sms(), "2026-06-15T03:00:00Z", false, { src: "need", host: HOST.KR }),
  C("KR sms 03:00Z = 12:00 KST, ad only", kr({ ad: true }), sms(), "2026-06-15T03:00:00Z", true, { src: "need", host: HOST.KR }),
  C("KR sms 13:00Z = 22:00 KST, ad only (night)", kr({ ad: true }), sms(), "2026-06-15T13:00:00Z", false, { src: "need", host: HOST.KR }),
  C("KR sms 13:00Z = 22:00 KST, ad and night", kr({ ad: true, night: true }), sms(), "2026-06-15T13:00:00Z", true, { src: "need", host: HOST.KR }),
  C("KR sms 2026-06-14 22:59Z = 07:59 KST, ad only (night)", kr({ ad: true }), sms(), "2026-06-14T22:59:00Z", false, { src: "need", host: HOST.KR }),
  C("KR sms 2026-06-14 23:00Z = 08:00 KST, ad only", kr({ ad: true }), sms(), "2026-06-14T23:00:00Z", true, { src: "need", host: HOST.KR }),
  C("KR sms 2026-06-15 11:59Z = 20:59 KST, ad only", kr({ ad: true }), sms(), "2026-06-15T11:59:00Z", true, { src: "need", host: HOST.KR }),
  C("KR sms 2026-06-15 12:00Z = 21:00 KST, ad only (night)", kr({ ad: true }), sms(), "2026-06-15T12:00:00Z", false, { src: "need", host: HOST.KR }),
  C("KR email 13:00Z = 22:00 KST, ad only (email exempt from night)", kr({ ad: true }), sms("email"), "2026-06-15T13:00:00Z", true, { src: "need", host: HOST.KR }),
  C("KR email 13:00Z, no consents", kr({}), sms("email"), "2026-06-15T13:00:00Z", false, { src: "need", host: HOST.KR }),
];

// ---- criterion 3: IN promotional and time bands ----
const inUser = (consents) => U({ country: "IN", timezone: KOLKATA, consents });
const group3 = [
  C("IN sms 06:00Z = 11:30 IST, promotional", inUser({ promotional: true }), sms(), "2026-06-15T06:00:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 06:00Z = 11:30 IST, no consents", inUser({}), sms(), "2026-06-15T06:00:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 2026-06-14 23:30Z = 05:00 IST, promotional only (band00to06)", inUser({ promotional: true }), sms(), "2026-06-14T23:30:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 23:30Z = 05:00 IST, with band00to06", inUser({ promotional: true, band00to06: true }), sms(), "2026-06-14T23:30:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 01:45Z = 07:15 IST, promotional only (band06to08)", inUser({ promotional: true }), sms(), "2026-06-15T01:45:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 01:45Z = 07:15 IST, with band06to08", inUser({ promotional: true, band06to08: true }), sms(), "2026-06-15T01:45:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 03:30Z = 09:00 IST, promotional only (band08to10)", inUser({ promotional: true }), sms(), "2026-06-15T03:30:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 03:30Z = 09:00 IST, with band08to10", inUser({ promotional: true, band08to10: true }), sms(), "2026-06-15T03:30:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 03:30Z = 09:00 IST, band06to08 only (wrong band)", inUser({ promotional: true, band06to08: true }), sms(), "2026-06-15T03:30:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 16:30Z = 22:00 IST, promotional only (band21to24)", inUser({ promotional: true }), sms(), "2026-06-15T16:30:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 16:30Z = 22:00 IST, with band21to24", inUser({ promotional: true, band21to24: true }), sms(), "2026-06-15T16:30:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 04:29Z = 09:59 IST, promotional only (band08to10)", inUser({ promotional: true }), sms(), "2026-06-15T04:29:00Z", false, { src: "need", host: HOST.IN }),
  C("IN sms 04:30Z = 10:00 IST, promotional only", inUser({ promotional: true }), sms(), "2026-06-15T04:30:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 15:29Z = 20:59 IST, promotional only", inUser({ promotional: true }), sms(), "2026-06-15T15:29:00Z", true, { src: "need", host: HOST.IN }),
  C("IN sms 15:30Z = 21:00 IST, promotional only (band21to24)", inUser({ promotional: true }), sms(), "2026-06-15T15:30:00Z", false, { src: "need", host: HOST.IN }),
];

// ---- criterion 4: DE and FR marketing consent ----
const deUser = (consents, existingCustomer) => U({ country: "DE", timezone: BERLIN, consents, ...(existingCustomer === undefined ? {} : { existingCustomer }) });
const frUser = (consents, existingCustomer) => U({ country: "FR", timezone: PARIS, consents, ...(existingCustomer === undefined ? {} : { existingCustomer }) });
const EU_AT = "2026-06-15T12:00:00Z";
const group4 = [
  C("DE email, no consents", deUser({}), sms("email"), EU_AT, false, { src: "need", host: HOST.DE }),
  C("DE email, marketing", deUser({ marketing: true }), sms("email"), EU_AT, true, { src: "need", host: HOST.DE }),
  C("DE email, existingCustomer true, no consents", deUser({}, true), sms("email"), EU_AT, true, { src: "need", host: HOST.DE }),
  C("DE email, existingCustomer false, no consents", deUser({}, false), sms("email"), EU_AT, false, { src: "need", host: HOST.DE }),
  C("DE sms, no consents", deUser({}), sms("sms"), EU_AT, false, { src: "need", host: HOST.DE }),
  C("DE sms, marketing", deUser({ marketing: true }), sms("sms"), EU_AT, true, { src: "need", host: HOST.DE }),
  C("FR email, no consents", frUser({}), sms("email"), EU_AT, false, { src: "need", host: HOST.FR }),
  C("FR email, marketing", frUser({ marketing: true }), sms("email"), EU_AT, true, { src: "need", host: HOST.FR }),
  C("FR email, existingCustomer true, no consents", frUser({}, true), sms("email"), EU_AT, true, { src: "need", host: HOST.FR }),
  C("FR sms, no consents", frUser({}), sms("sms"), EU_AT, false, { src: "need", host: HOST.FR }),
  C("FR sms, existingCustomer true", frUser({}, true), sms("sms"), EU_AT, true, { src: "need", host: HOST.FR }),
];

// ---- criterion 5 extras: other countries (sources must be empty) ----
const other = [
  C("BR sms 03:00 local (06:00Z), no consents", U({ country: "BR", timezone: "America/Sao_Paulo", consents: {} }), sms("sms"), "2026-06-15T06:00:00Z", true, { src: "empty" }),
  C("BR email 03:00 local (06:00Z), no consents", U({ country: "BR", timezone: "America/Sao_Paulo", consents: {} }), sms("email"), "2026-06-15T06:00:00Z", true, { src: "empty" }),
  C("TR sms 03:00 local (00:00Z), no consents", U({ country: "TR", timezone: "Europe/Istanbul", consents: {} }), sms("sms"), "2026-06-15T00:00:00Z", true, { src: "empty" }),
  C("TR email 03:00 local (00:00Z), no consents", U({ country: "TR", timezone: "Europe/Istanbul", consents: {} }), sms("email"), "2026-06-15T00:00:00Z", true, { src: "empty" }),
  C("JP sms 03:00 local (2026-06-14 18:00Z), no consents", U({ country: "JP", timezone: "Asia/Tokyo", consents: {} }), sms("sms"), "2026-06-14T18:00:00Z", true, { src: "empty" }),
  C("JP email 03:00 local (2026-06-14 18:00Z), no consents", U({ country: "JP", timezone: "Asia/Tokyo", consents: {} }), sms("email"), "2026-06-14T18:00:00Z", true, { src: "empty" }),
];

// ---- criterion 6: time zone ----
const group6 = [
  C("US sms, timezone missing", U({ country: "US", consents: {} }), sms(), EU_AT, false, { reasonRe: /time zone/i }),
  C("US sms, timezone Mars/Olympus", U({ country: "US", timezone: "Mars/Olympus", consents: {} }), sms(), EU_AT, false, { reasonRe: /time zone/i }),
  C("IN sms, promotional, timezone invalid", U({ country: "IN", timezone: "Mars/Olympus", consents: { promotional: true } }), sms(), EU_AT, false, { reasonRe: /time zone/i }),
  C("KR sms, ad, timezone missing", U({ country: "KR", consents: { ad: true } }), sms(), EU_AT, false, { reasonRe: /time zone/i }),
  C("BR sms, timezone missing", U({ country: "BR", consents: {} }), sms(), EU_AT, true, { src: "empty" }),
];

// ---------- verdicts ----------
const run = (c) => {
  try {
    return bot.check({ user: c.user, message: c.message, now: new Date(c.at) });
  } catch (e) {
    return { threw: String((e && e.message) || e).slice(0, 150) };
  }
};

// Returns null when the result matches the case, otherwise a short reason.
function verdict(c, res) {
  if (res && res.threw) return `threw ${res.threw}`;
  if (res && typeof res.then === "function") return "returned a promise (check must be synchronous)";
  if (!res || typeof res !== "object") return "result is not an object";
  if (typeof res.allowed !== "boolean") return "allowed is not a boolean";
  if (res.allowed !== c.want) return `want allowed=${c.want}, got ${res.allowed} (reason ${JSON.stringify(res.reason)})`;
  if (c.want) {
    if (res.reason !== null) return `reason must be null when allowed, got ${JSON.stringify(res.reason)}`;
  } else {
    if (typeof res.reason !== "string" || res.reason.length === 0) return "refusal needs a non-empty reason";
    if (c.reasonRe && !c.reasonRe.test(res.reason)) return `reason ${JSON.stringify(res.reason)} does not match ${c.reasonRe}`;
  }
  return null;
}

// Returns null when the sources match the case, otherwise a short reason.
function sourcesVerdict(c, res) {
  const s = res.sources;
  if (!Array.isArray(s)) return "sources is not an array";
  for (const u of s) if (typeof u !== "string" || !officialUrl(u)) return `source not https on the allowlist: ${JSON.stringify(u)}`;
  if (c.src === "need" && s.length === 0) return "sources must be non-empty";
  if (c.src === "empty" && s.length !== 0) return `sources must be empty, got ${s.length}`;
  if (c.src === "need" && c.host && !s.some((u) => c.host.test(new URL(u).hostname))) return `no source on the required host ${c.host}`;
  return null;
}

// criteria 1 to 4: verdicts only
const expectCases = (list, note) => {
  let ok = true;
  for (const c of list) {
    const why = verdict(c, run(c));
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
};

// criterion 5: every case of groups 1 to 4 (refusals and the listed allowed cases) plus the other-country cases,
// verdict and sources both checked
const sourceCases = [...group1, ...group2, ...group3, ...group4, ...other].filter(
  (c) => c.src === "need" || c.src === "empty" || c.src === "any",
);

await r.crit("1 US sms window and DST edges: 08:00 to 21:00 local, US email has no window", (note) => expectCases(group1, note));
await r.crit("2 KR consent and night rules: ad for sms and email, night for sms only", (note) => expectCases(group2, note));
await r.crit("3 IN promotional and the four time bands, each flag unlocks only its own band", (note) => expectCases(group3, note));
await r.crit("4 DE and FR marketing consent or existing customer, sms same as email", (note) => expectCases(group4, note));
await r.crit("5 sources: refusals and listed allowed cases cite an official host, other countries cite none", (note) => {
  let ok = true;
  for (const c of sourceCases) {
    const res = run(c);
    const why = res && typeof res === "object" && !res.threw && typeof res.then !== "function" ? sourcesVerdict(c, res) : "no usable result";
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
});
await r.crit("6 time zone: US sms, IN sms and KR sms refuse without a valid zone; BR sms with no zone is not refused", (note) => {
  let ok = expectCases(group6, note);
  for (const c of group6) {
    if (c.src === "none") continue;
    const res = run(c);
    const why = res && !res.threw && typeof res.then !== "function" ? sourcesVerdict(c, res) : "no usable result";
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
});

r.print();
