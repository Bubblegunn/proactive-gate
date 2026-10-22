// SMS gate for US customers. Pure and synchronous: it never sends and keeps no state.
// Rule sources: TCPA, 47 CFR 64.1200 (a)(2) consent, (a)(10) revocation, (c)(1) calling hours;
// CTIA Messaging Principles and Best Practices (consent, opt-out, STOP notice).

const SOLICIT_START_MIN = 8 * 60; // 08:00 local, included
const SOLICIT_END_MIN = 21 * 60; // 21:00 local, excluded (rule: not "after 9 p.m.")

const E164_US = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_NOTICE = /\bSTOP\b/i;

const block = (reason) => ({ allowed: false, reason });

function localMinutes(now, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const h = Number(parts.find((p) => p.type === "hour").value);
    const m = Number(parts.find((p) => p.type === "minute").value);
    return h * 60 + m;
  } catch {
    return null; // invalid or missing IANA zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");
  if (!message || typeof message !== "object") return block("invalid_message");
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (!to || typeof to !== "object") return block("invalid_recipient");
  if (typeof to.phone !== "string" || !E164_US.test(to.phone)) return block("invalid_us_phone");

  // Transactional texts: customer triggered them, so consent, opt-out and calling hours
  // for solicitations do not apply (a marketing STOP does not stop a login code).
  if (kind === "transactional") return { allowed: true, reason: null };

  // Marketing below. Any unknown value blocks (fail closed).
  // 1. Revocation: any non-null optedOutAt blocks, valid date or not, past or future.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    return block(Number.isNaN(Date.parse(to.optedOutAt)) ? "invalid_opt_out_date" : "opted_out");
  }
  // 2. Prior express written consent: only an explicit true counts.
  if (to.marketingConsent !== true) return block("no_marketing_consent");
  // 3. Calling hours at the recipient's location, 8:00 up to but not including 21:00.
  const minutes = localMinutes(now, to.timeZone);
  if (minutes === null) return block("invalid_time_zone");
  if (minutes < SOLICIT_START_MIN || minutes >= SOLICIT_END_MIN) return block("quiet_hours");
  // 4. CTIA: marketing text must tell the customer how to opt out.
  if (!STOP_NOTICE.test(body)) return block("missing_opt_out_notice");

  return { allowed: true, reason: null };
}
