// SMS pre-send gate for US customers. Pure and synchronous: it sends nothing.
//
// Rules applied (reason codes in quotes):
//
//  All messages
//   "invalid_message"    Input is malformed (unknown kind, empty body, missing recipient).
//   "invalid_phone"      `to.phone` is not E.164 (+ and 2-15 digits).
//   "invalid_time"       `now` is not a valid Date.
//
//  Marketing only (a "telephone solicitation" / advertising text)
//   "opted_out"          47 CFR 64.1200(a)(10) and CTIA: a STOP reply revokes consent.
//                        Any non-null `optedOutAt` blocks marketing, with no grace period
//                        (the FCC allows up to 10 business days; we stop at once).
//                        The profile has no consent date, so we cannot tell whether the
//                        customer opted in again after STOP. A non-null value always wins.
//   "no_marketing_consent"  47 CFR 64.1200(a)(2): an autodialed or AI-triggered marketing
//                        text needs prior express WRITTEN consent. Only `marketingConsent
//                        === true` counts. Missing, null or "true" (a string) is refused.
//   "invalid_time_zone"  The home zone is missing or not a valid IANA zone. We cannot
//                        prove the time is allowed, so we block.
//   "quiet_hours"        47 CFR 64.1200(c)(1): no telephone solicitation before 8 a.m. or
//                        after 9 p.m. at the called party's location. We use the home
//                        zone from the profile. Allowed: 08:00:00 up to 20:59:59 local.
//                        We block from 21:00:00, which is stricter than "after 9 p.m.".
//
//  Transactional (login codes, delivery updates the customer asked for)
//   Not telephone solicitations, so the 8 a.m.-9 p.m. window and the marketing consent
//   rule do not apply. A STOP reply to marketing does not block them, because the
//   customer triggered the text in the app. Do not put promotional content in a
//   transactional text: that makes it marketing, and this function cannot detect it.
//
// NOT checked (no data available here): the National Do-Not-Call list, company-specific
// DNC lists, stricter state rules (for example FL, OK, MD, WA quiet hours or caps),
// opt-out wording inside the body, sender identification, carrier registration (10DLC),
// and whether the customer is physically in another time zone.

const E164 = /^\+[1-9]\d{1,14}$/;
const QUIET_BEFORE_HOUR = 8; // first allowed local hour
const QUIET_FROM_HOUR = 21; // first blocked local hour in the evening

const block = (reason) => ({ allowed: false, reason });
const ALLOW = () => ({ allowed: true, reason: null });

// Local hour (0-23) in `timeZone` at `now`, or null when the zone is invalid.
function localHour(now, timeZone) {
  if (typeof timeZone !== "string" || timeZone === "") return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null; // RangeError: invalid time zone
  }
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_time");
  if (message === null || typeof message !== "object") return block("invalid_message");

  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_message");
  if (typeof body !== "string" || body.trim() === "") return block("invalid_message");
  if (to === null || typeof to !== "object") return block("invalid_message");
  if (typeof to.phone !== "string" || !E164.test(to.phone)) return block("invalid_phone");

  if (kind === "transactional") return ALLOW();

  // Marketing. Order: strongest legal ground first.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const hour = localHour(now, to.timeZone);
  if (hour === null) return block("invalid_time_zone");
  if (hour < QUIET_BEFORE_HOUR || hour >= QUIET_FROM_HOUR) return block("quiet_hours");

  return ALLOW();
}
