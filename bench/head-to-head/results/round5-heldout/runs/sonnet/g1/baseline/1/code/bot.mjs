// SMS pre-send gate for US customers. Pure and synchronous: it sends nothing.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
// Checks run in the order below; the first rule that fails gives the reason.
//
// How the rules map to the law and industry guidance:
//
//  invalid_*            Input must be well formed. Anything we cannot verify is
//                       blocked (fail closed), never sent.
//  opted_out            47 CFR 64.1200(a)(10): consent can be revoked by any
//                       reasonable means, and a STOP reply is one. CTIA
//                       Messaging Principles: STOP ends marketing messages.
//                       Applies from optedOutAt onward; we do not use the
//                       10-business-day grace period the FCC allows.
//  no_marketing_consent 47 CFR 64.1200(a)(2): autodialed/automated marketing
//                       texts need prior express written consent. CTIA
//                       requires opt-in for marketing. Only a strict `true`
//                       counts.
//  quiet_hours          47 CFR 64.1200(c)(1): no telephone solicitations
//                       before 8 a.m. or after 9 p.m. at the called party's
//                       location. We use the customer's profile time zone,
//                       allow 08:00:00 to 20:59:59 local, and block from
//                       21:00:00 (conservative at the boundary).
//  missing_opt_out_instructions
//                       CTIA Messaging Principles: marketing messages must
//                       tell the customer how to opt out. We require the word
//                       STOP in the body.
//
// Transactional texts (login codes, delivery updates) are sent because the
// customer asked for them by using the app. They are not telemarketing, so
// marketing consent, quiet hours, and the opt-out wording do not apply, and a
// STOP reply to marketing does not block them. Only the structural checks
// apply. Not covered: stricter state laws (for example Florida and Maryland
// quiet hours), carrier content filtering, and promotional text hidden inside
// a transactional message (the FCC treats that as marketing, so the caller must
// not do it).

const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const STOP_WORD = /\bSTOP\b/i;

const QUIET_START_HOUR = 8; // first allowed local hour (inclusive)
const QUIET_END_HOUR = 21; // first blocked local hour (21:00:00 = 9 p.m.)

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

function localHour(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour").value);
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_now");
  if (message === null || typeof message !== "object") return block("invalid_message");

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (to === null || typeof to !== "object") return block("invalid_recipient");
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) return block("invalid_phone");

  if (kind === "transactional") return ALLOW;

  // Marketing from here on.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    const t = typeof to.optedOutAt === "string" ? Date.parse(to.optedOutAt) : NaN;
    if (Number.isNaN(t)) return block("invalid_opt_out_date");
    if (t <= now.getTime()) return block("opted_out");
  }

  if (to.marketingConsent !== true) return block("no_marketing_consent");

  let hour;
  try {
    hour = localHour(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return block("quiet_hours");

  if (!STOP_WORD.test(body)) return block("missing_opt_out_instructions");

  return ALLOW;
}
