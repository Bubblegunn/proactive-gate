// Pre-send gate for US SMS. Decides whether one text may go out now.
//
// Rules applied (see the comment on each check):
//   - 47 CFR 64.1200(a)(2): marketing texts to a cell phone need prior express
//     written consent (here: the marketingConsent flag from the sign-up box).
//   - 47 CFR 64.1200(c)(1): telephone solicitations (marketing) may not be sent
//     before 8:00 or at/after 21:00 in the called party's local time.
//   - 47 CFR 64.1200(a)(10) and CTIA Messaging Principles: a STOP reply revokes
//     consent for the program, so no further texts go out.
//   - CTIA Messaging Principles: marketing texts must tell the recipient how to
//     opt out.
//
// Transactional texts are not telephone solicitations, so the quiet-hours and
// marketing-consent rules do not apply to them. They are allowed when the
// customer triggered them; this function cannot verify that trigger.
//
// Every check fails closed: bad input is blocked with its own reason code.

const US_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const QUIET_HOURS_START = 8; // local hour, inclusive: no solicitations before 08:00
const QUIET_HOURS_END = 21; // local hour, exclusive: no solicitations from 21:00

function allow() {
  return { allowed: true, reason: null };
}

function block(reason) {
  return { allowed: false, reason };
}

// Returns the local hour (0-23) of `now` in the IANA zone `timeZone`,
// or null if the zone is not valid. Uses an explicit zone, so the server's
// own time zone does not matter.
function localHour(now, timeZone) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return null;
  }
  const hour = parts.find((p) => p.type === "hour");
  if (!hour) return null;
  return Number(hour.value);
}

export function checkSms(message, now) {
  const kind = message?.kind;
  const body = message?.body;
  const to = message?.to ?? {};

  // Input checks come first. Anything malformed is blocked.
  if (kind !== "marketing" && kind !== "transactional") {
    return block("invalid_kind");
  }
  if (typeof body !== "string" || body.trim() === "") {
    return block("invalid_body");
  }
  if (typeof to.phone !== "string" || !US_E164.test(to.phone)) {
    return block("invalid_phone");
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block("invalid_now");
  }

  // STOP revokes consent for everything from this sender, so it blocks all kinds.
  // Any non-null value counts as an opt-out, even one that does not parse.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    return block("opted_out");
  }

  if (kind === "transactional") {
    return allow();
  }

  // Marketing from here on.
  // Prior express written consent: the customer must have ticked the sign-up box.
  if (to.marketingConsent !== true) {
    return block("no_marketing_consent");
  }

  // Quiet hours in the customer's home time zone.
  const hour = localHour(now, to.timeZone);
  if (hour === null) {
    return block("invalid_time_zone");
  }
  if (hour < QUIET_HOURS_START || hour >= QUIET_HOURS_END) {
    return block("outside_quiet_hours");
  }

  // The marketing text must carry opt-out instructions (CTIA).
  if (!/\bSTOP\b/i.test(body)) {
    return block("missing_opt_out_instructions");
  }

  return allow();
}
