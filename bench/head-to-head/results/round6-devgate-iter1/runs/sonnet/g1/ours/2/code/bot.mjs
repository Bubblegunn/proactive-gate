// SMS gate: says whether a text may go out now. Sends nothing, keeps no state.
//
// Marketing (AI-initiated):
//   1. opted_out            - customer replied STOP (47 CFR 64.1200(a)(10) revocation; CTIA opt-out)
//   2. no_marketing_consent - no prior express written consent (47 CFR 64.1200(a)(2)); absent = off
//   3. invalid_time_zone    - zone unknown or invalid: held, never guessed
//   4. outside_calling_hours - recipient-local time not in 08:00-21:00 (47 CFR 64.1200(c)(1))
// Transactional (customer-triggered): none of the marketing rules apply.

const START_MINUTE = 8 * 60; // 08:00 local, included
const END_MINUTE = 21 * 60; // 21:00 local, excluded

const ok = () => ({ allowed: true, reason: null });
const blocked = (reason) => ({ allowed: false, reason });

function localMinutes(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour").value);
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return hour * 60 + minute;
  } catch {
    return null; // RangeError: invalid IANA zone
  }
}

export function checkSms(message, now) {
  const kind = message?.kind;
  if (kind === "transactional") return ok();
  if (kind !== "marketing") return blocked("unknown_kind");

  const to = message.to ?? {};

  if (to.optedOutAt !== null && to.optedOutAt !== undefined && to.optedOutAt !== "") {
    return blocked("opted_out");
  }
  if (to.marketingConsent !== true) return blocked("no_marketing_consent");

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return blocked("invalid_time");
  const minutes = localMinutes(now, to.timeZone);
  if (minutes === null) return blocked("invalid_time_zone");
  if (minutes < START_MINUTE || minutes >= END_MINUTE) return blocked("outside_calling_hours");

  return ok();
}
