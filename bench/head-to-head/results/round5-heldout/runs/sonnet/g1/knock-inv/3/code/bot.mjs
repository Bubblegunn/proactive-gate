// SMS send gate for US customers. Pure function: no I/O, no server-time-zone dependence.
//
// How this follows the rules (for legal review):
//
// 47 CFR 64.1200(a)(2), (f)(9)  Marketing texts sent by automated means need prior express
//   written consent. We require `marketingConsent === true` (the sign-up box) -> no_marketing_consent.
// 47 CFR 64.1200(a)(10) + CTIA STOP handling  A customer may revoke consent by any reasonable
//   means, including replying STOP. We stop marketing as soon as `optedOutAt` is set (CTIA asks for
//   immediate effect; the FCC allows up to 10 business days, so this is stricter) -> opted_out.
//   Any non-null value blocks, even an unparseable or future timestamp (fail closed).
// 47 CFR 64.1200(c)(1)  No telephone solicitation before 8 a.m. or after 9 p.m. at the called
//   party's location. We use the customer's profile time zone (a proxy for their location) and
//   block marketing from 21:00:00 through 07:59:59 local time -> quiet_hours.
//   A missing or invalid time zone blocks marketing (fail closed) -> invalid_time_zone.
// CTIA Messaging Principles  Marketing messages must carry opt-out instructions. We require the
//   word STOP in the body -> missing_opt_out_instructions.
// Transactional texts (login codes, delivery updates) that the customer triggered are
//   informational, not solicitations. The 8-9 p.m. window, the marketing consent box and the
//   marketing STOP do not apply to them, so a login code is never delayed or blocked by them.
//   Decision to confirm with counsel: a STOP is treated as ending marketing only. Do not put
//   promotional content in a transactional text; that would make it a marketing text.
//
// Not checked here (needs other systems): that the text was really customer-triggered, consent
// records, sender identification, the National DNC list, carrier registration (10DLC).

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_WORD = /\bstop\b/i;
const QUIET_START_HOUR = 21; // 9 p.m. local: block from here
const QUIET_END_HOUR = 8; // 8 a.m. local: allowed from here

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

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
    return null; // invalid IANA zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");
  if (!message || typeof message !== "object" || !message.to || typeof message.to !== "object") {
    return block("invalid_message");
  }
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) return block("invalid_phone");

  if (kind === "transactional") return ALLOW;

  // Marketing, most specific legal blocker first.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");
  if (!STOP_WORD.test(body)) return block("missing_opt_out_instructions");

  const hour = typeof to.timeZone === "string" && to.timeZone ? localHour(now, to.timeZone) : null;
  if (hour === null) return block("invalid_time_zone");
  if (hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR) return block("quiet_hours");

  return ALLOW;
}
