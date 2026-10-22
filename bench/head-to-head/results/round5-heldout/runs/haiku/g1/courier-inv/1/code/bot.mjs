// Pre-send gate for US SMS. Pure function: no I/O, no network, nothing is sent.
// Rules: 47 CFR 64.1200 (TCPA) and CTIA Messaging Principles and Best Practices.
//
// Every block returns a distinct snake_case reason code so support can see
// which rule stopped a text. Checks run in the order listed below; the first
// failing check wins. Anything unreadable fails closed (blocked).

// 47 CFR 64.1200(c)(1): telephone solicitations may not be made before 8 a.m.
// or after 9 p.m. in the called party's local time. Texts are treated the same
// way (FCC 2012 TCPA order), so this applies to marketing only.
const QUIET_START_HOUR = 8; // 08:00:00 local is allowed
const QUIET_END_HOUR = 21; // 21:00:00 local is blocked

// NANP format: +1, area code and exchange start with 2-9, 10 digits total.
const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

// CTIA: program messages must tell the recipient how to opt out.
const OPT_OUT_WORD = /\bstop\b/i;

const KINDS = new Set(["marketing", "transactional"]);

function allow() {
  return { allowed: true, reason: null };
}

function block(reason) {
  return { allowed: false, reason };
}

// Local clock hour (0-23) of `now` in `timeZone`. Intl with an explicit zone
// reads the zone's clock, so the server's own time zone never matters.
// Throws RangeError for an unknown IANA zone.
function localHour(now, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  });
  const part = fmt.formatToParts(now).find((p) => p.type === "hour");
  return Number(part.value);
}

/**
 * Decide whether one SMS may go out now.
 *
 * @param {{ kind: "marketing" | "transactional", body: string,
 *           to: { phone: string, timeZone: string,
 *                 marketingConsent: boolean, optedOutAt: string | null } }} message
 * @param {Date} now
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block("invalid_now");
  }
  if (!message || typeof message !== "object") {
    return block("invalid_message");
  }

  const { kind, body, to } = message;

  if (!KINDS.has(kind)) {
    return block("unknown_message_kind");
  }
  if (!to || typeof to !== "object") {
    return block("invalid_recipient");
  }
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) {
    return block("invalid_phone_number");
  }
  if (typeof body !== "string" || body.trim() === "") {
    return block("empty_body");
  }

  // Opt-out. optedOutAt === null means the customer never replied STOP.
  // Any other value counts as opted out; a malformed or missing value fails closed.
  // CTIA: STOP ends the program, so this blocks both kinds. Lawyers should confirm
  // that transactional texts (login codes) may be blocked after STOP.
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== "string" || Number.isNaN(Date.parse(to.optedOutAt))) {
      return block("invalid_opt_out_timestamp");
    }
    return block("opted_out");
  }

  if (kind === "transactional") {
    // Customer-triggered (login code, delivery update). The customer supplied
    // the number and asked for the message, so no marketing consent is needed.
    return allow();
  }

  // kind === "marketing" from here on.

  // 47 CFR 64.1200(a)(2): autodialed or prerecorded marketing to a wireless number
  // requires the customer's prior express written consent. Only a true boolean counts.
  if (to.marketingConsent !== true) {
    return block("marketing_consent_missing");
  }

  if (!OPT_OUT_WORD.test(body)) {
    return block("missing_opt_out_language");
  }

  // A missing zone must not fall back to the server's zone.
  if (typeof to.timeZone !== "string" || to.timeZone === "") {
    return block("invalid_time_zone");
  }

  let hour;
  try {
    hour = localHour(now, to.timeZone);
  } catch (err) {
    if (err instanceof RangeError) {
      return block("invalid_time_zone");
    }
    throw err;
  }
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) {
    return block("quiet_hours");
  }

  return allow();
}
