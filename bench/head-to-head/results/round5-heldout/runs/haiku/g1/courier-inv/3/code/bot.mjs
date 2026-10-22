// Pre-send compliance gate for US SMS.
//
// checkSms(message, now) decides whether one text may be handed to the SMS
// provider right now. It sends nothing and has no side effects.
//
// Rules are checked in the order below; the first rule that fails sets the
// reason. Every rule has its own code so support can tell them apart.
//
//   invalid_message            malformed input (fails closed)
//   invalid_phone              not a US E.164 number (+1 NPA NXX XXXX)
//   invalid_time_zone          timeZone is not a known IANA zone
//   invalid_now                now is not a valid Date
//   invalid_opt_out_timestamp  optedOutAt is not null and not a parseable date
//   opted_out                  the customer replied STOP (applies to both kinds)
//   no_marketing_consent       marketing text without the sign-up checkbox
//   quiet_hours                marketing text outside 08:00-21:00 local time
//   missing_opt_out_language   marketing text without a STOP instruction
//
// Basis: 47 CFR 64.1200 (TCPA telephone solicitation rules: consent, quiet
// hours, revocation) and CTIA Messaging Principles and Best Practices (STOP
// handling, opt-out instructions). Transactional texts are not telephone
// solicitations, so they skip the consent and quiet-hours rules.

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_WORD = /\bSTOP\b/; // uppercase keyword, as in "Reply STOP to opt out"

const QUIET_START_HOUR = 21; // 9 p.m. local, inclusive
const QUIET_END_HOUR = 8; // 8 a.m. local, exclusive

const blocked = (reason) => ({ allowed: false, reason });
const allowed = () => ({ allowed: true, reason: null });

// Returns the hour (0-23) in the given IANA zone, or null if the zone is unknown.
function localHour(now, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
  const part = formatter.formatToParts(now).find((p) => p.type === "hour");
  return part ? Number(part.value) : null;
}

function isValidMessage(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    (message.kind === "marketing" || message.kind === "transactional") &&
    typeof message.body === "string" &&
    message.body.trim().length > 0 &&
    message.to !== null &&
    typeof message.to === "object" &&
    typeof message.to.phone === "string" &&
    typeof message.to.timeZone === "string" &&
    typeof message.to.marketingConsent === "boolean" &&
    (message.to.optedOutAt === null || typeof message.to.optedOutAt === "string")
  );
}

export function checkSms(message, now) {
  if (!isValidMessage(message)) {
    return blocked("invalid_message");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return blocked("invalid_now");
  }

  const { kind, body, to } = message;

  if (!US_E164.test(to.phone)) {
    return blocked("invalid_phone");
  }

  // Opt-out check runs before the zone check so a bad zone never masks a STOP.
  // A STOP ends the relationship for both kinds: we do not send anything after it.
  if (to.optedOutAt !== null) {
    if (Number.isNaN(Date.parse(to.optedOutAt))) {
      return blocked("invalid_opt_out_timestamp");
    }
    return blocked("opted_out");
  }

  const hour = localHour(now, to.timeZone);
  if (hour === null) {
    return blocked("invalid_time_zone");
  }

  if (kind === "transactional") {
    return allowed();
  }

  // Marketing from here on.
  if (!to.marketingConsent) {
    return blocked("no_marketing_consent");
  }

  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) {
    return blocked("quiet_hours");
  }

  if (!STOP_WORD.test(body)) {
    return blocked("missing_opt_out_language");
  }

  return allowed();
}
