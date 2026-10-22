// Decides whether one outgoing WhatsApp message may be sent through the
// WhatsApp Business Platform Cloud API. Pure function: no I/O, no stored state.
//
// Rules, checked in this order (first failing rule wins):
//   invalid_message           message or contact is missing / malformed
//   unknown_message_type      type is neither "text" nor "template"
//   not_opted_in              patient has not agreed to WhatsApp messages
//   invalid_now               `now` is not a valid Date
//   invalid_inbound_timestamp the webhook timestamp cannot be read as Unix seconds
//   outside_service_window    free-form text, and the 24 h customer service
//                             window opened by the patient's last inbound
//                             message is closed (or there never was one)
//
// Approved templates are allowed outside the service window, but only with opt-in.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Meta sends `timestamp` as a string of Unix time in whole seconds.
// Allow a little clock skew between Meta and our server; anything further
// in the future means the value is misread (for example, milliseconds).
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

const allow = () => ({ allowed: true, reason: null });
const deny = (reason) => ({ allowed: false, reason });

export function decideWhatsApp(message, now) {
  if (!message || typeof message !== "object" || !message.contact || typeof message.contact !== "object") {
    return deny("invalid_message");
  }

  const { type, contact } = message;

  if (type !== "text" && type !== "template") {
    return deny("unknown_message_type");
  }

  if (contact.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny("invalid_now");
  }

  // Templates are the approved way to start a conversation, so the
  // service window does not apply to them.
  if (type === "template") {
    return allow();
  }

  const inbound = contact.lastInboundTimestamp;

  // The patient has never written to us, so no service window is open.
  if (inbound === null || inbound === undefined) {
    return deny("outside_service_window");
  }

  if (typeof inbound !== "string" || !/^\d+$/.test(inbound)) {
    return deny("invalid_inbound_timestamp");
  }

  const inboundMs = Number(inbound) * 1000;
  if (!Number.isSafeInteger(inboundMs)) {
    return deny("invalid_inbound_timestamp");
  }

  const nowMs = now.getTime();
  if (inboundMs > nowMs + MAX_FUTURE_SKEW_MS) {
    return deny("invalid_inbound_timestamp");
  }

  if (nowMs - inboundMs >= SERVICE_WINDOW_MS) {
    return deny("outside_service_window");
  }

  return allow();
}
