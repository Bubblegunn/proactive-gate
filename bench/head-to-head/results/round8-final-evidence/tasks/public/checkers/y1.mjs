// Checker for Y1 (check: US federal and state contact windows, GB and EU consent, KR consent and night rule,
// sources, time zones; synchronous). usage: node y1.mjs <dir containing bot.mjs>
//
// Expected instants. Each literal names its local clock in a comment. They were derived by hand from the offsets
// below and cross-checked with a separate Intl.DateTimeFormat script (not copied from any reference):
//   America/New_York: EDT (UTC-4) from 2026-03-08 07:00Z until 2026-11-01 06:00Z, EST (UTC-5) otherwise.
//   America/Chicago: CDT (UTC-5) in June. Europe/London BST and Europe/Dublin IST are UTC+1 in June.
//   Other EU zones (Berlin, Paris, Madrid, Rome, Amsterdam, Stockholm, Warsaw) CEST, UTC+2 in June.
//   Asia/Seoul UTC+9, America/Sao_Paulo UTC-3, Europe/Istanbul UTC+3, Asia/Tokyo UTC+9.
// A holdUntil is the first moment at which every window that refuses the message is open. All windows start at
// 08:00 local, so it is the next 08:00 local. Consent refusals have holdUntil null.
import { Report, load } from "./lib.mjs";

const dir = process.argv[2];
let bot;
try {
  bot = await load(dir);
} catch (e) {
  bot = {
    check: () => {
      throw e;
    },
  };
}
const r = new Report();

// Official hosts. A source URL must be https. Its hostname must equal an entry of OFFICIAL_HOSTS, or equal a suffix's
// bare domain, or end with the suffix on a dot boundary. So "ecfr.gov.example.com" and "xoscn.net" are refused.
const OFFICIAL_HOSTS = [
  "gesetze-im-internet.de", "www.gesetze-im-internet.de",
  "legifrance.gouv.fr",
  "boe.es", "www.boe.es",
  "irishstatutebook.ie", "www.irishstatutebook.ie",
  "legislation.gov.uk", "www.legislation.gov.uk",
  // ICO is the UK data protection regulator. The GB fit rule names it, so it is allowed as a source.
  "ico.org.uk", "www.ico.org.uk",
  "eur-lex.europa.eu",
  "elaw.klri.re.kr",
  "oscn.net", "www.oscn.net",
  "flsenate.gov",
  "leg.state.fl.us", "www.leg.state.fl.us",
];
const OFFICIAL_SUFFIXES = [".gov", ".gov.uk", ".gouv.fr", ".gov.in", ".nic.in", ".go.kr", ".europa.eu"];

const hostOk = (host) =>
  OFFICIAL_HOSTS.includes(host) || OFFICIAL_SUFFIXES.some((x) => host === x.slice(1) || host.endsWith(x));
const officialUrl = (u) => {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && hostOk(x.hostname);
  } catch {
    return false;
  }
};

// Jurisdiction fit: criterion 5 needs at least one source whose host fits the case's jurisdiction.
const EU_NATIONAL = [
  "gesetze-im-internet.de", "www.gesetze-im-internet.de",
  "legifrance.gouv.fr",
  "boe.es", "www.boe.es",
  "irishstatutebook.ie", "www.irishstatutebook.ie",
];
const HOST = {
  US: (h) => h.endsWith(".gov") || h === "oscn.net",
  GB: (h) =>
    h.endsWith(".gov.uk") || h === "legislation.gov.uk" || h === "www.legislation.gov.uk" ||
    h === "ico.org.uk" || h === "www.ico.org.uk" || h === "eur-lex.europa.eu" || h === "europa.eu" || h.endsWith(".europa.eu"),
  EU: (h) => h === "eur-lex.europa.eu" || h === "europa.eu" || h.endsWith(".europa.eu") || EU_NATIONAL.includes(h),
  KR: (h) => h.endsWith(".go.kr") || h === "elaw.klri.re.kr",
};

const isoUtc = (s) =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(s) && !Number.isNaN(Date.parse(s));

const NY = "America/New_York";
const CHI = "America/Chicago";
const SEOUL = "Asia/Seoul";

const U = (fields) => ({ id: "u1", ...fields });
// Case shape: K(name, user, channel, iso instant, want allowed, src, extra)
//   src: "need" = non-empty official sources (plus extra.host if given), "empty" = [], "any" = official URLs only
//   extra: hold (null, or an ISO UTC string to match), reasonRe, host
const K = (name, user, channel, iso, want, src, extra = {}) => ({
  name,
  user,
  message: { channel, kind: "marketing" },
  at: iso,
  want,
  src,
  ...extra,
});

// ---- criterion 1: US federal window (state undefined, America/New_York), sms, call and email ----
const usU = U({ country: "US", timezone: NY, consents: {} });
const group1 = [
  K("US sms 2026-06-15 07:59 EDT", usU, "sms", "2026-06-15T11:59:00Z", false, "need", { host: HOST.US, hold: "2026-06-15T12:00:00Z" }),
  K("US sms 2026-06-15 08:00 EDT", usU, "sms", "2026-06-15T12:00:00Z", true, "need", { host: HOST.US }),
  // 20:59 EDT = 00:59Z on 06-16 (UTC-4)
  K("US sms 2026-06-15 20:59 EDT", usU, "sms", "2026-06-16T00:59:00Z", true, "need", { host: HOST.US }),
  // 21:00 EDT = 01:00Z on 06-16
  K("US sms 2026-06-15 21:00 EDT", usU, "sms", "2026-06-16T01:00:00Z", false, "need", { host: HOST.US, hold: "2026-06-16T12:00:00Z" }),
  // DST starts 2026-03-08 07:00Z. 07:59 EDT = 11:59Z.
  K("US sms 2026-03-08 07:59 EDT (DST day)", usU, "sms", "2026-03-08T11:59:00Z", false, "need", { host: HOST.US, hold: "2026-03-08T12:00:00Z" }),
  K("US sms 2026-03-08 08:00 EDT (DST day)", usU, "sms", "2026-03-08T12:00:00Z", true, "need", { host: HOST.US }),
  // 20:59 EDT on 03-08 = 00:59Z on 03-09
  K("US sms 2026-03-08 20:59 EDT (DST day)", usU, "sms", "2026-03-09T00:59:00Z", true, "need", { host: HOST.US }),
  // 21:00 EDT on 03-08 = 01:00Z on 03-09
  K("US sms 2026-03-08 21:00 EDT (DST day)", usU, "sms", "2026-03-09T01:00:00Z", false, "need", { host: HOST.US, hold: "2026-03-09T12:00:00Z" }),
  // DST ends 2026-11-01 06:00Z. 07:59 EST = 12:59Z.
  K("US sms 2026-11-01 07:59 EST (DST day)", usU, "sms", "2026-11-01T12:59:00Z", false, "need", { host: HOST.US, hold: "2026-11-01T13:00:00Z" }),
  K("US sms 2026-11-01 08:00 EST (DST day)", usU, "sms", "2026-11-01T13:00:00Z", true, "need", { host: HOST.US }),
  // 20:59 EST on 11-01 = 01:59Z on 11-02
  K("US sms 2026-11-01 20:59 EST (DST day)", usU, "sms", "2026-11-02T01:59:00Z", true, "need", { host: HOST.US }),
  // 21:00 EST on 11-01 = 02:00Z on 11-02
  K("US sms 2026-11-01 21:00 EST (DST day)", usU, "sms", "2026-11-02T02:00:00Z", false, "need", { host: HOST.US, hold: "2026-11-02T13:00:00Z" }),
  // DST hold cases. A hold computed with the offset at `now` (EST before 07:00Z on 03-08) is an hour off.
  // 2026-03-08T02:00Z is 21:00 EST on 03-07. The next 08:00 is 08:00 EDT on 03-08 = 12:00Z.
  K("US sms 2026-03-07 21:00 EST (hold crosses spring DST)", usU, "sms", "2026-03-08T02:00:00Z", false, "need", { host: HOST.US, hold: "2026-03-08T12:00:00Z" }),
  // 2026-11-01T01:00Z is 21:00 EDT on 10-31. The next 08:00 is 08:00 EST on 11-01 = 13:00Z.
  K("US sms 2026-10-31 21:00 EDT (hold crosses fall DST)", usU, "sms", "2026-11-01T01:00:00Z", false, "need", { host: HOST.US, hold: "2026-11-01T13:00:00Z" }),
  K("US call 2026-06-15 07:59 EDT", usU, "call", "2026-06-15T11:59:00Z", false, "need", { host: HOST.US, hold: "2026-06-15T12:00:00Z" }),
  K("US call 2026-06-15 08:00 EDT", usU, "call", "2026-06-15T12:00:00Z", true, "need", { host: HOST.US }),
  K("US call 2026-06-15 21:00 EDT", usU, "call", "2026-06-16T01:00:00Z", false, "need", { host: HOST.US, hold: "2026-06-16T12:00:00Z" }),
  // US email has no window: 01:00 EDT and 22:00 EDT are both allowed, with no sources
  K("US email 2026-06-15 01:00 EDT, no window", usU, "email", "2026-06-15T05:00:00Z", true, "empty"),
  K("US email 2026-06-15 22:00 EDT, no window", usU, "email", "2026-06-16T02:00:00Z", true, "empty"),
];

// ---- criterion 2: state windows FL, OK, MD (sms and call 08:00 to 20:00 local); TX has federal only ----
const flU = U({ country: "US", state: "FL", timezone: NY, consents: {} });
const okU = U({ country: "US", state: "OK", timezone: CHI, consents: {} });
const mdU = U({ country: "US", state: "MD", timezone: NY, consents: {} });
const txU = U({ country: "US", state: "TX", timezone: CHI, consents: {} });
const group2 = [
  // FL, June 15 EDT. 19:59 EDT = 23:59Z; 20:00 EDT = 00:00Z on 06-16.
  K("FL sms 19:59 EDT", flU, "sms", "2026-06-15T23:59:00Z", true, "need", { host: HOST.US }),
  K("FL sms 20:00 EDT", flU, "sms", "2026-06-16T00:00:00Z", false, "need", { hold: "2026-06-16T12:00:00Z" }),
  K("FL sms 20:30 EDT (federal would allow)", flU, "sms", "2026-06-16T00:30:00Z", false, "need", { hold: "2026-06-16T12:00:00Z" }),
  K("FL sms 07:59 EDT", flU, "sms", "2026-06-15T11:59:00Z", false, "need", { hold: "2026-06-15T12:00:00Z" }),
  K("FL sms 08:00 EDT", flU, "sms", "2026-06-15T12:00:00Z", true, "need", { host: HOST.US }),
  K("FL call 20:00 EDT", flU, "call", "2026-06-16T00:00:00Z", false, "need", { hold: "2026-06-16T12:00:00Z" }),
  // FL email is outside the state rule and the federal rule: allowed, no sources. 21:30 EDT = 01:30Z on 06-16.
  K("FL email 21:30 EDT", flU, "email", "2026-06-16T01:30:00Z", true, "empty"),
  // OK, June 15 CDT (UTC-5). 19:59 CDT = 00:59Z on 06-16; 20:00 CDT = 01:00Z on 06-16; 07:59 CDT = 12:59Z.
  K("OK sms 19:59 CDT", okU, "sms", "2026-06-16T00:59:00Z", true, "need", { host: HOST.US }),
  K("OK sms 20:00 CDT", okU, "sms", "2026-06-16T01:00:00Z", false, "need", { hold: "2026-06-16T13:00:00Z" }),
  K("OK sms 07:59 CDT", okU, "sms", "2026-06-15T12:59:00Z", false, "need", { hold: "2026-06-15T13:00:00Z" }),
  K("OK sms 08:00 CDT", okU, "sms", "2026-06-15T13:00:00Z", true, "need", { host: HOST.US }),
  K("OK call 20:00 CDT", okU, "call", "2026-06-16T01:00:00Z", false, "need", { hold: "2026-06-16T13:00:00Z" }),
  // MD uses America/New_York, same as FL.
  K("MD sms 19:59 EDT", mdU, "sms", "2026-06-15T23:59:00Z", true, "need", { host: HOST.US }),
  K("MD sms 20:00 EDT", mdU, "sms", "2026-06-16T00:00:00Z", false, "need", { hold: "2026-06-16T12:00:00Z" }),
  K("MD sms 07:59 EDT", mdU, "sms", "2026-06-15T11:59:00Z", false, "need", { hold: "2026-06-15T12:00:00Z" }),
  // TX is not a listed state: 20:30 CDT = 01:30Z on 06-16 is allowed by the federal window alone.
  K("TX sms 20:30 CDT (federal only)", txU, "sms", "2026-06-16T01:30:00Z", true, "need", { host: HOST.US }),
];

// ---- criterion 3: holdUntil and consent refusals; KR night rule ----
const krU = (consents) => U({ country: "KR", timezone: SEOUL, consents });
const deU = U({ country: "DE", timezone: "Europe/Berlin", consents: {} });
const gbU = U({ country: "GB", timezone: "Europe/London", consents: {} });
const group3 = [
  K("US sms 07:00 EDT holds to 08:00 the same day", usU, "sms", "2026-06-15T11:00:00Z", false, "need", { host: HOST.US, hold: "2026-06-15T12:00:00Z" }),
  K("FL sms 21:30 EDT holds to 08:00 the next day", flU, "sms", "2026-06-16T01:30:00Z", false, "need", { hold: "2026-06-16T12:00:00Z" }),
  // KR, Asia/Seoul UTC+9. 22:00 KST = 13:00Z.
  K("KR sms 22:00 KST, ad only (night consent missing)", krU({ ad: true }), "sms", "2026-06-15T13:00:00Z", false, "need", { host: HOST.KR, hold: null }),
  K("KR sms 22:00 KST, ad and night", krU({ ad: true, night: true }), "sms", "2026-06-15T13:00:00Z", true, "need", { host: HOST.KR, hold: null }),
  // Night starts at 21:00 KST. 20:59 KST = 11:59Z (allowed with ad consent only); 21:00 KST = 12:00Z (refused).
  K("KR sms 20:59 KST, ad only (before night)", krU({ ad: true }), "sms", "2026-06-15T11:59:00Z", true, "need", { host: HOST.KR, hold: null }),
  K("KR sms 21:00 KST, ad only (night starts)", krU({ ad: true }), "sms", "2026-06-15T12:00:00Z", false, "need", { host: HOST.KR, hold: null }),
  // 12:00 KST = 03:00Z
  K("KR sms 12:00 KST, ad only", krU({ ad: true }), "sms", "2026-06-15T03:00:00Z", true, "need", { host: HOST.KR, hold: null }),
  // 07:59 KST = 22:59Z on 06-14; 08:00 KST = 23:00Z on 06-14
  K("KR sms 07:59 KST, ad only (night)", krU({ ad: true }), "sms", "2026-06-14T22:59:00Z", false, "need", { host: HOST.KR, hold: null }),
  K("KR sms 08:00 KST, ad only", krU({ ad: true }), "sms", "2026-06-14T23:00:00Z", true, "need", { host: HOST.KR, hold: null }),
  K("KR email 22:00 KST, ad only (email exempt from night)", krU({ ad: true }), "email", "2026-06-15T13:00:00Z", true, "need", { host: HOST.KR, hold: null }),
  K("KR email 12:00 KST, no consents", krU({}), "email", "2026-06-15T03:00:00Z", false, "need", { host: HOST.KR, hold: null }),
  // A consent refusal is not a time window: DE sms at 03:00 CEST (01:00Z) has holdUntil null.
  K("DE sms 03:00 CEST, no consents (no time window)", deU, "sms", "2026-06-15T01:00:00Z", false, "need", { host: HOST.EU, hold: null }),
  // GB email at 03:00 BST (02:00Z), no consents.
  K("GB email 03:00 BST, no consents (no time window)", gbU, "email", "2026-06-15T02:00:00Z", false, "need", { host: HOST.GB, hold: null }),
];

// ---- criterion 4: GB and EU consent; other countries allowed ----
const EU_CASES = [
  ["DE", "Europe/Berlin", "2026-06-15T10:00:00Z", "EU"],
  ["FR", "Europe/Paris", "2026-06-15T10:00:00Z", "EU"],
  ["IE", "Europe/Dublin", "2026-06-15T11:00:00Z", "EU"],
  ["ES", "Europe/Madrid", "2026-06-15T10:00:00Z", "EU"],
  ["IT", "Europe/Rome", "2026-06-15T10:00:00Z", "EU"],
  ["NL", "Europe/Amsterdam", "2026-06-15T10:00:00Z", "EU"],
  ["SE", "Europe/Stockholm", "2026-06-15T10:00:00Z", "EU"],
  ["PL", "Europe/Warsaw", "2026-06-15T10:00:00Z", "EU"],
  ["GB", "Europe/London", "2026-06-15T11:00:00Z", "GB"],
];
const group4 = [];
for (const [country, timezone, iso, jur] of EU_CASES) {
  // 12:00 local on 2026-06-15, that is the instant column
  for (const channel of ["email", "sms"]) {
    group4.push(K(`${country} ${channel} 12:00 local, no consents`, U({ country, timezone, consents: {} }), channel, iso, false, "need", { host: HOST[jur], hold: null }));
    group4.push(K(`${country} ${channel} 12:00 local, marketing`, U({ country, timezone, consents: { marketing: true } }), channel, iso, true, "need", { host: HOST[jur], hold: null }));
    group4.push(K(`${country} ${channel} 12:00 local, existingCustomer`, U({ country, timezone, consents: {}, existingCustomer: true }), channel, iso, true, "need", { host: HOST[jur], hold: null }));
  }
}
group4.push(
  // No time window: 03:00 local with consent is allowed. DE 03:00 CEST = 01:00Z, GB 03:00 BST = 02:00Z.
  K("DE sms 03:00 CEST with marketing", U({ country: "DE", timezone: "Europe/Berlin", consents: { marketing: true } }), "sms", "2026-06-15T01:00:00Z", true, "need", { host: HOST.EU, hold: null }),
  K("GB email 03:00 BST with marketing", U({ country: "GB", timezone: "Europe/London", consents: { marketing: true } }), "email", "2026-06-15T02:00:00Z", true, "need", { host: HOST.GB, hold: null }),
  // Other countries: allowed, no rule, no sources. BR 03:00 = 06:00Z, TR 03:00 = 00:00Z, JP 03:00 = 18:00Z on 06-14.
  K("BR sms 03:00 local, no consents", U({ country: "BR", timezone: "America/Sao_Paulo", consents: {} }), "sms", "2026-06-15T06:00:00Z", true, "empty"),
  K("BR email 03:00 local, no consents", U({ country: "BR", timezone: "America/Sao_Paulo", consents: {} }), "email", "2026-06-15T06:00:00Z", true, "empty"),
  K("TR sms 03:00 local, no consents", U({ country: "TR", timezone: "Europe/Istanbul", consents: {} }), "sms", "2026-06-15T00:00:00Z", true, "empty"),
  K("TR email 03:00 local, no consents", U({ country: "TR", timezone: "Europe/Istanbul", consents: {} }), "email", "2026-06-15T00:00:00Z", true, "empty"),
  K("JP sms 03:00 local, no consents", U({ country: "JP", timezone: "Asia/Tokyo", consents: {} }), "sms", "2026-06-14T18:00:00Z", true, "empty"),
  K("JP email 03:00 local, no consents", U({ country: "JP", timezone: "Asia/Tokyo", consents: {} }), "email", "2026-06-14T18:00:00Z", true, "empty"),
);

// ---- criterion 6: time zones (refuse where a local-time rule applies; allow where none does) ----
const group6 = [
  K("US sms, time zone missing", U({ country: "US", consents: {} }), "sms", "2026-06-15T16:00:00Z", false, "need", { host: HOST.US, hold: null, reasonRe: /time zone/i }),
  K("US call, time zone Mars/Olympus", U({ country: "US", timezone: "Mars/Olympus", consents: {} }), "call", "2026-06-15T16:00:00Z", false, "need", { host: HOST.US, hold: null, reasonRe: /time zone/i }),
  K("FL sms, time zone missing", U({ country: "US", state: "FL", consents: {} }), "sms", "2026-06-15T16:00:00Z", false, "need", { hold: null, reasonRe: /time zone/i }),
  K("KR sms, ad, time zone missing", U({ country: "KR", consents: { ad: true } }), "sms", "2026-06-15T16:00:00Z", false, "need", { host: HOST.KR, hold: null, reasonRe: /time zone/i }),
  K("KR sms, ad, time zone Mars/Olympus", U({ country: "KR", timezone: "Mars/Olympus", consents: { ad: true } }), "sms", "2026-06-15T16:00:00Z", false, "need", { host: HOST.KR, hold: null, reasonRe: /time zone/i }),
  K("US email, time zone missing (no local rule)", U({ country: "US", consents: {} }), "email", "2026-06-15T16:00:00Z", true, "empty"),
  K("GB email, marketing, time zone missing (no time window)", U({ country: "GB", consents: { marketing: true } }), "email", "2026-06-15T16:00:00Z", true, "need", { host: HOST.GB }),
  K("BR sms, time zone missing (no local rule)", U({ country: "BR", consents: {} }), "sms", "2026-06-15T16:00:00Z", true, "empty"),
];

// Every case, with its source expectation (criterion 5 runs over all of them).
const ALL = [...group1, ...group2, ...group3, ...group4, ...group6];

// Returns null when the result matches the case, otherwise a short reason.
function verdict(c, res) {
  if (res && res.threw) return `threw ${res.threw}`;
  if (res && typeof res.then === "function") return "returned a promise (check must be synchronous)";
  if (!res || typeof res !== "object") return "result is not an object";
  if (typeof res.allowed !== "boolean") return "allowed is not a boolean";
  if (res.allowed !== c.want) return `want allowed=${c.want}, got ${res.allowed} (reason ${JSON.stringify(res.reason)})`;
  if (res.allowed) {
    if (res.reason !== null) return "reason must be null when allowed";
    if (res.holdUntil !== null) return "holdUntil must be null when allowed";
  } else {
    if (typeof res.reason !== "string" || res.reason.trim().length === 0) return "refusal needs a non-empty reason";
    if (c.reasonRe && !c.reasonRe.test(res.reason)) return `reason ${JSON.stringify(res.reason)} does not match ${c.reasonRe}`;
  }
  if (c.hold === null) {
    if (res.holdUntil !== null) return `holdUntil must be null, got ${JSON.stringify(res.holdUntil)}`;
  } else if (typeof c.hold === "string") {
    if (!isoUtc(res.holdUntil) || Date.parse(res.holdUntil) !== Date.parse(c.hold)) {
      return `holdUntil want ${c.hold}, got ${JSON.stringify(res.holdUntil)}`;
    }
  } else if (res.holdUntil !== null && !isoUtc(res.holdUntil)) {
    return `holdUntil must be null or an ISO UTC string, got ${JSON.stringify(res.holdUntil)}`;
  }
  return null;
}

// Returns null when the sources match the case, otherwise a short reason.
function sourcesVerdict(c, res) {
  const s = res.sources;
  if (!Array.isArray(s)) return "sources is not an array";
  for (const u of s) if (typeof u !== "string" || !officialUrl(u)) return `source not https on the allowlist: ${JSON.stringify(u)}`;
  if (c.src === "empty" && s.length !== 0) return `sources must be empty (no rule applied), got ${s.length}`;
  if (c.src === "need" && s.length === 0) return "sources must be non-empty (a rule applied)";
  if (c.src === "need" && c.host && !s.some((u) => c.host(new URL(u).hostname))) {
    return `no source on a host for this jurisdiction (${c.host})`;
  }
  return null;
}

// Runs the bot on a fresh copy of the case input, so a bot that mutates its input cannot leak between cases.
function run(c) {
  try {
    const res = bot.check({ user: structuredClone(c.user), message: structuredClone(c.message), now: new Date(c.at) });
    if (res && typeof res.then === "function") return { threw: "returned a promise" };
    return res;
  } catch (e) {
    return { threw: String((e && e.message) || e).slice(0, 150) };
  }
}

function expectCases(list, note) {
  let ok = true;
  for (const c of list) {
    const why = verdict(c, run(c));
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
}

await r.crit("1 US federal window: sms and call 08:00 to 21:00 local, DST edges, US email has no window", (note) =>
  expectCases(group1, note),
);
await r.crit("2 state windows FL, OK, MD: sms and call 08:00 to 20:00 local, stricter than federal, TX federal only", (note) =>
  expectCases(group2, note),
);
await r.crit("3 holdUntil: null when only a consent blocks (KR night consent included), next 08:00 local when a time window blocks (FL sms: state and federal windows)", (note) =>
  expectCases(group3, note),
);
await r.crit("4 GB and EU: marketing consent or existing customer for email and sms, no time window; other countries allowed", (note) =>
  expectCases(group4, note),
);
await r.crit("5 sources: refusals and checked allowed cases cite official hosts for their jurisdiction, no rule means empty", (note) => {
  let ok = true;
  for (const c of ALL) {
    const res = run(c);
    const why = res && !res.threw && typeof res.then !== "function" && Array.isArray(res.sources) ? sourcesVerdict(c, res) : `no usable result (${JSON.stringify(res && res.threw)})`;
    if (why) {
      ok = false;
      note(`${c.name}: ${why}`);
    }
  }
  return ok;
});
await r.crit("6 time zone: missing or invalid zone refuses where a local rule applies with time zone in the reason", (note) =>
  expectCases(group6, note),
);

r.print();
