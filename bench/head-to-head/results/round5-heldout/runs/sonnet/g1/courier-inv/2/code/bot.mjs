// SMS gate: decides whether a text may go to the SMS provider right now.
//
// Rules and sources:
//   Marketing texts (autodialed/automated, sent by an AI agent) are telemarketing under the TCPA.
//   - 47 CFR 64.1200(a)(2): prior express WRITTEN consent is required.
//       -> marketing_consent_missing unless to.marketingConsent === true.
//   - 47 CFR 64.1200(a)(10) and the FCC revocation rules: a customer may revoke consent by
//     any reasonable means, such as replying STOP. CTIA: STOP ends the program.
//       -> marketing_opted_out when optedOutAt is set. No later date check: STOP stays in force.
//   - 47 CFR 64.1200(c)(1): no telephone solicitation before 8 a.m. or after 9 p.m.
//     at the called party's location.
//       -> marketing_quiet_hours. Local time comes from the profile time zone, not the server's.
//   - CTIA Messaging Principles: marketing messages carry opt-out instructions.
//       -> marketing_missing_opt_out unless the body contains the word STOP.
//   Transactional texts (login codes, delivery updates) that the customer triggered in the app
//   are not telephone solicitations. No consent flag, quiet-hours or opt-out-of-marketing check
//   applies to them. A STOP reply is treated as a marketing opt-out only. Legal must confirm this.
//   Any text, of either kind, is also blocked when it cannot be sent safely
//   (bad kind, bad number, empty body).
//
// Checks run in this order and the first failing rule gives the reason.

const E164 = /^\+[1-9]\d{7,14}$/;
const QUIET_BEFORE_HOUR = 8; // texts allowed from 08:00 local
const QUIET_FROM_HOUR = 21; // texts blocked from 21:00 local

function localHourMinute(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { hour: get("hour"), minute: get("minute") };
}

function block(reason) {
  return { allowed: false, reason };
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");
  if (!message || typeof message !== "object") return block("invalid_message");

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (!to || typeof to.phone !== "string" || !E164.test(to.phone)) return block("invalid_phone");

  if (kind === "transactional") return { allowed: true, reason: null };

  // Marketing from here on. Fail closed on anything unclear.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("marketing_opted_out");
  if (to.marketingConsent !== true) return block("marketing_consent_missing");

  let time;
  try {
    time = localHourMinute(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (time.hour < QUIET_BEFORE_HOUR || time.hour >= QUIET_FROM_HOUR) {
    return block("marketing_quiet_hours");
  }

  if (!/\bstop\b/i.test(body)) return block("marketing_missing_opt_out");

  return { allowed: true, reason: null };
}
