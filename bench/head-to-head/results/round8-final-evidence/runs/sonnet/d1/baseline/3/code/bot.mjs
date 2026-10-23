// Decides whether one SMS may be sent right now.
//
// Rules, checked in this order (the first one that fails is the one reported):
//   invalid-input       - arguments are missing or malformed
//   opted-out           - customer replied STOP (any kind of message is held)
//   no-consent          - marketing text without sms.optedIn === true
//   no-opt-out-notice   - marketing text that does not tell the customer how to opt out
//   unknown-time-zone   - marketing text and no usable IANA time zone on the profile
//   quiet-hours         - marketing text outside 08:00-21:00 in the customer's local time
//   check-error         - unexpected failure inside this function (fails closed)
//
// Basis: 47 CFR 64.1200(c)(1) (no telephone solicitations before 8 a.m. or after
// 9 p.m. at the called party's location), 47 CFR 64.1200(a)(10) (a revocation of
// consent covers further messages from the sender), 64.1200(a)(2) (marketing
// texts need prior express written consent), and the CTIA Messaging Principles
// and Best Practices (opt-in before marketing, a STOP instruction, honor STOP).

const QUIET_START_HOUR = 8; // first local hour at which marketing may go out
const QUIET_END_HOUR = 21; // marketing must stop at 21:00 local (exclusive)

const OPT_OUT_NOTICE = /\b(?:reply|text|txt|send|respond\s+with)\s+["'“‘]?(?:stop|end|cancel|unsubscribe|quit)\b/i;

const hold = (rule) => ({ allowed: false, rule });
const allow = () => ({ allowed: true, rule: "" });

// Returns the customer's local hour (0-23), or null when the zone is not a usable IANA region name.
function localHour(timeZone, now) {
  if (typeof timeZone !== "string") return null;
  const zone = timeZone.trim();
  // Require "Area/Location". This rejects "UTC", "GMT", offsets such as "+05:00",
  // and "Etc/..." zones, which are what a profile holds when the real zone is unknown.
  if (!/^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(zone) || /^etc\//i.test(zone)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null; // RangeError: unknown time zone
  }
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input ?? {};
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold("invalid-input");
    if (!user || typeof user !== "object" || !message || typeof message !== "object") {
      return hold("invalid-input");
    }
    const { kind, text } = message;
    if (kind !== "marketing" && kind !== "transactional") return hold("invalid-input");
    if (typeof text !== "string" || text.trim() === "") return hold("invalid-input");
    const sms = user.sms;
    if (!sms || typeof sms !== "object") return hold("invalid-input");

    // A STOP reply withdraws consent. Any value other than null/undefined counts as
    // opted out, including an unparseable one, because the safe reading of a
    // damaged record is that the customer did opt out.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) return hold("opted-out");

    if (kind === "transactional") return allow();

    if (sms.optedIn !== true) return hold("no-consent");
    if (!OPT_OUT_NOTICE.test(text)) return hold("no-opt-out-notice");

    const hour = localHour(user.timeZone, now);
    if (hour === null) return hold("unknown-time-zone");
    if (hour < QUIET_START_HOUR || hour >= QUIET_END_HOUR) return hold("quiet-hours");

    return allow();
  } catch {
    return hold("check-error");
  }
}
