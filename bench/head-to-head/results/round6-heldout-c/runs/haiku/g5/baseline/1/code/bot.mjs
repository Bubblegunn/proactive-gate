// Gate for assistant-initiated follow-ups (WhatsApp Business + SMS).
// State is in memory only. Fails closed: anything unclear is denied.

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole-message opt-out keywords (CTIA-style). Matched exactly, never as a
// substring, so "I can't stop thinking about my bill" is normal conversation.
const STOP_WORDS = new Set([
  'stop',
  'stopall',
  'stop all',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'opt out',
  'optout',
]);

// Re-opt-in keywords. "yes" is deliberately excluded: it is an answer to a
// question, not a clear request to resume messages after a STOP.
const START_WORDS = new Set(['start', 'unstop']);

// Lowercases, folds full-width/compatibility forms, drops invisible format
// characters (zero-width space, BOM, soft hyphen), and turns every run of
// non-letter/non-digit characters into one space. So "  STOP!! ", "Stop." and
// "stop-all" reduce to the keywords above, while "stop, I said" does not.
// Spaced-out letters ("S T O P") are joined so they are not missed.
function keyword(text) {
  if (typeof text !== 'string') return '';
  const word = text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  const parts = word.split(' ');
  return parts.length > 1 && parts.every((p) => p.length === 1) ? parts.join('') : word;
}

// userId -> { lastInboundMs: number | null, optedOut: boolean }
const users = new Map();

function stateFor(userId) {
  let state = users.get(userId);
  if (!state) {
    state = { lastInboundMs: null, optedOut: false };
    users.set(userId, state);
  }
  return state;
}

export function onInbound(userId, text, at) {
  const state = stateFor(userId);

  // Opt-out handling does not depend on the timestamp: a valid STOP must
  // always take effect, even if `at` is malformed.
  const word = keyword(text);
  if (STOP_WORDS.has(word)) {
    state.optedOut = true;
  } else if (START_WORDS.has(word)) {
    state.optedOut = false;
  }

  const ms = at instanceof Date ? at.getTime() : NaN;
  if (Number.isFinite(ms) && (state.lastInboundMs === null || ms > state.lastInboundMs)) {
    state.lastInboundMs = ms;
  }
}

function allow() {
  return { allowed: true, rule: null };
}

function deny(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  if (type !== 'freeform' && type !== 'template') {
    return deny('unknown_message_type');
  }

  const state = users.get(userId);
  if (!state) return deny('no_prior_inbound');
  if (state.optedOut) return deny('opted_out');
  if (state.lastInboundMs === null) return deny('no_prior_inbound');

  // Approved templates may be sent outside the 24-hour customer window.
  if (type === 'template') return allow();

  // Freeform text is only allowed within 24 hours of the customer's last
  // inbound message. A `now` earlier than that message is treated as invalid.
  const nowMs = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(nowMs) || nowMs < state.lastInboundMs) {
    return deny('invalid_now');
  }
  if (nowMs - state.lastInboundMs >= DAY_MS) {
    return deny('outside_24h_window');
  }
  return allow();
}
