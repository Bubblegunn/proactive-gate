// Decides whether an outbound WhatsApp message may be sent through the
// WhatsApp Business Platform (Cloud API). Pure function: no I/O, no state.
//
// Rules, checked in this order:
//   1. Patient has not opted in to WhatsApp messages        -> not_opted_in
//   2. Message type is neither "text" nor "template"        -> unknown_message_type
//   3. Template messages (pre-approved Meta templates)      -> allowed at any time
//   4. Free-form text, patient never wrote to us            -> no_customer_message
//   5. Free-form text, inbound timestamp is not Meta's form
//      or lies more than 5 min in the future                -> invalid_inbound_timestamp
//   6. Free-form text, 24h customer service window closed   -> service_window_closed
//   7. Free-form text inside the 24h window                 -> allowed
//
// Meta's webhook `timestamp` is a string of Unix time in whole seconds
// (e.g. "1767272400"). It is converted to milliseconds before comparison.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * @param {{ type: "text" | "template", contact: { optedIn: boolean, lastInboundTimestamp: string | null } }} message
 * @param {Date} now server clock
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const { type, contact } = message;

  if (contact.optedIn !== true) {
    return { allowed: false, reason: "not_opted_in" };
  }

  if (type !== "text" && type !== "template") {
    return { allowed: false, reason: "unknown_message_type" };
  }

  if (type === "template") {
    return { allowed: true, reason: null };
  }

  const inbound = contact.lastInboundTimestamp;

  if (inbound === null || inbound === undefined) {
    return { allowed: false, reason: "no_customer_message" };
  }

  if (typeof inbound !== "string" || !/^\d+$/.test(inbound)) {
    return { allowed: false, reason: "invalid_inbound_timestamp" };
  }

  const inboundMs = Number(inbound) * 1000;
  const elapsedMs = now.getTime() - inboundMs;

  // Far in the future means the value is not in seconds (e.g. milliseconds). Small skew is tolerated.
  if (elapsedMs < -CLOCK_SKEW_TOLERANCE_MS) {
    return { allowed: false, reason: "invalid_inbound_timestamp" };
  }

  if (elapsedMs >= SERVICE_WINDOW_MS) {
    return { allowed: false, reason: "service_window_closed" };
  }

  return { allowed: true, reason: null };
}
