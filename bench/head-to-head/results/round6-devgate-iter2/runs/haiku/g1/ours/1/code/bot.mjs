// US SMS gate: decides whether one text may go out now.
// Pure function: sends nothing, holds no state. The caller supplies opt-out and consent in `message.to`.
//
// Rules, checked in order; the first rule that blocks gives the reason:
//   invalid_now            `now` is not a valid Date
//   invalid_kind           kind is not "marketing" or "transactional"
//   invalid_body           body is empty or not a string
//   invalid_phone          phone is not a US (NANP) number in E.164 form
//   invalid_timezone       timeZone is missing or not a valid IANA zone (held, never guessed)
//   invalid_opt_out        optedOutAt is set but is not a parseable date (held)
//   opted_out              customer replied STOP (any kind; CTIA: STOP ends the program)
//   no_marketing_consent   marketing text without explicit marketingConsent === true (47 CFR 64.1200(a)(2))
//   quiet_hours            marketing text outside 08:00-21:00 recipient-local time (47 CFR 64.1200(c)(1))
//
// Transactional texts (login codes, delivery updates) triggered by the customer skip the consent
// and quiet-hour rules; they still stop after a STOP.

const QUIET_START_MIN = 8 * 60; // 08:00 local, inclusive
const QUIET_END_MIN = 21 * 60; // 21:00 local, exclusive
const US_PHONE = /^\+1[2-9]\d{9}$/;

function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

function isValidZone(timeZone) {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function checkSms(message, now) {
  const block = (reason) => ({ allowed: false, reason });

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");

  const { kind, body, to } = message ?? {};
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim().length === 0) return block("invalid_body");

  const phone = to?.phone;
  if (typeof phone !== "string" || !US_PHONE.test(phone)) return block("invalid_phone");

  const timeZone = to?.timeZone;
  if (!isValidZone(timeZone)) return block("invalid_timezone");

  const optedOutAt = to?.optedOutAt ?? null;
  if (optedOutAt !== null) {
    if (typeof optedOutAt !== "string" || Number.isNaN(Date.parse(optedOutAt))) {
      return block("invalid_opt_out");
    }
    return block("opted_out");
  }

  if (kind === "transactional") return { allowed: true, reason: null };

  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const minutes = localMinutes(now, timeZone);
  if (minutes < QUIET_START_MIN || minutes >= QUIET_END_MIN) return block("quiet_hours");

  return { allowed: true, reason: null };
}
