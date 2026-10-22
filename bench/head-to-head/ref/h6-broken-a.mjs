// Broken A for H6. Mistakes: (1) the source URLs are invented on example domains, (2) the US local clock is a fixed
// UTC-5 (no daylight saving), (3) India's local clock is a fixed UTC+5 (the :30 is ignored, so the bands are read
// as whole hours).
// Expected FAILS: 1 (US in summer is one hour off, so the 08:00 and 21:00 edges move), 3 (the India edges at :30
// are read in the wrong band), 5 (the invented sources are not on the allowlist). Expected PASSES: 2, 4 and 6.
// Criterion 6 is not caused by this mistake: it checks the zone refusals and the empty source list for BR, and
// the invented sources do not reach it.
const SOURCES = {
  US: ["https://example-compliance.com/laws/US"],
  KR: ["https://www.legalinfo.example/kr"],
  IN: ["https://example-compliance.com/laws/IN"],
  EU: ["https://example-compliance.com/laws/EU"],
};

const UTC_OFFSET_MIN = { US: -300, IN: 300 };
const clocks = new Map();
function localMinute(ms, country, timeZone) {
  if (UTC_OFFSET_MIN[country] !== undefined) {
    return (Math.floor(ms / 60000) + UTC_OFFSET_MIN[country] + 1440 * 10) % 1440;
  }
  if (!clocks.has(timeZone)) {
    clocks.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" }));
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

const allowed = (sources = []) => ({ allowed: true, reason: null, sources });
const refused = (reason, sources) => ({ allowed: false, reason, sources });
const NO_ZONE = "The recipient has no valid time zone, so the local-time rule cannot be checked (time zone missing or unknown).";

export function check({ user, message, now }) {
  const consents = user.consents || {};
  const sms = message.channel === "sms";
  const ms = now.getTime();

  switch (user.country) {
    case "US": {
      if (!sms) return allowed([]);
      if (!validZone(user.timezone)) return refused(NO_ZONE, SOURCES.US);
      const min = localMinute(ms, "US", user.timezone);
      if (min < 480 || min >= 1260) return refused("US texts may be sent only between 08:00 and 21:00 local time (47 CFR 64.1200).", SOURCES.US);
      return allowed(SOURCES.US);
    }
    case "KR": {
      if (sms && !validZone(user.timezone)) return refused(NO_ZONE, SOURCES.KR);
      if (!consents.ad) return refused("South Korea requires advertising consent (consents.ad) before this message is sent.", SOURCES.KR);
      if (sms) {
        const min = localMinute(ms, "KR", user.timezone);
        if ((min >= 1260 || min < 480) && !consents.night) {
          return refused("SMS advertising between 21:00 and 08:00 local time needs night consent (consents.night).", SOURCES.KR);
        }
      }
      return allowed(SOURCES.KR);
    }
    case "IN": {
      if (!sms) return allowed([]);
      if (!validZone(user.timezone)) return refused(NO_ZONE, SOURCES.IN);
      if (!consents.promotional) return refused("TRAI requires promotional consent (consents.promotional) before a promotional SMS is sent to India.", SOURCES.IN);
      const h = Math.floor(localMinute(ms, "IN", user.timezone) / 60);
      const flag = h < 6 ? "band00to06" : h < 8 ? "band06to08" : h < 10 ? "band08to10" : h >= 21 ? "band21to24" : null;
      if (flag && !consents[flag]) return refused(`TRAI TCCCPR 2018 requires consent ${flag} for SMS at this local hour.`, SOURCES.IN);
      return allowed(SOURCES.IN);
    }
    case "DE":
    case "FR": {
      if (!consents.marketing && user.existingCustomer !== true) {
        return refused("Germany and France need marketing consent (consents.marketing) for this message, unless the recipient is an existing customer.", SOURCES.EU);
      }
      return allowed(SOURCES.EU);
    }
    default:
      return allowed([]);
  }
}
