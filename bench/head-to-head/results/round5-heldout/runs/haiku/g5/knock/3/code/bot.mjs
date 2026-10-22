// Decides whether the assistant may send one WhatsApp message through the
// WhatsApp Business Platform (Cloud API). Pure function, no I/O, no sends.
//
// Rules, checked in this order:
// 1. The patient must have opted in to WhatsApp messages from us. Applies to
//    every message type.
// 2. A "template" message (pre-approved Meta template) may be sent at any
//    time after opt-in, so it is allowed.
// 3. A "text" (free-form) message is allowed only inside the 24-hour customer
//    service window, which opens with the patient's most recent inbound message.
//
// Meta's webhook `timestamp` is Unix time in whole seconds, delivered as a
// string. It is converted to milliseconds before any date arithmetic.

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function deny(reason) {
  return { allowed: false, reason };
}

export function decideWhatsApp(message, now) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('now must be a valid Date');
  }

  const type = message?.type;
  const contact = message?.contact;

  if (contact?.optedIn !== true) {
    return deny('not_opted_in');
  }

  if (type === 'template') {
    return { allowed: true, reason: null };
  }

  if (type !== 'text') {
    return deny('unsupported_message_type');
  }

  const inbound = contact.lastInboundTimestamp;
  if (inbound === null || inbound === undefined) {
    return deny('no_inbound_message');
  }
  if (typeof inbound !== 'string' || !/^\d+$/.test(inbound)) {
    return deny('invalid_inbound_timestamp');
  }

  const inboundMs = Number(inbound) * 1000;
  if (!Number.isFinite(inboundMs)) {
    return deny('invalid_inbound_timestamp');
  }

  const elapsedMs = nowMs - inboundMs;
  if (elapsedMs < 0) {
    return deny('inbound_timestamp_in_future');
  }
  if (elapsedMs >= SERVICE_WINDOW_MS) {
    return deny('service_window_closed');
  }

  return { allowed: true, reason: null };
}
