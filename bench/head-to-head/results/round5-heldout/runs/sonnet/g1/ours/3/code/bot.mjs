// SMS pre-send gate. Pure and synchronous: it sends nothing and keeps no state.
//
// Rules applied (marketing = telemarketing text under the TCPA):
//  - 47 CFR 64.1200(a)(2): an autodialed/AI-driven marketing text needs prior express written
//    consent -> `marketingConsent` must be exactly true.
//  - 47 CFR 64.1200(a)(10) and CTIA: a STOP reply revokes consent. Any `optedOutAt` value blocks
//    marketing; an unparseable value also blocks (fail closed).
//  - 47 CFR 64.1200(c)(1): no telemarketing before 8 a.m. or at/after 9 p.m. at the called
//    party's location. Local time comes from the profile IANA zone. The window includes 08:00 and
//    excludes 21:00. An unknown or invalid zone blocks marketing (never guessed).
//  - CTIA: marketing messages must tell the recipient how to opt out -> body must contain STOP.
//  - Transactional texts (login codes, delivery updates the customer triggered) are not
//    telemarketing: no consent flag, quiet hours or marketing opt-out applies to them.
//    They still need a valid US number and a non-empty body.

const US_NUMBER = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const WINDOW_START_MINUTE = 8 * 60;
const WINDOW_END_MINUTE = 21 * 60;

function localMinuteOfDay(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

const block = (reason) => ({ allowed: false, reason });

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return block("invalid_time");
  if (!message || typeof message !== "object") return block("invalid_message");
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") return block("invalid_kind");
  if (typeof body !== "string" || body.trim() === "") return block("empty_body");
  if (!to || typeof to !== "object" || typeof to.phone !== "string" || !US_NUMBER.test(to.phone)) {
    return block("invalid_phone");
  }

  if (kind === "transactional") return { allowed: true, reason: null };

  if (to.optedOutAt !== null && to.optedOutAt !== undefined) return block("opted_out");
  if (to.marketingConsent !== true) return block("no_marketing_consent");

  const minute =
    typeof to.timeZone === "string" && to.timeZone ? localMinuteOfDay(now, to.timeZone) : null;
  if (minute === null) return block("unknown_time_zone");
  if (minute < WINDOW_START_MINUTE || minute >= WINDOW_END_MINUTE) return block("quiet_hours");

  if (!/\bSTOP\b/i.test(body)) return block("missing_opt_out_notice");

  return { allowed: true, reason: null };
}
