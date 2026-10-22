// SMS send gate for US recipients. Pure and synchronous: it sends nothing.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
//
// Rules, in the order they are checked. The first rule that fails sets `reason`.
//
//  Both kinds
//   invalid_message          message or message.to is missing or malformed
//   invalid_kind             kind is not "marketing" or "transactional"
//   invalid_now              `now` is not a valid Date
//   empty_body               body is not a non-empty string
//   invalid_phone_number     `to.phone` is not a US/NANP E.164 number (+1 and 10 digits)
//   invalid_opted_out_at     optedOutAt is neither null nor a parseable timestamp (fails closed)
//   opted_out                customer replied STOP (any non-null optedOutAt). CTIA: STOP ends the
//                            program's messages, and the SMS provider blocks the number anyway.
//
//  Marketing only (47 CFR 64.1200(a)(2), (c)(1); CTIA Messaging Principles)
//   no_marketing_consent     marketingConsent is not exactly true. Marketing texts to a cell phone
//                            need the customer's prior express written consent.
//   missing_opt_out_notice   body has no "STOP" opt-out instruction. CTIA expects opt-out
//                            instructions in marketing messages; this gate requires them in every one.
//   invalid_time_zone        timeZone is not a valid IANA zone (fails closed: local time unknown)
//   quiet_hours              recipient's local time is outside 08:00-20:59. 64.1200(c)(1) bars
//                            telephone solicitations before 8 a.m. or after 9 p.m. at the called
//                            party's location. Local time comes from `to.timeZone`, never from the
//                            server's zone.
//
//  Transactional only (47 CFR 64.1200(a)(2) exemption for non-telemarketing, informational texts)
//   promotional_content      body looks like advertising. A text with a promotion mixed in is
//                            telemarketing and needs marketing consent, so it cannot go out as
//                            transactional. This is a keyword heuristic, not a legal judgment.
//
// Transactional texts have no time-of-day limit and need no marketing consent, because the
// customer triggered them. Their trigger is the caller's responsibility: the caller must only
// label a text "transactional" when the customer's own action in the app caused it.
//
// Not covered: state "mini-TCPA" rules (for example Florida and Oklahoma end at 8 p.m., and some
// states restrict weekends and holidays), federal Do-Not-Call list checks, per-day frequency caps,
// brand identification text, and 10DLC registration. Add them as extra rules if counsel requires.

const BLOCKED = (reason) => ({ allowed: false, reason });
const ALLOWED = { allowed: true, reason: null };

// US/NANP: +1, area code and exchange start with 2-9.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const QUIET_START_HOUR = 8; // first allowed local hour (inclusive)
const QUIET_END_HOUR = 21; // first blocked local hour (exclusive): 9 p.m.

const OPT_OUT_NOTICE = /\bstop\b/i;

const PROMOTION = new RegExp(
  [
    String.raw`\d+\s*%\s*off`,
    String.raw`\bsales?\b`,
    String.raw`\bcoupons?\b`,
    String.raw`\bpromo(?:tion|tional)?s?\b`,
    String.raw`\bdiscounts?\b`,
    String.raw`\bdeals?\b`,
    String.raw`\bclearance\b`,
    String.raw`\bbogo\b`,
    String.raw`\bfree\s+(?:gift|shipping|item)\b`,
    String.raw`\bback\s+in\s+stock\b`,
    String.raw`\blimited[-\s]time\b`,
    String.raw`\bact\s+now\b`,
    String.raw`\bshop\s+now\b`,
    String.raw`\bexclusive\s+offer\b`,
    String.raw`\bspecial\s+offer\b`,
  ].join("|"),
  "i",
);

function localHour(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) ? hour : null;
  } catch {
    return null; // RangeError for an unknown time zone
  }
}

export function checkSms(message, now) {
  const to = message?.to;
  if (typeof message !== "object" || message === null || typeof to !== "object" || to === null) {
    return BLOCKED("invalid_message");
  }
  if (message.kind !== "marketing" && message.kind !== "transactional") {
    return BLOCKED("invalid_kind");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return BLOCKED("invalid_now");
  }
  if (typeof message.body !== "string" || message.body.trim() === "") {
    return BLOCKED("empty_body");
  }
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) {
    return BLOCKED("invalid_phone_number");
  }

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (typeof to.optedOutAt !== "string" || Number.isNaN(Date.parse(to.optedOutAt))) {
      return BLOCKED("invalid_opted_out_at");
    }
    return BLOCKED("opted_out");
  }

  if (message.kind === "marketing") {
    if (to.marketingConsent !== true) return BLOCKED("no_marketing_consent");
    if (!OPT_OUT_NOTICE.test(message.body)) return BLOCKED("missing_opt_out_notice");
    const hour = typeof to.timeZone === "string" ? localHour(now, to.timeZone) : null;
    if (hour === null) return BLOCKED("invalid_time_zone");
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return BLOCKED("quiet_hours");
    return ALLOWED;
  }

  if (PROMOTION.test(message.body)) return BLOCKED("promotional_content");
  return ALLOWED;
}
