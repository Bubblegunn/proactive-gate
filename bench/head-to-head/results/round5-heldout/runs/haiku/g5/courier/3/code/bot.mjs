// WhatsApp Cloud API send gate. Decides, before any API call, whether a
// message may be sent to a patient. Stateless: uses only the contact fields
// the webhook handler already has.

// Meta's customer service window: 24 hours from the patient's last inbound message.
const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{ type: "text" | "template", contact: { optedIn: boolean, lastInboundTimestamp: string | null } }} message
 * @param {Date} now server clock
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const contact = message?.contact;

  // Opt-in applies to every business-initiated message, text or template.
  // Only an explicit true passes.
  if (contact?.optedIn !== true) {
    return deny("not_opted_in");
  }

  if (message.type === "template") {
    // Pre-approved templates may be sent at any time to an opted-in contact.
    return allow();
  }

  if (message.type !== "text") {
    return deny("unknown_message_type");
  }

  // Free-form text is only allowed inside the customer service window.
  const last = contact.lastInboundTimestamp;
  if (last === null || last === undefined) {
    return deny("no_inbound_message");
  }

  const lastInboundMs = parseInboundTimestamp(last);
  if (lastInboundMs === null) {
    return deny("invalid_inbound_timestamp");
  }

  // A window that has run for exactly 24 hours is closed.
  // A negative elapsed time (inbound stamped after our clock) counts as open.
  if (now.getTime() - lastInboundMs >= CUSTOMER_SERVICE_WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return allow();
}

// Meta delivers webhook `timestamp` as a string of Unix epoch SECONDS.
// Returns epoch milliseconds, or null if the value is not a valid timestamp.
function parseInboundTimestamp(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  const ms = Number(value) * 1000;
  if (!Number.isSafeInteger(ms) || Number.isNaN(new Date(ms).getTime())) {
    return null;
  }
  return ms;
}

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}
