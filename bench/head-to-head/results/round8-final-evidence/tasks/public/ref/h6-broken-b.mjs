// Broken B for H6. Mistakes: (1) existingCustomer is never read, so the DE and FR exception is missing,
// (2) sources is always [] (no rule is cited), (3) consents.night is never read, so ad alone passes Korean SMS at night.
// Windows, time zones and the other consents are correct.
// Expected FAILS: 2 (KR SMS at 22:00 with ad only is allowed), 4 (existing-customer cases are refused),
// 5 (sources are empty where a source is required). Expected PASSES: 1, 3 and 6 (criterion 6 does not depend on
// consents.night, existingCustomer or sources except the empty BR list, which this bot returns correctly).
const allowed = (sources = []) => ({ allowed: true, reason: null, sources });
const refused = (reason, sources = []) => ({ allowed: false, reason, sources });
const NO_ZONE = "The recipient has no valid time zone, so the local-time rule cannot be checked (time zone missing or unknown).";

function validZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function localMinute(ms, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(new Date(ms))) {
    parts[p.type] = p.value;
  }
  return Number(parts.hour) * 60 + Number(parts.minute);
}

export function check({ user, message, now }) {
  const consents = user.consents || {};
  const sms = message.channel === "sms";
  const ms = now.getTime();

  switch (user.country) {
    case "US": {
      if (!sms) return allowed();
      if (!validZone(user.timezone)) return refused(NO_ZONE);
      const min = localMinute(ms, user.timezone);
      if (min < 480 || min >= 1260) return refused("US texts may be sent only between 08:00 and 21:00 local time (47 CFR 64.1200).");
      return allowed();
    }
    case "KR": {
      if (sms && !validZone(user.timezone)) return refused(NO_ZONE);
      if (!consents.ad) return refused("South Korea requires advertising consent (consents.ad) before this message is sent.");
      return allowed();
    }
    case "IN": {
      if (!sms) return allowed();
      if (!validZone(user.timezone)) return refused(NO_ZONE);
      if (!consents.promotional) return refused("TRAI requires promotional consent (consents.promotional) before a promotional SMS is sent to India.");
      const min = localMinute(ms, user.timezone);
      const flag = min < 360 ? "band00to06" : min < 480 ? "band06to08" : min < 600 ? "band08to10" : min >= 1260 ? "band21to24" : null;
      if (flag && !consents[flag]) return refused(`TRAI TCCCPR 2018 requires consent ${flag} for SMS at this local time.`);
      return allowed();
    }
    case "DE":
    case "FR": {
      if (!consents.marketing) {
        return refused("Germany and France need marketing consent (consents.marketing) for this message.");
      }
      return allowed();
    }
    default:
      return allowed();
  }
}
