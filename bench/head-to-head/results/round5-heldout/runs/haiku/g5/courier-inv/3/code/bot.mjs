// Decides whether the assistant may send one WhatsApp message to a patient,
// before the Meta WhatsApp Cloud API is called. Pure function, no I/O.
//
// Rules, checked in this order:
// 1. not_opted_in: the patient has not agreed to hear from us on WhatsApp.
//    Applies to every message type.
// 2. unsupported_message_type: only "text" and "template" are known.
// 3. Template messages: allowed once opted in. Meta lets a business start a
//    conversation with an approved template at any time.
// 4. Text (free-form) messages: allowed only inside the 24-hour customer
//    service window, which opens when the patient last wrote to us.
//    - service_window_closed: no inbound message on record, or the window
//      has expired (elapsed time >= 24 hours).
//    - invalid_last_inbound_timestamp: the stored value is not a Meta
//      webhook timestamp, or it lies in the future relative to `now`.
//      Such a value cannot be trusted to open a window, so the send is
//      refused.

const WINDOW_MS = 24 * 60 * 60 * 1000;

const allow = () => ({ allowed: true, reason: null });
const deny = (reason) => ({ allowed: false, reason });

// Meta webhook `timestamp` is Unix time in whole seconds, sent as a string
// (e.g. "1767272400"). Returns epoch milliseconds, or null if malformed.
function parseWebhookTimestamp(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) return null;
  return seconds * 1000;
}

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  if (!message || typeof message !== "object") {
    throw new TypeError("message must be an object");
  }

  const { type, contact } = message;

  if (contact?.optedIn !== true) return deny("not_opted_in");

  if (type !== "text" && type !== "template") {
    return deny("unsupported_message_type");
  }

  if (type === "template") return allow();

  const last = contact.lastInboundTimestamp;
  if (last === null || last === undefined) return deny("service_window_closed");

  const lastMs = parseWebhookTimestamp(last);
  if (lastMs === null) return deny("invalid_last_inbound_timestamp");

  const elapsed = now.getTime() - lastMs;
  if (elapsed < 0) return deny("invalid_last_inbound_timestamp");
  if (elapsed >= WINDOW_MS) return deny("service_window_closed");

  return allow();
}
