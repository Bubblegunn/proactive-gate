// SMS send gate for US recipients.
//
// checkSms(message, now) -> { allowed: boolean, reason: string | null }
//
// Rules, in the order they are checked. The first rule that fails sets the reason.
//
//  1. Input sanity (fail closed). Anything we cannot read is blocked, never guessed:
//       invalid_input, invalid_kind, invalid_phone_number, empty_body.
//  2. Transactional texts: allowed after rule 1. They are a one-time reply to
//     something the customer just did in the app (login code, delivery update) and
//     carry no advertising. They are not "telephone solicitations", so the consent,
//     opt-out and 8am-9pm rules below do not apply to them. A STOP reply is a
//     revocation for marketing; it does not block a code the customer requests now.
//     (The caller must keep transactional bodies free of promotional content. This
//     function does not read the text.)
//  3. Marketing texts (47 CFR 64.1200 telephone solicitations, sent by an automated
//     system):
//       opted_out                   - 64.1200(a)(10) and CTIA: the customer replied
//                                     STOP. Any non-null optedOutAt blocks, valid date
//                                     or not, and regardless of the date relative to
//                                     `now`. It overrides marketingConsent.
//       no_marketing_consent        - 64.1200(a)(2): prior express WRITTEN consent is
//                                     required. Only the boolean true counts.
//       invalid_time_zone           - we cannot find the local time, so we do not send.
//       outside_permitted_hours     - 64.1200(c)(1): no solicitation before 8:00 a.m.
//                                     or after 9:00 p.m. at the called party's
//                                     location. Allowed window is 08:00:00 up to
//                                     20:59:59 local. Local time comes from
//                                     to.timeZone and `now`; the server zone is unused.

const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const block = (reason) => ({ allowed: false, reason });
const ALLOW = Object.freeze({ allowed: true, reason: null });

// Local hour (0-23) in the given IANA zone, or null when the zone is unusable.
function localHour(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null; // RangeError for an unknown zone
  }
}

export function checkSms(message, now) {
  if (message === null || typeof message !== "object") return block("invalid_input");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_input");

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (to === null || typeof to !== "object") return block("invalid_input");
  if (typeof to.phone !== "string" || !NANP.test(to.phone)) return block("invalid_phone_number");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");

  if (kind === "transactional") return ALLOW;

  if (to.optedOutAt !== null) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const hour = localHour(now, to.timeZone);
  if (hour === null) return block("invalid_time_zone");
  if (hour < 8 || hour >= 21) return block("outside_permitted_hours");

  return ALLOW;
}
