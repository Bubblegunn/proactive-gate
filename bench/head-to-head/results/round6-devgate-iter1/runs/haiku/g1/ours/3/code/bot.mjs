// US SMS gate. Decides whether one text may go out now. Never sends anything.
// Returns { allowed, reason } where reason is a snake_case code naming the rule that blocked it.

// NANP format: +1, area code and exchange start with 2-9.
const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// ISO 8601 with a time and an offset or Z.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// 47 CFR 64.1200(c)(1): telephone solicitations may not be made before 8 a.m. or after 9 p.m.
// local time at the called party's location. Start minute included, end minute excluded.
const MARKETING_START_MINUTE = 8 * 60;
const MARKETING_END_MINUTE = 21 * 60;

const block = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

// Minute of day (0-1439) in the given IANA zone. The server's own zone is not used.
// hourCycle h23 keeps midnight as 00, not 24.
function localMinuteOfDay(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");

  if (!message || typeof message !== "object") return block("invalid_message");
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_message");
  if (typeof body !== "string") return block("invalid_message");

  if (!to || typeof to !== "object") return block("invalid_recipient");
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return block("invalid_recipient");

  // Opt-out applies to both kinds. A missing field is unknown, not "no opt-out".
  // CTIA: after STOP, no further messages from the program except a one-time confirmation.
  // 47 CFR 64.1200(a)(10): consumers may revoke consent by any reasonable means.
  if (to.optedOutAt === undefined) return block("opt_out_status_unknown");
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== "string" || !ISO_TIMESTAMP.test(to.optedOutAt)) {
      return block("invalid_opt_out_timestamp");
    }
    if (Number.isNaN(Date.parse(to.optedOutAt))) return block("invalid_opt_out_timestamp");
    return block("opted_out");
  }

  // Transactional texts are triggered by the customer's own action: no marketing consent,
  // no time-of-day window (a login code must arrive when the customer asks for it).
  if (kind === "transactional") return allow();

  // 47 CFR 64.1200(a)(2): prior express written consent for marketing texts.
  // Only an explicit true counts; false, absent or any other value is refused.
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  if (!isValidTimeZone(to.timeZone)) return block("invalid_time_zone");
  const minute = localMinuteOfDay(now, to.timeZone);
  if (minute < MARKETING_START_MINUTE || minute >= MARKETING_END_MINUTE) {
    return block("outside_marketing_hours");
  }

  return allow();
}
