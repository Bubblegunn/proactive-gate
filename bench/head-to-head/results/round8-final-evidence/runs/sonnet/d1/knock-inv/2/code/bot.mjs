// SMS send gate. checkSend() says whether one text may go out at the instant `now`.
//
// Rules (rule identifiers returned when allowed is false):
//   invalid-input    user or message is missing or not an object
//   empty-message    message.text is not a non-blank string
//   opted-out        user replied STOP (optedOutAt is set), any kind of text
//   no-consent       marketing only: user.sms.optedIn is not exactly true
//   no-opt-out-info  marketing only: text does not tell the customer to reply STOP
//   unknown-timezone marketing only: timeZone is missing, not IANA, or not known to this runtime
//   invalid-time     marketing only: `now` is not a valid Date
//   quiet-hours      marketing only: customer's local time is before 08:00 or at/after 21:00
//
// Basis:
//   - 47 CFR 64.1200(c)(1): no telemarketing before 8 a.m. or after 9 p.m. at the called party's location.
//   - 47 CFR 64.1200(a)(2): marketing texts need prior express written consent (optedIn).
//   - 47 CFR 64.1200(a)(10) and CTIA: a STOP reply revokes consent and the sender must honor it.
//     The code treats STOP as final for every kind of text, because a stateless check cannot tell
//     which texts a later request by the customer would re-allow.
//   - CTIA: marketing texts carry opt-out instructions.
// Any kind other than "transactional" is treated as marketing (the stricter side).
// Quiet hours use the stricter reading: 21:00:00 itself is already held.

const QUIET_END_MINUTE = 8 * 60; // sending starts at 08:00 local
const QUIET_START_MINUTE = 21 * 60; // sending stops at 21:00 local
const OPT_OUT_NOTICE = /\b(?:reply|text|txt|send)\s+["'“]?stop\b/i;
const IANA_SHAPE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/;

const hold = (rule) => ({ allowed: false, rule });
const ALLOW = () => ({ allowed: true, rule: "" });

// Minutes since local midnight at `timeZone`, or null when the zone is unusable.
function localMinuteOfDay(timeZone, now) {
  if (typeof timeZone !== "string") return null;
  const name = timeZone.trim();
  // Bare abbreviations ("EST"), "UTC" and "Etc/*" are typical server defaults, not a customer's place.
  if (!IANA_SHAPE.test(name) || /^etc\//i.test(name)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    return hour * 60 + minute;
  } catch {
    return null; // RangeError for an unknown zone
  }
}

function isOptedOut(sms) {
  const value = sms?.optedOutAt;
  if (value === null || value === undefined) return false;
  // Any other value, including an unparseable or future timestamp, counts as opted out (fail closed).
  return true;
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    if (!user || typeof user !== "object" || !message || typeof message !== "object") {
      return hold("invalid-input");
    }
    if (typeof message.text !== "string" || message.text.trim() === "") {
      return hold("empty-message");
    }
    if (isOptedOut(user.sms)) return hold("opted-out");

    if (message.kind === "transactional") return ALLOW();

    // Everything else is marketing.
    if (user.sms?.optedIn !== true) return hold("no-consent");
    if (!OPT_OUT_NOTICE.test(message.text)) return hold("no-opt-out-info");
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold("invalid-time");
    const minute = localMinuteOfDay(user.timeZone, now);
    if (minute === null) return hold("unknown-timezone");
    if (minute < QUIET_END_MINUTE || minute >= QUIET_START_MINUTE) return hold("quiet-hours");
    return ALLOW();
  } catch {
    return hold("internal-error");
  }
}
