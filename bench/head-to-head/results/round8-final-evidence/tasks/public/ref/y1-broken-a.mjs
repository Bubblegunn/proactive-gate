// Broken A for Y1. Two plausible mistakes:
//   (1) the state window for FL, OK and MD is ignored, so FL, OK and MD sms and calls at 20:00 to 21:00 are allowed;
//   (2) local time is read as a fixed UTC-5 offset (no daylight saving), so in EDT and CDT the 08:00 boundary is an
//       hour off: 08:00 EDT is refused and 07:59 EDT is allowed, and holdUntil is wrong in summer.
// It also never checks the time zone, so criterion 6 fails too.
// Expected to FAIL criteria 1 (summer boundary), 2 (state window ignored), 3 (holdUntil wrong in summer) and 6 (no
// time zone check). Criteria 4 and 5 are not touched by either mistake.

const H = 3600000;
const DAY = 24 * H;
const SOURCES = {
  US: ["https://www.ecfr.gov/current/title-47/section-64.1200"],
  KR: ["https://www.law.go.kr/"],
  GB: ["https://www.legislation.gov.uk/uksi/2003/2426/regulation/22"],
  EU: ["https://eur-lex.europa.eu/eli/dir/2002/58/oj"],
};
const EU_MEMBERS = new Set(["DE", "FR", "IE", "ES", "IT", "NL", "SE", "PL"]);
const TZ_REASON = "The recipient's time zone is missing or is not a valid IANA time zone.";

const refuse = (reason, sources, holdUntil) => ({ allowed: false, holdUntil, reason, sources });
const allow = (sources) => ({ allowed: true, holdUntil: null, reason: null, sources });

// Mistake 2: fixed UTC-5, whatever the zone and the date.
const fixedMinute = (ms) => Math.floor((((ms - 5 * H) % DAY) + DAY) % DAY / 60000);
const nextEightFixed = (ms) => {
  const local = ms - 5 * H;
  let t = Math.floor(local / DAY) * DAY + 8 * H;
  if (t <= local) t += DAY;
  return new Date(t + 5 * H).toISOString();
};

export function check({ user, message, now }) {
  const ms = now.getTime();
  const channel = message.channel;
  const consents = user.consents || {};

  if (user.country === "US" && (channel === "sms" || channel === "call")) {
    const m = fixedMinute(ms);
    // Mistake 1: only the federal window; the FL, OK and MD state windows are never consulted.
    if (m < 480 || m >= 1260) {
      return refuse("US federal rules allow texts and calls only from 08:00 to 21:00 local time.", SOURCES.US, nextEightFixed(ms));
    }
    return allow(SOURCES.US);
  }

  if (user.country === "KR" && (channel === "sms" || channel === "email")) {
    if (!consents.ad) return refuse("Korean rules require advertising consent.", SOURCES.KR, null);
    if (channel === "sms") {
      const m = fixedMinute(ms);
      if ((m >= 1260 || m < 480) && !consents.night) {
        return refuse("Korean rules need night consent for texts between 21:00 and 08:00.", SOURCES.KR, null);
      }
    }
    return allow(SOURCES.KR);
  }

  const jurisdiction = user.country === "GB" ? "GB" : EU_MEMBERS.has(user.country) ? "EU" : null;
  if (jurisdiction && (channel === "email" || channel === "sms")) {
    if (!consents.marketing && user.existingCustomer !== true) {
      return refuse("Marketing consent is required.", SOURCES[jurisdiction], null);
    }
    return allow(SOURCES[jurisdiction]);
  }

  return allow([]);
}
