// SMS send gate. Decides whether one text may go to the SMS provider right now.
//
// How the rules map to the law (for the lawyers):
//
// 1. opted_out  - 47 CFR 64.1200(a)(10): a called party may revoke consent by any
//    reasonable means, including a reply of STOP, and the sender must honor it.
//    CTIA Messaging Principles: after STOP the sender stops messaging that number.
//    Applied to BOTH kinds: a STOP is a revocation and our SMS provider (Twilio
//    error 21610) blocks the number anyway. Any non-null optedOutAt blocks, even a
//    date in the future (clock skew) or an unparseable one (fail closed). Only
//    optedOutAt is checked: once set it blocks until the profile owner clears it
//    after a documented re-opt-in (START). A re-ticked consent box alone does not.
// 2. no_marketing_consent - 47 CFR 64.1200(a)(2): an autodialed or automated
//    marketing text needs the called party's prior express WRITTEN consent. The
//    AI agent sends marketing on its own, so we require marketingConsent === true
//    (the sign-up box). Transactional texts that the customer triggered are not
//    marketing and do not need this flag.
// 3. quiet_hours - 47 CFR 64.1200(c)(1): no telephone solicitation before 8 a.m.
//    or after 9 p.m. at the called party's location. Applied to marketing only,
//    using the profile's IANA zone (never the server's zone). Allowed window is
//    08:00:00 to 20:59:59 local time; 21:00:00 sharp is blocked to stay on the safe side.
//    Transactional texts (login codes, delivery updates) are not solicitations
//    and are never held back by time of day.
// Input checks (invalid_*) fail closed: if we cannot tell, nothing goes out.
//
// Not covered (needs state, content review or other data): state "mini-TCPA"
// windows that are stricter than federal ones (for example Florida and
// Oklahoma 8 a.m.-8 p.m., Maryland, Washington), the customer being away from
// their home zone, sender identification and STOP/HELP wording in the body
// (CTIA), content that mixes marketing into a "transactional" text (the caller
// must label the kind truthfully), frequency caps, and the 10DLC registration.

const US_PHONE = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

const MORNING_START_MIN = 8 * 60; // 08:00 local, inclusive
const EVENING_END_MIN = 21 * 60; // 21:00 local, exclusive

function block(reason) {
  return { allowed: false, reason };
}

function localMinutesOfDay(now, timeZone) {
  // Throws RangeError if timeZone is not a valid IANA zone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour").value) % 24;
  const minute = Number(parts.find((p) => p.type === "minute").value);
  return hour * 60 + minute;
}

export function checkSms(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return block("invalid_now");
  }
  if (message === null || typeof message !== "object") {
    return block("invalid_message");
  }
  const { kind, body, to } = message;
  if (kind !== "marketing" && kind !== "transactional") {
    return block("invalid_kind");
  }
  if (typeof body !== "string" || body.trim() === "") {
    return block("empty_body");
  }
  if (to === null || typeof to !== "object") {
    return block("invalid_recipient");
  }
  if (typeof to.phone !== "string" || !US_PHONE.test(to.phone)) {
    return block("invalid_phone");
  }

  // Rule 1: STOP revokes consent for every kind of text.
  if (to.optedOutAt !== null && to.optedOutAt !== undefined) {
    return block("opted_out");
  }

  if (kind === "transactional") {
    return { allowed: true, reason: null };
  }

  // Rule 2: marketing needs prior express written consent.
  if (to.marketingConsent !== true) {
    return block("no_marketing_consent");
  }

  // Rule 3: marketing only between 8 a.m. and 9 p.m. in the customer's zone.
  let minutes;
  try {
    minutes = localMinutesOfDay(now, to.timeZone);
  } catch {
    return block("invalid_time_zone");
  }
  if (minutes < MORNING_START_MIN || minutes >= EVENING_END_MIN) {
    return block("quiet_hours");
  }

  return { allowed: true, reason: null };
}
