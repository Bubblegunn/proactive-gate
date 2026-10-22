// SMS send gate for a US retail app.
//
// checkSms(message, now) decides whether one text may go to the SMS provider
// right now. It does not send anything. When it blocks, `reason` names the
// first rule that failed, so support can explain the block.
//
// Rules, in the order they are checked:
//   invalid_kind                    kind is neither "marketing" nor "transactional"
//   invalid_phone_number            `to.phone` is not a US number in E.164 form
//   empty_body                      `body` is missing or blank
//   invalid_opt_out_timestamp       `to.optedOutAt` is set but is not a valid date
//   opted_out                       customer replied STOP (applies to both kinds)
//   no_marketing_consent            marketing text, but no marketing consent on file
//   invalid_time_zone               marketing text, but `to.timeZone` is not a valid IANA zone
//   outside_quiet_hours             marketing text, local time is before 8:00 or at/after 21:00
//   missing_opt_out_instructions    marketing text does not say how to opt out (STOP)
//   transactional_contains_marketing transactional text contains promotional wording
//
// Legal basis (US), as implemented here:
//   - 47 CFR 64.1200(a)(2): marketing texts sent with automated technology need
//     prior express written consent. Here: `marketingConsent` must be true.
//   - 47 CFR 64.1200(c)(1): telephone solicitations may not be made before
//     8 a.m. or after 9 p.m. in the called party's local time. Here: the
//     customer's home `timeZone`, not the server's.
//   - 47 CFR 64.1200(a)(10): consent may be revoked by any reasonable means,
//     and the revocation must be honored. Here: any `optedOutAt` blocks sends.
//   - CTIA Messaging Principles and Best Practices: marketing messages must
//     include opt-out instructions. Here: the body must contain the word STOP.
//
// Assumptions the caller must satisfy (this function cannot check them):
//   - Transactional texts are sent only after the customer triggers the action.
//   - `marketingConsent: true` came from a disclosure that meets the
//     "prior express written consent" definition in 64.1200(f)(9).
//   - `optedOutAt` is recorded when the STOP reply is received.

const PHONE_PATTERN = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const OPT_OUT_PATTERN = /\bSTOP\b/i;
const PROMO_PATTERN = /\b(sale|sales|coupon|coupons|promo|promotion|discount|deal|deals|back in stock|\d+\s*%\s*off|percent off)\b/i;

const QUIET_HOURS_START = 8;  // 8:00 local, inclusive
const QUIET_HOURS_END = 21;   // 21:00 local, exclusive

const block = (reason) => ({ allowed: false, reason });
const allow = () => ({ allowed: true, reason: null });

// Returns the customer's local hour (0-23) in `timeZone`, or null if the zone is invalid.
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

export function checkSms(message, now) {
  const { kind, body, to } = message;

  if (kind !== "marketing" && kind !== "transactional") {
    return block("invalid_kind");
  }

  if (typeof to?.phone !== "string" || !PHONE_PATTERN.test(to.phone)) {
    return block("invalid_phone_number");
  }

  if (typeof body !== "string" || body.trim() === "") {
    return block("empty_body");
  }

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    if (Number.isNaN(new Date(to.optedOutAt).getTime())) {
      return block("invalid_opt_out_timestamp");
    }
    return block("opted_out");
  }

  if (kind === "marketing") {
    if (to.marketingConsent !== true) {
      return block("no_marketing_consent");
    }

    const hour = localHour(now, to.timeZone);
    if (hour === null) {
      return block("invalid_time_zone");
    }
    if (hour < QUIET_HOURS_START || hour >= QUIET_HOURS_END) {
      return block("outside_quiet_hours");
    }

    if (!OPT_OUT_PATTERN.test(body)) {
      return block("missing_opt_out_instructions");
    }
  }

  if (kind === "transactional" && PROMO_PATTERN.test(body)) {
    return block("transactional_contains_marketing");
  }

  return allow();
}
