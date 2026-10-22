// Broken B for H3: opt-outs and snoozes live in an in-memory Map, and the snooze is inclusive of `until`.
// Expected FAILS: 5 (a stop written by one process is gone in the next, since each process starts with an empty Map),
// 6 (at exactly 12:00Z the snooze still blocks every channel). Expected PASSES: 1, 2, 3 and 4, which run in one
// process per scenario, and the consent and 11:59:59.999Z checks of 6.
// Keyword rules are the correct whole-message rules. Standalone: node builtins only.
const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const START_WORDS = new Set(["start", "unstop", "yes"]);
const optOut = new Map(); // key `${user}|${channel}`
const snoozes = new Map(); // user -> ms

const keyword = (text) => String(text).trim().toLowerCase().replace(/[\p{P}\p{S}\s]+$/u, "");

export async function handleInbound({ userId, channel, text }) {
  const w = keyword(text);
  const key = `${userId}|${channel}`;
  if (STOP_WORDS.has(w)) optOut.set(key, true);
  else if (START_WORDS.has(w)) optOut.delete(key);
}

export async function snooze({ userId, until }) {
  snoozes.set(userId, until.getTime());
}

export async function trySend({ user, channel, now }) {
  if (user.consent !== true) {
    return { sent: false, reason: "The customer has not given consent to receive messages, so nothing was sent." };
  }
  if (optOut.get(`${user.id}|${channel}`)) {
    return { sent: false, reason: "The customer replied stop on this channel, so no reminder was sent here." };
  }
  const until = snoozes.get(user.id);
  // Mistake: the snooze also blocks at exactly `until`, which should be the first instant it no longer applies.
  if (until !== undefined && now.getTime() <= until) {
    return { sent: false, reason: "Reminders are on snooze for this customer until a later time, so nothing was sent." };
  }
  return { sent: true, reason: null };
}
