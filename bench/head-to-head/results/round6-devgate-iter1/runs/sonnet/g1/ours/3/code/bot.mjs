// SMS gate for US recipients. Pure and synchronous: it decides, it never sends.
//
// Rules applied (marketing = texts the AI agent starts on its own):
//   invalid_message / invalid_kind / invalid_phone  malformed input is held, never guessed.
//   opted_out             The customer replied STOP. Revocation of consent must be honored
//                         (47 CFR 64.1200(a)(10); CTIA: STOP ends the program). Any non-null
//                         optedOutAt counts, even an unparsable one (fail closed).
//   no_marketing_consent  Marketing texts need prior express written consent
//                         (47 CFR 64.1200(a)(2)). Only marketingConsent === true counts.
//   invalid_time_zone     The 8am-9pm window cannot be checked, so marketing is held.
//   quiet_hours           No telephone solicitation before 8:00 or at/after 21:00 at the
//                         called party's location (47 CFR 64.1200(c)(1)). Window is
//                         [08:00, 21:00) in the customer's own time zone.
// Transactional texts (customer triggered: login codes, delivery updates) are not
// solicitations, so consent, STOP-for-marketing and the 8-9 window do not apply to them.
// They still need a valid message and a valid US number.
//
// Not enforced: opt-out/"Msg&data rates" wording in the marketing body. CTIA asks for it
// in the first message of a program, and this function does not know whether a message
// is the first. Add that check where the program enrollment is known.

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const WINDOW_START = 8 * 60; // 08:00 inclusive
const WINDOW_END = 21 * 60; // 21:00 exclusive

const deny = (reason) => ({ allowed: false, reason });

function localMinutes(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone.trim() === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour").value);
    const minute = Number(parts.find((p) => p.type === "minute").value);
    return (hour % 24) * 60 + minute;
  } catch {
    return null; // RangeError: unknown zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");
  const to = message?.to;
  if (message === null || typeof message !== "object" || to === null || typeof to !== "object") {
    return deny("invalid_message");
  }
  if (message.kind !== "marketing" && message.kind !== "transactional") {
    return deny("invalid_kind");
  }
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) return deny("invalid_phone");

  if (message.kind === "transactional") return { allowed: true, reason: null };

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return deny("opted_out");
  if (to.marketingConsent !== true) return deny("no_marketing_consent");

  const minutes = localMinutes(now, to.timeZone);
  if (minutes === null) return deny("invalid_time_zone");
  if (minutes < WINDOW_START || minutes >= WINDOW_END) return deny("quiet_hours");

  return { allowed: true, reason: null };
}
