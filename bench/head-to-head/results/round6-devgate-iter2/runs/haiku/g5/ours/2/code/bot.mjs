// Decides, before calling the WhatsApp Cloud API, whether one outbound message may be sent.
// Pure function: no I/O, no stored state. Inputs come from the webhook handler and the server clock.
//
// Rules (checked in this order, first failure wins):
//   1. invalid_message        message or contact object is missing
//   2. invalid_message_type   type is neither "text" nor "template"
//   3. not_opted_in           patient has not agreed to hear from us on WhatsApp (applies to all sends)
//   4. template               pre-approved template: allowed at any time once opted in
//   5. text (free-form) needs an open customer service window:
//        - invalid_clock                 `now` is not a valid Date
//        - customer_service_window_closed patient never wrote to us, or the last inbound is 24h+ old
//        - invalid_inbound_timestamp      timestamp is not a digit string, or lies in the future
//
// Meta defines the webhook `timestamp` as Unix time in whole seconds, sent as a string
// (e.g. "1767272400"). It is converted to milliseconds before comparing with Date values.

const WINDOW_MS = 24 * 60 * 60 * 1000;

const ALLOWED = Object.freeze({ allowed: true, reason: null });

function denied(reason) {
  return { allowed: false, reason };
}

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object" || !message.contact || typeof message.contact !== "object") {
    return denied("invalid_message");
  }

  const { type, contact } = message;

  if (type !== "text" && type !== "template") {
    return denied("invalid_message_type");
  }

  if (contact.optedIn !== true) {
    return denied("not_opted_in");
  }

  if (type === "template") {
    return ALLOWED;
  }

  // Free-form text: only inside the 24-hour window opened by the patient's last inbound message.
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return denied("invalid_clock");
  }

  const raw = contact.lastInboundTimestamp;

  if (raw === null || raw === undefined) {
    return denied("customer_service_window_closed");
  }

  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    return denied("invalid_inbound_timestamp");
  }

  const inboundMs = Number(raw) * 1000;
  const elapsedMs = now.getTime() - inboundMs;

  if (elapsedMs < 0) {
    return denied("invalid_inbound_timestamp");
  }

  if (elapsedMs >= WINDOW_MS) {
    return denied("customer_service_window_closed");
  }

  return ALLOWED;
}
