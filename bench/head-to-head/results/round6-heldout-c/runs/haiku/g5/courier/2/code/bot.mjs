// Follow-up gate for the WhatsApp / SMS support assistant.
// State is in memory only; it is lost on process restart.
//
// onInbound(userId, text, at) records every customer message.
// check(userId, type, now) decides whether a follow-up may be sent.

const DAY_MS = 24 * 60 * 60 * 1000;

// Carrier (CTIA) opt-out keywords. Matched only when the whole message is the keyword.
const STOP_WORDS = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit']);

// Carrier opt-in keywords. "yes" is left out on purpose: it is too common as a reply to unrelated questions.
const START_WORDS = new Set(['start', 'start again', 'unstop']);

// Unambiguous whole-message opt-out requests written as sentences.
const OPT_OUT_PHRASES = [
  /^(please )?(stop|quit) (texting|messaging|sending)( me)?( texts| messages)?( anymore| any more)?( please)?$/,
  /^(please )?(unsubscribe|remove) me( please)?$/,
  /^(please )?(don't|do not) (text|message|contact|sms) me( anymore| any more)?( please)?$/,
];

// customerId -> { lastInboundAt, stopAt, startAt }, all epoch milliseconds
const customers = new Map();

// Lowercase, strip invisible characters and edge punctuation/emoji, collapse spaces.
// "STOP!", " stop. ", "stop 🛑" and "S​top" all become "stop".
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\p{Cf}/gu, '')
    .replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function classify(text) {
  const key = normalize(text);
  if (STOP_WORDS.has(key) || OPT_OUT_PHRASES.some((re) => re.test(key))) return 'stop';
  if (START_WORDS.has(key)) return 'start';
  return null;
}

function validDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value.getTime();
}

export function onInbound(userId, text, at) {
  const t = validDate(at, 'at');
  const c = customers.get(userId) ?? { lastInboundAt: -Infinity, stopAt: -Infinity, startAt: -Infinity };

  c.lastInboundAt = Math.max(c.lastInboundAt, t);

  const kind = classify(text);
  if (kind === 'stop') c.stopAt = Math.max(c.stopAt, t);
  if (kind === 'start') c.startAt = Math.max(c.startAt, t);

  customers.set(userId, c);
}

function allow() {
  return { allowed: true, rule: null };
}

function deny(rule) {
  return { allowed: false, rule };
}

export function check(userId, type, now) {
  if (type !== 'freeform' && type !== 'template') return deny('unknown-type');
  const n = validDate(now, 'now');

  const c = customers.get(userId);

  // The later event wins; on an exact tie, stop wins.
  if (c && c.stopAt !== -Infinity && c.stopAt >= c.startAt) return deny('opted-out');

  // No inbound message ever means no evidence of consent. Never cold-contact.
  if (!c || c.lastInboundAt === -Infinity) return deny('no-prior-inbound');

  // Approved templates may be sent outside the 24-hour customer service window.
  if (type === 'template') return allow();

  // Free text is allowed only inside 24 hours of the customer's last message.
  // A negative age (now before last inbound) is treated as outside the window.
  const age = n - c.lastInboundAt;
  if (age >= 0 && age < DAY_MS) return allow();
  return deny('outside-24h-window');
}
