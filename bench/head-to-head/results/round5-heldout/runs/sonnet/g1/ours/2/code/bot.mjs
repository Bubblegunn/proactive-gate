// SMS gate for US recipients. Pure and synchronous: it decides, it never sends.
//
// Rules, in the order they are checked (first failing rule gives the reason):
//   invalid_message        message, kind, body or recipient is missing or malformed
//   unknown_kind           kind is not "marketing" or "transactional"
//   empty_body             body is empty or whitespace
//   invalid_phone          "to.phone" is not a US/Canada NANP number in E.164 (+1 and 10 digits)
//   opted_out              marketing only: customer replied STOP (47 CFR 64.1200(a)(10) revocation;
//                          CTIA: stop marketing after STOP)
//   no_marketing_consent   marketing only: no prior express written consent
//                          (47 CFR 64.1200(a)(2); CTIA: opt-in needed). Absent/false/non-true = no.
//   missing_opt_out_notice marketing only: body does not tell the customer how to stop
//                          (CTIA: opt-out instructions in marketing messages)
//   invalid_time_zone      marketing only: time zone missing or not a valid IANA zone, so the
//                          customer's local hour is unknown (held, never guessed)
//   quiet_hours            marketing only: local time outside 08:00-21:00
//                          (47 CFR 64.1200(c)(1): no solicitations before 8 a.m. or after 9 p.m.
//                          at the called party's location). 08:00 is allowed, 21:00 is not.
//
// Transactional texts (customer-triggered: login codes, delivery updates) skip the opt-out,
// consent, notice and quiet-hours rules. Assumptions: a STOP reply to marketing does not block
// a code or update the customer just asked for, and the transactional body carries no promotion.
// Not covered (no data for it): National DNC registry, state "mini-TCPA" hours (e.g. FL, OK),
// carrier content filters, and the called party's real location when it differs from home.

const OPEN_MINUTE = 8 * 60;
const CLOSE_MINUTE = 21 * 60;

const block = (reason) => ({ allowed: false, reason });

function localMinutes(now, timeZone) {
  // Throws RangeError for an invalid zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!message || typeof message !== "object" || !message.to || typeof message.to !== "object") {
    return block("invalid_message");
  }
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("unknown_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (typeof to.phone !== "string" || !/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(to.phone)) {
    return block("invalid_phone");
  }

  if (kind === "transactional") return { allowed: true, reason: null };

  // Marketing. Any non-null optedOutAt counts as opted out (an unreadable value fails closed).
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");
  if (!/\bSTOP\b/i.test(body)) return block("missing_opt_out_notice");

  let minutes;
  try {
    if (typeof to.timeZone !== "string" || to.timeZone.trim() === "") throw new RangeError();
    minutes = localMinutes(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (minutes < OPEN_MINUTE || minutes >= CLOSE_MINUTE) return block("quiet_hours");

  return { allowed: true, reason: null };
}
