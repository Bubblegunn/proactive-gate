// Reference for H6 check. Standalone: node builtins only. Synchronous.
// Local clocks come from Intl.DateTimeFormat in the user's IANA zone. The time zone is checked first for every
// rule that depends on local time. Sources are the official roots of each rule (no invented hosts).
const SOURCES = {
  US: ["https://www.ecfr.gov/current/title-47/section-64.1200"],
  KR: ["https://www.law.go.kr/"],
  IN: ["https://www.trai.gov.in/"],
  EU: ["https://eur-lex.europa.eu/eli/dir/2002/58/oj"],
};

const clocks = new Map();
function minuteOfDay(ms, timeZone) {
  if (!clocks.has(timeZone)) {
    clocks.set(
      timeZone,
      new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" }),
    );
  }
  const parts = {};
  for (const p of clocks.get(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function validZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const allowed = (sources = []) => ({ allowed: true, reason: null, sources });
const refused = (reason, sources) => ({ allowed: false, reason, sources });
const NO_ZONE = "The recipient has no valid time zone, so the local-time rule cannot be checked (time zone missing or unknown).";

// India: TRAI time bands in local minutes. Returns null for 10:00 to 21:00 (no band needed).
function indiaBand(min) {
  if (min < 360) return { flag: "band00to06", range: "00:00-06:00" };
  if (min < 480) return { flag: "band06to08", range: "06:00-08:00" };
  if (min < 600) return { flag: "band08to10", range: "08:00-10:00" };
  if (min >= 1260) return { flag: "band21to24", range: "21:00-24:00" };
  return null;
}

export function check({ user, message, now }) {
  const consents = user.consents || {};
  const sms = message.channel === "sms";
  const ms = now.getTime();

  switch (user.country) {
    case "US": {
      if (!sms) return allowed([]);
      if (!validZone(user.timezone)) return refused(NO_ZONE, SOURCES.US);
      const min = minuteOfDay(ms, user.timezone);
      if (min < 480 || min >= 1260) {
        return refused(
          `US texts may be sent only between 08:00 and 21:00 local time (47 CFR 64.1200); it is ${hhmm(min)} local.`,
          SOURCES.US,
        );
      }
      return allowed(SOURCES.US);
    }

    case "KR": {
      if (sms && !validZone(user.timezone)) return refused(NO_ZONE, SOURCES.KR);
      if (!consents.ad) {
        return refused("South Korea requires advertising consent (consents.ad) before this message is sent.", SOURCES.KR);
      }
      if (sms) {
        const min = minuteOfDay(ms, user.timezone);
        if ((min >= 1260 || min < 480) && !consents.night) {
          return refused(
            `Under Network Act article 50, SMS advertising between 21:00 and 08:00 local time needs night consent (consents.night); it is ${hhmm(min)} local.`,
            SOURCES.KR,
          );
        }
      }
      return allowed(SOURCES.KR);
    }

    case "IN": {
      if (!sms) return allowed([]);
      if (!validZone(user.timezone)) return refused(NO_ZONE, SOURCES.IN);
      if (!consents.promotional) {
        return refused("TRAI requires promotional consent (consents.promotional) before a promotional SMS is sent to India.", SOURCES.IN);
      }
      const band = indiaBand(minuteOfDay(ms, user.timezone));
      if (band && !consents[band.flag]) {
        return refused(
          `TRAI TCCCPR 2018 allows promotional SMS in the local time window ${band.range} only with consent ${band.flag}.`,
          SOURCES.IN,
        );
      }
      return allowed(SOURCES.IN);
    }

    case "DE":
    case "FR": {
      if (!consents.marketing && user.existingCustomer !== true) {
        return refused(
          "Germany and France need marketing consent (consents.marketing) for this message, unless the recipient is an existing customer.",
          SOURCES.EU,
        );
      }
      return allowed(SOURCES.EU);
    }

    default:
      return allowed([]);
  }
}
