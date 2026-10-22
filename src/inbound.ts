import { inboundConsent, inboundKeyFor } from "./checks.js";
import type { Check, Store } from "./types.js";

/** Replies that switch a channel off for a user. Matched on the whole message only. */
export const STOP_KEYWORDS: readonly string[] = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];

/**
 * Replies that switch a channel back on. Matched on the whole message only.
 * YES is a default, not a carrier rule: carrier lists use START and UNSTOP. A user who replied STOP
 * and later answers "yes" to an unrelated confirmation on the same channel is re-subscribed. Pass
 * `keywords` to remove it.
 */
export const START_KEYWORDS: readonly string[] = ["START", "UNSTOP", "YES"];

export type InboundAction = "stop" | "start" | "none";

export interface InboundKeywords {
  stop: readonly string[];
  start: readonly string[];
}

/** One inbound message from a user, on the channel it arrived on. `now` is accepted for callers that log it; it is not stored. */
export interface InboundInput {
  userId: string;
  channel: string;
  text: string;
  now?: Date;
}

export interface InboundResult {
  action: InboundAction;
  channel: string;
}

export interface InboundConsentOptions {
  /** The store the gate is built with. handle() writes here, and the check reads the gate's copy of it. */
  store: Store;
  /** Replaces the default stop or start words. Each list is compared after the same normalisation as the message. */
  keywords?: Partial<InboundKeywords>;
  /**
   * The gate's keyPrefix. handle() writes under this prefix itself, because it writes to the raw store,
   * so it must equal the keyPrefix in the policy or createGate options (default "pg:" on both sides).
   * A mismatch does not throw: the stop is written where the gate never reads it.
   * `createGate` avoids this entirely by exposing `gate.inbound`, which writes through the gate's own store.
   */
  keyPrefix?: string;
}

export interface InboundConsent {
  /**
   * Records a STOP or START for the channel and reports what the text meant. An unrecognised text,
   * or a text that is not a string, changes nothing. An empty channel is treated as "default".
   */
  handle(input: InboundInput): Promise<InboundResult>;
  /** True when the user has replied STOP on the channel and not sent START since. */
  isStopped(userId: string, channel: string): Promise<boolean>;
  /** The `inboundConsent` check. Place it right after `consent` in the checks list. */
  check(): Check;
}

/** A message longer than this, after trimming, cannot be a keyword, so it is refused before any other work. */
const MAX_MESSAGE_LENGTH = 64;

/** Characters removed from both ends: whitespace, punctuation (quotes included), format characters (zero-width), symbols and emoji. */
const EDGE = /[\s\p{P}\p{Cf}\p{S}]/u;

/**
 * Trim, NFKC-normalise (full-width letters and digits become ASCII), uppercase, then strip the edges.
 * Edges are removed one code point at a time from each end, so the cost is linear in the capped length.
 * Returns "" when the message is too long to be a keyword.
 */
const normalise = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length > MAX_MESSAGE_LENGTH) return "";
  const points = Array.from(trimmed.normalize("NFKC").toUpperCase());
  let from = 0;
  let to = points.length;
  while (from < to && EDGE.test(points[from]!)) from++;
  while (to > from && EDGE.test(points[to - 1]!)) to--;
  return points.slice(from, to).join("");
};

/**
 * Classifies a whole message as a stop, a start, or neither. "STOP." and "  quit  " are stops;
 * "stop it", "stopping" and "yes please" are not. A non-string, or a message too long to be a keyword,
 * is "none" and does not throw.
 */
export function parseKeyword(text: unknown, keywords: InboundKeywords = { stop: STOP_KEYWORDS, start: START_KEYWORDS }): InboundAction {
  if (typeof text !== "string") return "none";
  const word = normalise(text);
  if (word === "") return "none";
  if (keywords.stop.some((k) => normalise(k) === word)) return "stop";
  if (keywords.start.some((k) => normalise(k) === word)) return "start";
  return "none";
}

const STOPPED = "stopped";

/**
 * Per-channel STOP and START replies, kept in the store the gate uses. A stop on one channel
 * leaves the others open; a start clears the stop on its channel only.
 *
 * The state is written under `inbound:<userId>:<channel>`. The channel is the candidate's `channel`,
 * else its first surface, else "default", so the string passed to handle() must match that.
 * Stored stops have no expiry; they last until a START arrives.
 *
 * The check follows the gate's onStoreError. Its default, "open", lets a candidate through when the
 * store throws, which would message a user who replied STOP. Where consent is legally required, set
 * `onStoreError: "closed"`. handle() does not catch store errors, so the caller can retry and
 * answer the carrier with a non-200 status.
 */
export function createInboundConsent(options: InboundConsentOptions): InboundConsent {
  const { store } = options;
  const prefix = options.keyPrefix ?? "pg:";
  const keywords: InboundKeywords = { stop: options.keywords?.stop ?? STOP_KEYWORDS, start: options.keywords?.start ?? START_KEYWORDS };
  const keyOf = (userId: string, channel: string) => prefix + inboundKeyFor(userId, channel);

  return {
    async handle({ userId, channel: given, text }) {
      const channel = given || "default";
      const action = parseKeyword(text, keywords);
      if (action === "stop") await store.set(keyOf(userId, channel), STOPPED);
      if (action === "start") await store.del(keyOf(userId, channel));
      return { action, channel };
    },
    async isStopped(userId, channel) {
      // Same mapping as handle(): an empty channel is stored and read under "default".
      return (await store.get(keyOf(userId, channel || "default"))) === STOPPED;
    },
    check() {
      return inboundConsent();
    },
  };
}
