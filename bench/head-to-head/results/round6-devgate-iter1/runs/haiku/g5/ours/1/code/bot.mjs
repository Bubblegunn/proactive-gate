// Decides whether the assistant may send one WhatsApp message to a patient.
// Pure function: no I/O, no state. Inputs come from the webhook handler's data.
//
// Rules (WhatsApp Business Platform / Cloud API):
// 1. No message of any kind without the patient's opt-in.
// 2. Template messages are allowed at any time after opt-in.
// 3. Free-form (text) messages are allowed only inside the 24-hour customer
//    service window, which opens with the patient's last inbound message and
//    closes 24 hours after it.
//
// Meta's webhook `timestamp` is Unix time in seconds, as a string.

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    return deny('invalid_now');
  }

  const type = message?.type;
  const contact = message?.contact;

  if (contact?.optedIn !== true) {
    return deny('not_opted_in');
  }

  if (type === 'template') {
    return allow();
  }

  if (type !== 'text') {
    return deny('unsupported_message_type');
  }

  const last = contact.lastInboundTimestamp;
  if (last === null) {
    return deny('no_inbound_message');
  }

  const lastMs = parseInboundSeconds(last);
  if (lastMs === null) {
    return deny('invalid_inbound_timestamp');
  }

  const elapsed = now.getTime() - lastMs;
  if (elapsed < 0) {
    return deny('inbound_timestamp_in_future');
  }
  if (elapsed >= WINDOW_MS) {
    return deny('customer_service_window_closed');
  }

  return allow();
}

// Meta sends seconds as a digit-only string. Anything else is rejected rather
// than guessed at, so a malformed value can never open the window.
function parseInboundSeconds(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    return null;
  }
  return seconds * 1000;
}

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}
