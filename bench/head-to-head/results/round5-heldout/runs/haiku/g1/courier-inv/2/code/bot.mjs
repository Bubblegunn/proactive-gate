// US SMS send gate. Pure function: no I/O, no network, no sending.
//
// Rules, checked in this order; the first one that fails sets the reason:
//   1. opted_out                  Customer replied STOP (optedOutAt is set). Blocks both kinds.
//                                 CTIA: after STOP, send nothing except an opt-out confirmation.
//   2. no_marketing_consent       Marketing only. Customer did not tick the marketing sign-up box.
//                                 47 CFR 64.1200(a)(2): prior express written consent for
//                                 telemarketing texts (texts are "calls" under the TCPA).
//   3. missing_opt_out_language   Marketing only. Body has no "reply STOP" style opt-out instruction.
//                                 CTIA Messaging Principles: marketing must tell the recipient how to opt out.
//   4. outside_quiet_hours        Marketing only. Local time at the customer's home zone is before
//                                 08:00:00 or after 21:00:00. 47 CFR 64.1200(c)(1).
// Transactional messages (customer-triggered: login codes, delivery updates) skip rules 2-4.
//
// Invalid input (wrong types, unknown zone, bad date) throws a TypeError. It is a caller bug,
// not a customer decision, so it does not return a reason code.

const QUIET_HOURS_START_S = 8 * 3600;   // 08:00:00 local, allowed from here
const QUIET_HOURS_END_S = 21 * 3600;    // 21:00:00 local, allowed up to and including this second

const OPT_OUT_INSTRUCTION = /\b(reply|text|send)\s+stop\b/i;

const formatterCache = new Map();

function getFormatter(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new TypeError(`to.timeZone is not a valid IANA time zone: ${timeZone}`);
    }
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

// Seconds since local midnight in the given IANA zone. Uses the zone, never the server's TZ.
function localSecondsOfDay(now, timeZone) {
  const parts = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
}

function assertValid(message, now) {
  if (message === null || typeof message !== "object") {
    throw new TypeError("message must be an object");
  }
  if (message.kind !== "marketing" && message.kind !== "transactional") {
    throw new TypeError('message.kind must be "marketing" or "transactional"');
  }
  if (typeof message.body !== "string" || message.body.trim() === "") {
    throw new TypeError("message.body must be a non-empty string");
  }
  const to = message.to;
  if (to === null || typeof to !== "object") {
    throw new TypeError("message.to must be an object");
  }
  if (typeof to.timeZone !== "string") {
    throw new TypeError("to.timeZone must be an IANA zone string");
  }
  getFormatter(to.timeZone);
  if (typeof to.marketingConsent !== "boolean") {
    throw new TypeError("to.marketingConsent must be a boolean");
  }
  if (to.optedOutAt !== null) {
    if (typeof to.optedOutAt !== "string" || Number.isNaN(Date.parse(to.optedOutAt))) {
      throw new TypeError("to.optedOutAt must be null or an ISO 8601 string");
    }
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
}

const ALLOWED = Object.freeze({ allowed: true, reason: null });

function blocked(reason) {
  return Object.freeze({ allowed: false, reason });
}

/**
 * Decide whether one SMS may be sent now.
 * @param {{kind: "marketing" | "transactional", body: string,
 *          to: {phone: string, timeZone: string, marketingConsent: boolean, optedOutAt: string | null}}} message
 * @param {Date} now
 * @returns {{allowed: boolean, reason: string | null}}
 */
export function checkSms(message, now) {
  assertValid(message, now);

  const { kind, body, to } = message;

  if (to.optedOutAt !== null) {
    return blocked("opted_out");
  }

  if (kind === "transactional") {
    return ALLOWED;
  }

  if (!to.marketingConsent) {
    return blocked("no_marketing_consent");
  }

  if (!OPT_OUT_INSTRUCTION.test(body)) {
    return blocked("missing_opt_out_language");
  }

  const seconds = localSecondsOfDay(now, to.timeZone);
  if (seconds < QUIET_HOURS_START_S || seconds > QUIET_HOURS_END_S) {
    return blocked("outside_quiet_hours");
  }

  return ALLOWED;
}
