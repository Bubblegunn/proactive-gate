// Decides whether one outgoing WhatsApp message may be sent through the
// WhatsApp Business Platform Cloud API. Runs before any API call.
// Pure function: no I/O, no stored state.
//
// Rules, checked in this order:
//   1. Contact must have opted in to WhatsApp messages from us.
//   2. "template" messages (pre-approved Meta templates) may be sent at any
//      time to an opted-in contact.
//   3. "text" (free-form) messages are only allowed inside the 24-hour
//      customer service window, which opens when the contact last wrote to us.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Tolerance for a webhook timestamp that is slightly ahead of our clock.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// Meta sends Unix time in seconds. Values at or above this bound are
// milliseconds (or garbage). Reject them instead of reading them as a date
// far in the future, which would keep the window open forever.
const MAX_UNIX_SECONDS = 100_000_000_000;

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}

// Meta delivers `timestamp` as a string of Unix seconds, e.g. "1767272400".
// Returns epoch milliseconds, or null when the value is not a valid timestamp.
function parseInboundMs(raw, now) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;

  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_UNIX_SECONDS) return null;

  const ms = seconds * 1000;
  if (ms > now.getTime() + MAX_CLOCK_SKEW_MS) return null;

  return ms;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("decideWhatsApp: now must be a valid Date");
  }

  const contact = message?.contact;

  if (contact?.optedIn !== true) {
    return deny("contact_not_opted_in");
  }

  if (message.type === "template") {
    return allow();
  }

  if (message.type !== "text") {
    return deny("unknown_message_type");
  }

  const last = contact.lastInboundTimestamp;

  if (last === null || last === undefined) {
    return deny("no_inbound_message_service_window_closed");
  }

  const inboundMs = parseInboundMs(last, now);
  if (inboundMs === null) {
    return deny("invalid_inbound_timestamp");
  }

  // Window is open while strictly less than 24 hours have passed.
  if (now.getTime() - inboundMs >= SERVICE_WINDOW_MS) {
    return deny("service_window_expired");
  }

  return allow();
}
