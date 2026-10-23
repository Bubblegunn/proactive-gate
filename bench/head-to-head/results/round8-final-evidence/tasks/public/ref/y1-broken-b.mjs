// Broken B for Y1. Three plausible mistakes:
//   (1) sources are invented: every refusal and allowed case cites a non-official page (a legal-explainer site), so
//       criterion 5 fails;
//   (2) existingCustomer is ignored, so an existing customer without marketing consent is refused in the UK and EU,
//       which fails criterion 4;
//   (3) holdUntil of a consent refusal is set to the next 08:00 local, as if the consent refusal were a time window,
//       which fails criterion 3 (DE and GB at night, KR night consent).
// Expected to FAIL criteria 3, 4 and 5. Criteria 1, 2 and 6 use the reference's rules and can pass.

const SOURCES = {
  US: ["https://www.law.cornell.edu/cfr/text/47/64.1200"],
  KR: ["https://www.law.go.kr/"],
  GB: ["https://www.legislation.gov.uk/uksi/2003/2426/regulation/22"],
  EU: ["https://eur-lex.europa.eu/eli/dir/2002/58/oj"],
  STATE: ["https://www.flsenate.gov/Laws/Statutes/2025/501.059"],
};
// Mistake 1: explainer pages stand in for the official sources.
const INVENTED = ["https://telemarketing-rules-guide.example.com/"];
const EU_MEMBERS = new Set(["DE", "FR", "IE", "ES", "IT", "NL", "SE", "PL"]);
const STATE_CLOSE = { FL: 1200, OK: 1200, MD: 1200 };
const TZ_REASON = "The recipient's time zone is missing or is not a valid IANA time zone.";

const zoneOk = (tz) => {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const fmtCache = new Map();
function wall(ms, tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute) };
}
const localMinute = (ms, tz) => {
  const w = wall(ms, tz);
  return w.h * 60 + w.mi;
};
const offsetAt = (ms, tz) => {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000;
};
const instantOf = (y, mo, d, h, mi, tz) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
};
function nextEight(ms, tz) {
  const w = wall(ms, tz);
  let t = instantOf(w.y, w.mo, w.d, 8, 0, tz);
  if (t <= ms) {
    const next = new Date(Date.UTC(w.y, w.mo - 1, w.d + 1));
    t = instantOf(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 8, 0, tz);
  }
  return new Date(t).toISOString();
}

const refuse = (reason, sources, holdUntil) => ({ allowed: false, holdUntil, reason, sources });
const allow = (sources) => ({ allowed: true, holdUntil: null, reason: null, sources });

export function check({ user, message, now }) {
  const ms = now.getTime();
  const channel = message.channel;
  const consents = user.consents || {};
  const tz = user.timezone;

  if (user.country === "US" && (channel === "sms" || channel === "call")) {
    if (!zoneOk(tz)) return refuse(TZ_REASON, SOURCES.US, null);
    const m = localMinute(ms, tz);
    const state = Object.prototype.hasOwnProperty.call(STATE_CLOSE, user.state) ? STATE_CLOSE[user.state] : null;
    const stateBad = state !== null && (m < 480 || m >= state);
    const fedBad = m < 480 || m >= 1260;
    if (stateBad || fedBad) {
      return refuse("Texts and calls are outside the permitted local hours.", INVENTED, nextEight(ms, tz));
    }
    return allow(INVENTED);
  }

  if (user.country === "KR" && (channel === "sms" || channel === "email")) {
    if (!consents.ad) return refuse("Korean rules require advertising consent.", INVENTED, nextEight(ms, tz));
    if (channel === "sms") {
      if (!zoneOk(tz)) return refuse(TZ_REASON, INVENTED, null);
      const m = localMinute(ms, tz);
      if ((m >= 1260 || m < 480) && !consents.night) {
        return refuse("Korean rules need night consent for texts.", INVENTED, null);
      }
    }
    return allow(INVENTED);
  }

  const jurisdiction = user.country === "GB" ? "GB" : EU_MEMBERS.has(user.country) ? "EU" : null;
  if (jurisdiction && (channel === "email" || channel === "sms")) {
    // Mistake 2: existingCustomer is not consulted.
    if (!consents.marketing) {
      // Mistake 3: a consent refusal is given a time.
      return refuse("Marketing consent is required.", INVENTED, nextEight(ms, tz));
    }
    return allow(INVENTED);
  }

  return allow([]);
}
