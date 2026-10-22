// SMS send gate for US customers.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
//
// Rules (first match wins, so one reason code is returned per blocked text):
//
// All texts
//   invalid_message          message missing, or kind is not "marketing" / "transactional".
//   invalid_phone            "to.phone" is not a US/NANP E.164 number (+1 followed by 10 digits).
//   empty_body               body is not a non-blank string.
//
// Marketing texts only (these are "telephone solicitations" / advertising texts)
//   opted_out                optedOutAt is set (customer replied STOP). Revoked consent must be
//                            honored by any reasonable means (47 CFR 64.1200(a)(10)); CTIA requires
//                            STOP to end marketing. Fails closed: any non-null value blocks, even an
//                            unparseable or future date, and no cool-off or re-consent is modeled.
//   no_marketing_consent     marketingConsent is not exactly true. Autodialed/automated marketing
//                            texts need the recipient's prior express written consent
//                            (47 CFR 64.1200(a)(2), (f)(9)); CTIA requires opt-in for the program.
//   invalid_time_zone        timeZone is missing or not a valid IANA zone, so the recipient's local
//                            time cannot be computed. Fails closed.
//   quiet_hours              recipient's local time is before 08:00 or at/after 21:00
//                            (47 CFR 64.1200(c)(1)). Local time comes from the customer's profile
//                            zone via Intl, so the server time zone and DST do not matter.
//   missing_opt_out_notice   body does not tell the customer they can reply STOP (CTIA messaging
//                            principles: opt-out instructions in marketing messages).
//
// Transactional texts (customer-triggered: login codes, delivery updates)
//   Not telephone solicitations: no marketing consent, quiet-hours, or STOP check applies, because
//   the customer asked for them by acting in the app. STOP on the marketing program does not block
//   them. Because a text that carries advertising is treated as marketing, callers must not label
//   promotional text "transactional"; this function trusts `kind` and does not inspect content.
//
// Not covered (no input data for them): National/internal Do-Not-Call lists, state mini-TCPA rules
// that are stricter than the federal hours (e.g. Florida, Oklahoma), sender identification text,
// per-carrier campaign registration, and message frequency limits.

const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const QUIET_BEFORE_HOUR = 8; // earliest local hour for marketing (inclusive)
const QUIET_FROM_HOUR = 21; // first blocked local hour in the evening

const block = (reason) => ({ allowed: false, reason });

function localHour(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) ? hour : null;
  } catch {
    return null; // RangeError for an unknown zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!message || typeof message !== "object") return block("invalid_message");
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_message");
  if (!to || typeof to !== "object") return block("invalid_message");

  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return block("invalid_phone");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");

  if (kind === "transactional") return { allowed: true, reason: null };

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const hour = localHour(now, to.timeZone);
  if (hour === null) return block("invalid_time_zone");
  if (hour < QUIET_BEFORE_HOUR || hour >= QUIET_FROM_HOUR) return block("quiet_hours");

  if (!/\bSTOP\b/i.test(body)) return block("missing_opt_out_notice");

  return { allowed: true, reason: null };
}
