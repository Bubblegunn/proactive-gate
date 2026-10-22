// Decides whether the assistant may send one WhatsApp message to a patient,
// before the Cloud API call is made. Pure function: no I/O, no stored history.

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Meta's clock and ours can differ slightly. Inbound timestamps a little ahead
// of our clock are treated as "just now"; anything further ahead means the
// value is in the wrong unit or malformed.
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * @param {{ type: "text" | "template", contact: { optedIn: boolean, lastInboundTimestamp: string | null } }} message
 * @param {Date} now server clock
 * @returns {{ allowed: boolean, reason: string | null }}
 */
export function decideWhatsApp(message, now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  const type = message?.type;
  if (type !== "text" && type !== "template") {
    return deny("unsupported_message_type");
  }

  // Opt-in applies to every business-initiated message, template or not.
  // Only an explicit true counts as consent.
  if (message.contact?.optedIn !== true) {
    return deny("not_opted_in");
  }

  // Approved templates may be sent at any time to an opted-in contact,
  // including when the contact has never written to us.
  if (type === "template") {
    return allow();
  }

  // Free-form text is only allowed inside the 24-hour customer service window,
  // which opens with the patient's most recent inbound message.
  const raw = message.contact.lastInboundTimestamp;
  if (raw === null || raw === undefined) {
    return deny("no_prior_inbound_message");
  }

  // Meta sends the webhook timestamp as Unix time in whole seconds, as a string.
  const seconds = typeof raw === "string" ? raw : String(raw);
  if (!/^\d+$/.test(seconds)) {
    return deny("invalid_inbound_timestamp");
  }
  const inboundMs = Number(seconds) * 1000;
  const nowMs = now.getTime();

  if (inboundMs > nowMs + CLOCK_SKEW_MS) {
    return deny("invalid_inbound_timestamp");
  }

  // The window is open for less than 24 hours after the inbound message.
  // Exactly 24 hours is treated as closed.
  if (nowMs - inboundMs >= WINDOW_MS) {
    return deny("customer_service_window_closed");
  }

  return allow();
}

function allow() {
  return { allowed: true, reason: null };
}

function deny(reason) {
  return { allowed: false, reason };
}
