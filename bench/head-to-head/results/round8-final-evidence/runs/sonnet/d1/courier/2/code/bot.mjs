// Pre-send gate for SMS. Pure function: reads no clock, stores nothing, never throws.
//
// Rules, in the order they are checked (first match holds the text):
//   invalid-user         user or user.sms is not an object
//   invalid-message      message.kind is not "marketing"/"transactional", or text is empty
//   opted-out            optedOutAt is set (customer replied STOP); holds ALL kinds
//   no-consent           marketing only: sms.optedIn is not exactly true
//   invalid-time         marketing only: `now` is not a valid Date
//   unknown-local-time   marketing only: timeZone missing, invalid, or not a real location
//   quiet-hours          marketing only: local time is outside 08:00-20:59
//
// Basis: 47 CFR 64.1200(c)(1) (no telephone solicitations before 8 a.m. or after 9 p.m.
// at the called party's location), 64.1200(a)(2)/(a)(10) and 64.1200(c)(10) (prior express
// written consent and revocation, applied to all texts from the sender after STOP), and the
// CTIA Messaging Principles and Best Practices (opt-in for marketing, honour STOP).

const OPEN_HOUR = 8; // inclusive, local time
const CLOSE_HOUR = 21; // exclusive, local time

const hold = (rule) => ({ allowed: false, rule });
const allow = () => ({ allowed: true, rule: "" });

const formatters = new Map();

// Returns the local hour (0-23) in an IANA zone, or null if the zone is unusable.
function localHour(timeZone, now) {
  if (typeof timeZone !== "string") return null;
  const name = timeZone.trim();
  // Real locations are "Area/City". "UTC", "GMT", "Etc/*" and bare offsets are server or
  // placeholder values, not where a customer is.
  if (!name.includes("/") || /^etc\//i.test(name)) return null;
  try {
    let fmt = formatters.get(name);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: name,
        hour: "numeric",
        hourCycle: "h23",
      });
      formatters.set(name, fmt);
    }
    const part = fmt.formatToParts(now).find((p) => p.type === "hour");
    const hour = Number(part?.value);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  } catch {
    return null;
  }
}

export async function checkSend(input) {
  try {
    const { user, message, now } = input;
    const sms = user?.sms;
    if (user === null || typeof user !== "object" || sms === null || typeof sms !== "object") {
      return hold("invalid-user");
    }

    const kind = message?.kind;
    if (
      (kind !== "marketing" && kind !== "transactional") ||
      typeof message.text !== "string" ||
      message.text.trim() === ""
    ) {
      return hold("invalid-message");
    }

    // STOP revokes consent for every text from us, not just marketing. Any value other than
    // null/undefined counts, including an unparseable one, because the failure mode we avoid
    // is texting someone who said STOP.
    if (sms.optedOutAt !== null && sms.optedOutAt !== undefined) {
      return hold("opted-out");
    }

    if (kind === "transactional") return allow();

    if (sms.optedIn !== true) return hold("no-consent");

    if (!(now instanceof Date) || Number.isNaN(now.getTime())) return hold("invalid-time");

    const hour = localHour(user.timeZone, now);
    if (hour === null) return hold("unknown-local-time");
    if (hour < OPEN_HOUR || hour >= CLOSE_HOUR) return hold("quiet-hours");

    return allow();
  } catch {
    // Getters or proxies that throw, etc. Fail closed.
    return hold("invalid-input");
  }
}
