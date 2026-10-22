// SMS gate for US customers. Pure and synchronous: it sends nothing and keeps no state.
// Rules applied (47 CFR 64.1200 and CTIA messaging principles):
//  - Marketing needs prior express consent: marketingConsent must be exactly true (missing = off).
//  - A STOP (optedOutAt set) blocks marketing and beats consent.
//  - Marketing is allowed only from 08:00 (included) to 21:00 (excluded) in the
//    recipient's local time (64.1200(c)(1)). The zone comes from to.timeZone, never the server.
//  - Transactional texts the customer triggered are not marketing: consent, opt-out
//    and the 08:00-21:00 window do not apply to them.

const WINDOW_START_MINUTE = 8 * 60;
const WINDOW_END_MINUTE = 21 * 60;

const deny = (reason) => ({ allowed: false, reason });

function localMinuteOfDay(now, timeZone) {
  // Throws RangeError for an invalid IANA zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return deny("invalid_now");
  if (message === null || typeof message !== "object") return deny("invalid_message");

  if (message.kind === "transactional") return { allowed: true, reason: null };
  if (message.kind !== "marketing") return deny("invalid_kind");

  const to = message.to;
  if (to === null || typeof to !== "object") return deny("invalid_message");

  // Opt-out first: any non-empty optedOutAt means the customer replied STOP.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined && to.optedOutAt !== "") {
    return deny("opted_out");
  }
  if (to.marketingConsent !== true) return deny("no_marketing_consent");

  let minute;
  try {
    if (typeof to.timeZone !== "string" || to.timeZone === "") throw new RangeError("zone");
    minute = localMinuteOfDay(now, to.timeZone);
  } catch {
    return deny("invalid_time_zone");
  }
  if (minute < WINDOW_START_MINUTE || minute >= WINDOW_END_MINUTE) {
    return deny("outside_calling_hours");
  }
  return { allowed: true, reason: null };
}
