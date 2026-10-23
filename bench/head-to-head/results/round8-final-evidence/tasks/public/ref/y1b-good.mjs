// Reference for Y1: check({ user, message, now }). Standalone, node builtins only. Synchronous.
// Local clocks come from Intl.DateTimeFormat in the recipient's zone, so DST and half-hour zones are handled by the
// zone database. Each refusal cites the rule that refused. holdUntil is the next 08:00 local (every time window in
// this table opens at 08:00), and null when the missing thing is a consent.

const SOURCES = {
  US: ["https://www.ecfr.gov/current/title-47/section-64.1200"],
  KR: ["https://www.law.go.kr/"],
  GB: ["https://www.legislation.gov.uk/uksi/2003/2426/regulation/22"],
  EU: ["https://eur-lex.europa.eu/eli/dir/2002/58/oj"],
};
// State windows: the sms and call window closes at the given minute of the local day (20:00 = 1200).
const STATE_RULES = {
  FL: { src: ["https://www.flsenate.gov/Laws/Statutes/2025/501.059"], close: 1200 },
  OK: { src: ["https://www.oscn.net/applications/oscn/index.asp"], close: 1200 },
  MD: { src: ["https://mgaleg.maryland.gov/"], close: 1200 },
};
const EU_MEMBERS = new Set(["DE", "FR", "IE", "ES", "IT", "NL", "SE", "PL"]);
const TZ_REASON =
  "The recipient's time zone is missing or is not a valid IANA time zone, so the local-time rule cannot be checked.";

const zoneCache = new Map();
function zoneOk(tz) {
  if (typeof tz !== "string" || tz.length === 0) return false;
  if (!zoneCache.has(tz)) {
    let ok = true;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      ok = false;
    }
    zoneCache.set(tz, ok);
  }
  return zoneCache.get(tz);
}

const fmtCache = new Map();
function wall(ms, tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  }
  const o = {};
  for (const p of fmtCache.get(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute) };
}

// Minute of the local day (0 to 1439) for the instant ms in zone tz.
function localMinute(ms, tz) {
  const w = wall(ms, tz);
  return w.h * 60 + w.mi;
}

// Wall clock minus UTC at instant ms, in milliseconds.
function offsetAt(ms, tz) {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60000) * 60000;
}

// The instant at which the wall clock in tz reads y-mo-d h:mi.
function instantOf(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  return guess - offsetAt(first, tz);
}

// First instant after ms at which the local clock reads 08:00.
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

  // US federal (47 CFR 64.1200) and state windows: sms and call only, 08:00 to 21:00 local (state: to 20:00).
  if (user.country === "US" && (channel === "sms" || channel === "call")) {
    if (!zoneOk(tz)) return refuse(TZ_REASON, SOURCES.US, null);
    const m = localMinute(ms, tz);
    const fedBad = m < 480 || m >= 1260;
    const state = Object.prototype.hasOwnProperty.call(STATE_RULES, user.state) ? STATE_RULES[user.state] : null;
    const stateBad = state !== null && (m < 480 || m >= state.close);
    if (stateBad) {
      const sources = [...(fedBad ? SOURCES.US : []), ...state.src];
      return refuse(
        `${user.state} rules allow texts and calls only from 08:00 to 20:00 local time.`,
        sources,
        nextEight(ms, tz),
      );
    }
    if (fedBad) {
      return refuse(
        "US federal rules allow texts and calls only from 08:00 to 21:00 local time.",
        SOURCES.US,
        nextEight(ms, tz),
      );
    }
    return allow(state ? [...SOURCES.US, ...state.src] : SOURCES.US);
  }

  // South Korea: advertising consent for sms and email; night consent for sms from 21:00 to 08:00.
  if (user.country === "KR" && (channel === "sms" || channel === "email")) {
    if (!consents.ad) {
      return refuse("Korean rules require advertising consent before this message can be sent.", SOURCES.KR, null);
    }
    if (channel === "sms") {
      if (!zoneOk(tz)) return refuse(TZ_REASON, SOURCES.KR, null);
      const m = localMinute(ms, tz);
      const night = m >= 1260 || m < 480;
      if (night && !consents.night) {
        return refuse(
          "Korean rules need separate night consent to send a text between 21:00 and 08:00 local time.",
          SOURCES.KR,
          null,
        );
      }
    }
    return allow(SOURCES.KR);
  }

  // UK and EU/EEA: marketing email or sms needs marketing consent, or the recipient is an existing customer. No window.
  const jurisdiction =
    user.country === "GB" ? "GB" : EU_MEMBERS.has(user.country) ? "EU" : null;
  if (jurisdiction && (channel === "email" || channel === "sms")) {
    const sources = SOURCES[jurisdiction];
    if (!consents.marketing && user.existingCustomer !== true) {
      const law = jurisdiction === "GB" ? "UK" : "EU";
      return refuse(
        `${law} rules require marketing consent before a marketing ${channel} is sent, unless the recipient is an existing customer.`,
        sources,
        null,
      );
    }
    return allow(sources);
  }

  // Everything else: no rule applies (other countries, and email to the US).
  return allow([]);
}
