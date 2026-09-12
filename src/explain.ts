/**
 * explain(): a decision rendered as sentences a non-engineer can read.
 *
 * The renderer is a pure function of the decision. Every fact in a sentence
 * comes from a trace entry's own reason or from a decision field, so it can
 * only describe a decision the gate actually made; a check that never ran has
 * no sentence. The machine reasons are the contract both implementations pin
 * word for word, which is what makes them safe to read back here. When a
 * reason does not match what a check emits, the sentence quotes it verbatim
 * rather than guessing.
 *
 * `decision.reason` is unchanged: the plain sentence and the machine reason
 * sit side by side and neither replaces the other.
 */
import type { Decision, TraceEntry } from "./types.js";

/** Fields a parser pulled out of a machine reason; a template reads them. */
export type SentenceFacts = Record<string, string | undefined>;

export type SentenceTemplate = (facts: SentenceFacts) => string;

/**
 * Every sentence the renderer can emit, as one flat template table. A new
 * language is a `Partial<Sentences>` merged over English, so a partial
 * translation still renders. Keys are `check.outcome` plus the summary,
 * note, gate and fallback entries.
 */
export interface Sentences {
  /** A catalog may define keys beyond this table; explain() only reads the named ones. */
  [key: string]: SentenceTemplate | undefined;
  /** Whole-decision line for a reject or defer. `until` is set when the trace names the instant the hold lifts. */
  "summary.held": SentenceTemplate;
  /** Whole-decision line for an allowed decision. `notes` is pre-joined, leading semicolon included. */
  "summary.allowed": SentenceTemplate;
  /** Allowed with an empty trace. */
  "summary.allowedEmpty": SentenceTemplate;
  /** Not allowed but no stopping entry found; the decision was built by hand. */
  "summary.heldUnknown": SentenceTemplate;
  "note.deliverAt": SentenceTemplate;
  "note.nearLimit": SentenceTemplate;
  "note.shadowed": SentenceTemplate;
  /** Wraps a shadowed stop: `body` is the clause the check would have produced. */
  "entry.shadow": SentenceTemplate;

  "killSwitch.pass": SentenceTemplate;
  "killSwitch.reject": SentenceTemplate;
  "consent.pass": SentenceTemplate;
  "consent.reject": SentenceTemplate;
  "enabled.pass": SentenceTemplate;
  "enabled.reject": SentenceTemplate;
  "mode.pass": SentenceTemplate;
  "mode.reject": SentenceTemplate;
  "snooze.pass": SentenceTemplate;
  "snooze.reject": SentenceTemplate;
  "mute.pass": SentenceTemplate;
  "mute.reject": SentenceTemplate;
  "intensity.pass": SentenceTemplate;
  "intensity.reject": SentenceTemplate;
  "quietHours.pass": SentenceTemplate;
  "quietHours.reject": SentenceTemplate;
  "quietHours.skip": SentenceTemplate;
  "trustRamp.pass": SentenceTemplate;
  "trustRamp.reject": SentenceTemplate;
  "trustRamp.skip": SentenceTemplate;
  "dismissalCooldown.pass": SentenceTemplate;
  "dismissalCooldown.reject": SentenceTemplate;
  "adaptiveTiming.pass": SentenceTemplate;
  "adaptiveTiming.adjust": SentenceTemplate;
  "dedupe.pass": SentenceTemplate;
  "dedupe.reject": SentenceTemplate;
  "dedupe.skip": SentenceTemplate;
  "dailyBudget.pass": SentenceTemplate;
  "dailyBudget.reject": SentenceTemplate;
  "weeklyBudget.pass": SentenceTemplate;
  "weeklyBudget.reject": SentenceTemplate;
  "monthlyBudget.pass": SentenceTemplate;
  "monthlyBudget.reject": SentenceTemplate;
  "windowBudget.pass": SentenceTemplate;
  "windowBudget.reject": SentenceTemplate;
  "rateLimit.pass": SentenceTemplate;
  "rateLimit.reject": SentenceTemplate;
  "budget.pass": SentenceTemplate;
  "budget.reject": SentenceTemplate;
  "utilityFloor.pass": SentenceTemplate;
  "utilityFloor.reject": SentenceTemplate;
  "utilityFloor.skip": SentenceTemplate;
  "boundedDeferral.pass": SentenceTemplate;
  "boundedDeferral.adjust": SentenceTemplate;
  "allowedWindow.pass": SentenceTemplate;
  "allowedWindow.reject": SentenceTemplate;
  "allowedWindow.skip": SentenceTemplate;
  "requiresConsent.pass": SentenceTemplate;
  "requiresConsent.reject": SentenceTemplate;
  "requiresConsent.skip": SentenceTemplate;
  "recentInteraction.pass": SentenceTemplate;
  "recentInteraction.reject": SentenceTemplate;

  /** The gate's own trace reasons, not any check's: store failures and ignored non-rejecting stops. */
  "gate.failOpen": SentenceTemplate;
  "gate.failClosed": SentenceTemplate;
  "gate.nonRejecting": SentenceTemplate;

  /** Unknown check ids and reasons that match nothing: quote the trace, invent nothing. */
  "fallback.stop": SentenceTemplate;
  "fallback.pass": SentenceTemplate;
  "fallback.skip": SentenceTemplate;
  "fallback.adjust": SentenceTemplate;
}

/** One trace entry rendered: which check, what it said, and the sentence for it. */
export interface CheckSentence {
  id: string;
  outcome: TraceEntry["outcome"];
  shadow?: boolean;
  sentence: string;
}

export interface Explanation {
  /** The decision as one sentence: "held until 08:00 because ...", "allowed because ...". */
  summary: string;
  /** One sentence per check that ran, in the order it ran. */
  checks: CheckSentence[];
}

export interface ExplainOptions {
  /**
   * Language of the sentences. Only "en" ships with the package; any other
   * code needs a matching entry in `catalogs`, which is merged over English
   * so a partial translation still renders.
   */
  language?: string;
  catalogs?: Record<string, Partial<Sentences>>;
}

/* English ---------------------------------------------------------------- */

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** "1d" to "within the last day", "24h" to "within the last 24 hours": the dedupe window, said long. */
const spanWords = (label: string): string => {
  const m = /^(\d+)([dhms])$/.exec(label);
  if (!m) return `within the last ${label}`;
  const unit = { d: "day", h: "hour", m: "minute", s: "second" }[m[2]!]!;
  const n = Number(m[1]);
  return n === 1 ? `within the last ${unit}` : `within the last ${plural(n, unit)}`;
};

/** "86400" to "day", "7200" to "2 hours": a rate-limit period in seconds, said long. */
const secondsWords = (text: string): string => {
  const n = Number(text);
  if (!Number.isFinite(n)) return `${text} seconds`;
  // "per hour", not "per 1 hour": the same singular spanWords already says as "the last day".
  const period = (count: number, unit: string) => (count === 1 ? unit : plural(count, unit));
  if (n % 86400 === 0) return period(n / 86400, "day");
  if (n % 3600 === 0) return period(n / 3600, "hour");
  if (n % 60 === 0) return period(n / 60, "minute");
  return period(n, "second");
};

/** The spend note is true only when the pass really read the counter: a bypassed budget returns a bare pass, a near-limit pass cannot be a bypass. */
const budgetPass = (label: string): SentenceTemplate => (f) =>
  f.used !== undefined
    ? `the ${label} had room, but only just: ${f.used} of ${f.limit} already used; the unit is spent when the message actually goes out`
    : `the ${label} did not stop it`;

const budgetReject = (label: string): SentenceTemplate => (f) => `the ${label} of ${f.limit} was already spent (${f.used} used)`;

export const en: Sentences = {
  "summary.held": (f) => `held${f.until ? ` until ${f.until}` : ""} because ${f.clause}`,
  "summary.allowed": (f) => `allowed at ${f.at} because no check stopped it${f.notes ?? ""}`,
  "summary.allowedEmpty": () => "allowed; no checks ran",
  "summary.heldUnknown": () => "held; the trace does not name the check that stopped it",
  "note.deliverAt": (f) => `delivery waits until ${f.at}`,
  "note.nearLimit": (f) => `${f.check} was close to its limit (${f.used} of ${f.limit} used)`,
  "note.shadowed": (f) => `${f.check} would have stopped it but ran in shadow mode`,
  "entry.shadow": (f) => `it would have stopped the message (${f.body}), but the check ran in shadow mode so evaluation continued`,

  "killSwitch.pass": () => "the kill switch was off",
  "killSwitch.reject": () => "the kill switch is on, which stops every message",
  "consent.pass": () => "the user has agreed to proactive messages",
  "consent.reject": () => "the user has not agreed to proactive messages",
  "enabled.pass": () => "proactive messages are switched on for this profile",
  "enabled.reject": () => "proactive messages are switched off on this user's profile",
  "mode.pass": () => "the user's operating mode did not block it",
  "mode.reject": (f) => `the user's operating mode is "${f.mode}", which does not allow proactive messages`,
  "snooze.pass": () => "no snooze was in effect",
  "snooze.reject": (f) => `the user has snoozed the assistant until ${f.until}`,
  "mute.pass": () => "this type of message is not muted",
  "mute.reject": (f) => `the user has muted "${f.type}" messages`,
  "intensity.pass": () => "the message's priority satisfied the user's intensity setting",
  "intensity.reject": (f) => `the message was ${f.priority} priority, and the user's "${f.level}" intensity setting allows only ${f.floor} and above`,
  "quietHours.pass": () => "quiet hours did not block it",
  "quietHours.reject": (f) =>
    `the user's quiet hours run ${f.start} to ${f.end} ${f.tz}${f.from ? `, a window belonging to ${f.from},` : ""} and ${f.priority} priority is below the ${f.floor} floor needed to override them`,
  "quietHours.skip": () => "the user has quiet hours but no time zone, so the check could not run",
  "trustRamp.pass": () => "the new-user trust period did not block it",
  "trustRamp.reject": (f) => `the user is on day ${f.day} of a ${f.days}-day trust period for new users, which allows only ${f.floor} priority and above, and the message was ${f.priority}`,
  "trustRamp.skip": () => "the user's sign-up date is not on record, so the new-user trust period could not be checked",
  "dismissalCooldown.pass": () => "the user has not dismissed this type enough to silence it",
  "dismissalCooldown.reject": (f) => `the user has dismissed "${f.type}" messages ${f.count} times in ${f.within} days, so this type stays silent until ${f.until}`,
  "adaptiveTiming.pass": () => "the timing check left the message as it was",
  "adaptiveTiming.adjust": (f) =>
    f.at && f.surfaces
      ? `delivery was moved to ${f.at} and narrowed to ${f.surfaces.split(",").join(", ")}`
      : f.at
        ? `delivery was moved to ${f.at}`
        : `delivery was narrowed to ${(f.surfaces ?? "").split(",").join(", ")}`,
  "dedupe.pass": () => "this event had not already produced a message; the event is claimed when the message actually goes out",
  "dedupe.reject": (f) => `the same event already produced a message ${spanWords(f.window ?? "")}`,
  "dedupe.skip": () => "the candidate carried no event key, so duplicate detection could not run",
  "dailyBudget.pass": budgetPass("daily budget"),
  "dailyBudget.reject": budgetReject("user's daily budget"),
  "weeklyBudget.pass": budgetPass("weekly budget"),
  "weeklyBudget.reject": budgetReject("user's weekly budget"),
  "monthlyBudget.pass": budgetPass("monthly budget"),
  "monthlyBudget.reject": budgetReject("user's monthly budget"),
  "windowBudget.pass": budgetPass("window budget"),
  "windowBudget.reject": (f) => `the budget for the window opened by the user's last message was already spent (${f.used} of ${f.limit} used)`,
  "rateLimit.pass": () => "the rate limit did not stop it",
  "rateLimit.reject": (f) => `the rate limit of ${f.limit} messages per ${secondsWords(f.per ?? "")} was already reached (${f.used} used)`,
  "budget.pass": (f) => `the budget had room, but only just: ${f.used} of ${f.limit} already used; the unit is spent when the message actually goes out`,
  "budget.reject": (f) => `the ${f.label} was already used up (${f.used} of ${f.limit} used)`,
  "utilityFloor.pass": () => "the estimated acceptance chance cleared the utility floor",
  "utilityFloor.reject": (f) => `the estimated chance the user would accept this message was ${f.pAccept}, below the utility floor of ${f.tau}`,
  "utilityFloor.skip": () => "the candidate carried no acceptance estimate, so the utility floor could not run",
  "boundedDeferral.pass": () => "the user did not look busy",
  "boundedDeferral.adjust": (f) => `the user looked busy, so delivery was deferred ${f.tStar} seconds to ${f.at}`,
  "allowedWindow.pass": (f) => (f.name ? `the "${f.name}" allowed window did not block it` : "the allowed window did not block it"),
  "allowedWindow.reject": (f) => `messages may only go out between ${f.start} and ${f.end} (${f.zone}), and the local time was outside that window`,
  "allowedWindow.skip": () => "the user has no time zone, so the allowed window could not be checked",
  "requiresConsent.pass": (f) => (f.name ? `the "${f.name}" consent the check needs was in place` : "the consent the check needs was in place"),
  "requiresConsent.reject": (f) => `the user has not given the required "${f.name}" consent${f.start ? `, which applies between ${f.start} and ${f.end}` : ""}`,
  "requiresConsent.skip": () => "the user has no time zone, so the hours this consent applies could not be checked",
  "recentInteraction.pass": () => "the user had written to the assistant recently enough",
  "recentInteraction.reject": (f) =>
    f.age ? `the user's last message to the assistant was ${f.age} h ago, outside the ${f.within} h window` : "the user has never written to the assistant, and this rule allows messages only after they do",

  "gate.failOpen": (f) => `the "${f.id}" check failed with "${f.error}", and the gate is set to let messages through when a check fails`,
  "gate.failClosed": (f) => `the "${f.id}" check failed with "${f.error}", and the gate is set to stop messages when a check fails`,
  "gate.nonRejecting": (f) => `the "${f.id}" check tried to ${f.kind} ("${f.reason}") but is marked non-rejecting, so the gate ignored it`,

  "fallback.stop": (f) => `the "${f.id}" check stopped it: ${f.reason}`,
  "fallback.pass": (f) => `the "${f.id}" check let it through${f.reason ? ` (${f.reason})` : ""}`,
  "fallback.skip": (f) => `the "${f.id}" check did not weigh in: ${f.reason}`,
  "fallback.adjust": (f) => `the "${f.id}" check adjusted it: ${f.reason}`,
};

/* Reading the machine reasons back into facts ----------------------------- */

type Parser = (reason: string) => SentenceFacts | null;

const match = (pattern: RegExp, keys: string[]): Parser => (reason) => {
  const m = pattern.exec(reason);
  if (!m) return null;
  const facts: SentenceFacts = {};
  keys.forEach((key, i) => {
    const value = m[i + 1];
    if (value !== undefined) facts[key] = value;
  });
  return facts;
};

const fixed = (text: string): Parser => (reason) => (reason === text ? {} : null);

const first = (...parsers: Parser[]): Parser => (reason) => {
  for (const parse of parsers) {
    const facts = parse(reason);
    if (facts) return facts;
  }
  return null;
};

const BUDGET_STOP = match(/^.* of (\d+) used \((\d+)\)$/, ["limit", "used"]);
const BUDGET_NEAR = match(/^(\d+) of (\d+) used$/, ["used", "limit"]);

const parseQuietHours: Parser = (reason) => {
  const m = /^quiet hours (\S+) to (\S+)(?: \((\w+) (\S+)\))? (\S+); priority (\w+) is below the floor \((\w+)\)$/.exec(reason);
  if (!m) return null;
  // holdUntil is the fact the summary headlines ("held until 08:00"); checks
  // whose clause already says the instant (snooze, cooldown) leave it unset.
  const facts: SentenceFacts = { start: m[1], end: m[2], tz: m[5], priority: m[6], floor: m[7], holdUntil: m[2] };
  if (m[3] !== undefined) facts.from = `${m[3]} ${m[4]}`;
  return facts;
};

interface Parsers {
  /** Stopping reasons: reject and defer share the same wording. */
  stop?: Parser;
  /** A pass that carries a reason, like a budget near its limit. */
  passReason?: Parser;
  /** Facts recoverable from the check id itself, like consent:ad's name. */
  idFacts?: (id: string) => SentenceFacts;
  skip?: Parser;
  adjust?: Parser;
}

const PARSERS: Record<string, Parsers> = {
  killSwitch: { stop: fixed("engine kill switch is on") },
  consent: { stop: fixed("user has not consented to proactive behaviour") },
  enabled: { stop: fixed("proactive behaviour is disabled on this profile") },
  mode: { stop: match(/^operating mode "(.+)" does not allow proactive messages$/, ["mode"]) },
  snooze: { stop: match(/^snoozed until (.+)$/, ["until"]) },
  mute: { stop: match(/^type "(.+)" is muted by the user$/, ["type"]) },
  intensity: { stop: match(/^priority (\w+) is below the "(\w+)" intensity floor \((\w+)\)$/, ["priority", "level", "floor"]) },
  quietHours: { stop: parseQuietHours, skip: fixed("quiet hours set but no timezone on the user; cannot evaluate") },
  trustRamp: { stop: match(/^trust ramp: day (\d+) of (\S+), priority (\w+) is below (\w+)$/, ["day", "days", "priority", "floor"]), skip: fixed("no createdAt on the user; ramp cannot be evaluated") },
  dismissalCooldown: { stop: match(/^(\d+) dismissals of "(.+)" in (\S+) days; silent until (.+)$/, ["count", "type", "within", "until"]) },
  adaptiveTiming: { adjust: first(match(/^deliver at (\S+); surfaces (.+)$/, ["at", "surfaces"]), match(/^deliver at (\S+)$/, ["at"]), match(/^surfaces (.+)$/, ["surfaces"])) },
  dedupe: { stop: match(/^already delivered within the last (.+)$/, ["window"]), skip: fixed("no dedupeKey on the candidate; deduplication cannot be evaluated") },
  dailyBudget: { stop: BUDGET_STOP, passReason: BUDGET_NEAR },
  weeklyBudget: { stop: BUDGET_STOP, passReason: BUDGET_NEAR },
  monthlyBudget: { stop: BUDGET_STOP, passReason: BUDGET_NEAR },
  windowBudget: { stop: BUDGET_STOP, passReason: BUDGET_NEAR },
  rateLimit: { stop: match(/^rate limit (\d+) per (\d+) s of \d+ used \((\d+)\)$/, ["limit", "per", "used"]), passReason: BUDGET_NEAR },
  utilityFloor: { stop: match(/^pAccept (\S+) < tau (\S+)$/, ["pAccept", "tau"]), skip: fixed("no pAccept on the candidate; utility floor cannot be evaluated") },
  boundedDeferral: { adjust: match(/^user busy; deliver at (\S+) \(t\* (\d+) s\)$/, ["at", "tStar"]) },
  allowedWindow: {
    stop: match(/^outside the allowed window (\S+) to (\S+) (.+)$/, ["start", "end", "zone"]),
    idFacts: (id) => (id.startsWith("window:") ? { name: id.slice("window:".length) } : {}),
    skip: fixed("no timezone on the user; window cannot be evaluated"),
  },
  requiresConsent: {
    stop: match(/^consent "(.+)" is missing(?: \(required (\S+) to (\S+)\))?$/, ["name", "start", "end"]),
    idFacts: (id) => (id.startsWith("consent:") ? { name: id.slice("consent:".length) } : {}),
    skip: fixed("no timezone on the user; consent window cannot be evaluated"),
  },
  recentInteraction: {
    stop: first(fixed("no inbound message from the user on record"), match(/^last inbound message (\d+) h ago, window is (\S+) h$/, ["age", "within"])),
  },
};

/** The ids the package itself emits: the fixed check ids, plus consent:<name>, rate:<limit>/<period>s and window:<name>. */
const keyForId = (id: string): string | undefined => {
  if (id in PARSERS) return id;
  if (id.startsWith("consent:")) return "requiresConsent";
  if (id.startsWith("rate:")) return "rateLimit";
  if (id.startsWith("window:")) return "allowedWindow";
  return undefined;
};

/** The gate's own trace entries: a store failure, or a non-rejecting check that tried to stop evaluation anyway. */
const GATE_ENTRIES: Array<{ key: string; parse: Parser }> = [
  { key: "gate.failOpen", parse: match(/^check threw \((.*)\); failing open$/, ["error"]) },
  { key: "gate.failClosed", parse: match(/^check threw \((.*)\); failing closed$/, ["error"]) },
  { key: "gate.nonRejecting", parse: match(/^non-rejecting check returned (\w+) \((.*)\); ignored$/, ["kind", "reason"]) },
];

/**
 * Custom ids (a preset's "window:kakao", a caller's own wrapper) still emit the
 * check's reason, so an unmatched id falls back to recognizing the reason's
 * shape. Order is distinctiveness: each pattern names the check it sounds like.
 */
const STOP_SCAN = ["quietHours", "allowedWindow", "requiresConsent", "rateLimit", "dismissalCooldown", "snooze", "mute", "mode", "intensity", "trustRamp", "dedupe", "utilityFloor", "recentInteraction", "killSwitch", "consent", "enabled"] as const;
const SKIP_SCAN = ["quietHours", "trustRamp", "dedupe", "utilityFloor", "allowedWindow", "requiresConsent"] as const;
const ADJUST_SCAN = ["adaptiveTiming", "boundedDeferral"] as const;

const BUDGET_LABELS: Record<string, string> = { "daily budget": "dailyBudget", "weekly budget": "weeklyBudget", "monthly budget": "monthlyBudget", "window budget": "windowBudget" };

/** A "label of N used (M)" reason from a budget whose id we do not know. */
const scanBudget = (reason: string): { key: string; facts: SentenceFacts } | null => {
  const m = /^(.+) of (\d+) used \((\d+)\)$/.exec(reason);
  if (!m) return null;
  const known = BUDGET_LABELS[m[1]!];
  const facts: SentenceFacts = { label: m[1], limit: m[2], used: m[3] };
  return { key: known ?? "budget", facts };
};

const cap = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);
const sentenceOf = (fragment: string) => `${cap(fragment)}.`;

const t = (s: Sentences, key: string, facts: SentenceFacts) => s[key]?.(facts) ?? en[key]?.(facts) ?? facts.reason ?? "";

/** The stopping entry's clause and, when the trace names it, the instant the hold lifts. */
function stopFacts(entry: TraceEntry): { template: string; facts: SentenceFacts } {
  const reason = entry.reason ?? "";
  for (const g of GATE_ENTRIES) {
    const facts = g.parse(reason);
    if (facts) return { template: g.key, facts: { id: entry.id, ...facts } };
  }
  const key = keyForId(entry.id);
  if (key && PARSERS[key]?.stop) {
    const facts = PARSERS[key].stop!(reason);
    if (facts) return { template: `${key}.reject`, facts };
  }
  for (const k of STOP_SCAN) {
    const facts = PARSERS[k]?.stop?.(reason);
    if (facts) return { template: `${k}.reject`, facts };
  }
  const budget = scanBudget(reason);
  if (budget) return { template: `${budget.key}.reject`, facts: budget.facts };
  return { template: "fallback.stop", facts: { id: entry.id, reason } };
}

function entryBody(entry: TraceEntry, s: Sentences): string {
  const reason = entry.reason ?? "";
  const key = keyForId(entry.id);
  switch (entry.outcome) {
    case "reject":
    case "defer": {
      const stop = stopFacts(entry);
      return t(s, stop.template, stop.facts);
    }
    case "pass": {
      if (reason) {
        const facts = key ? PARSERS[key]?.passReason?.(reason) : BUDGET_NEAR(reason);
        if (facts) return t(s, `${key ?? "budget"}.pass`, facts);
        return t(s, "fallback.pass", { id: entry.id, reason });
      }
      const facts = key ? (PARSERS[key]?.idFacts?.(entry.id) ?? {}) : {};
      return t(s, key ? `${key}.pass` : "fallback.pass", { id: entry.id, ...facts });
    }
    case "skip": {
      for (const g of GATE_ENTRIES) {
        const facts = g.parse(reason);
        if (facts) return t(s, g.key, { id: entry.id, ...facts });
      }
      if (key && PARSERS[key]?.skip) {
        const facts = PARSERS[key].skip!(reason);
        if (facts) return t(s, `${key}.skip`, facts);
      }
      for (const k of SKIP_SCAN) {
        const facts = PARSERS[k]?.skip?.(reason);
        if (facts) return t(s, `${k}.skip`, facts);
      }
      return t(s, "fallback.skip", { id: entry.id, reason });
    }
    case "adjust": {
      if (key && PARSERS[key]?.adjust) {
        const facts = PARSERS[key].adjust!(reason);
        if (facts) return t(s, `${key}.adjust`, facts);
      }
      for (const k of ADJUST_SCAN) {
        const facts = PARSERS[k]?.adjust?.(reason);
        if (facts) return t(s, `${k}.adjust`, facts);
      }
      return t(s, "fallback.adjust", { id: entry.id, reason });
    }
  }
}

function explainEntry(entry: TraceEntry, s: Sentences): CheckSentence {
  const body = entryBody(entry, s);
  // Shadow is only a would-have-stopped when the outcome could have stopped.
  const shadowedStop = entry.shadow === true && (entry.outcome === "reject" || entry.outcome === "defer");
  return {
    id: entry.id,
    outcome: entry.outcome,
    ...(entry.shadow ? { shadow: true } : {}),
    sentence: sentenceOf(shadowedStop ? t(s, "entry.shadow", { body }) : body),
  };
}

function summarize(decision: Decision, s: Sentences): string {
  if (decision.allowed) {
    if (!decision.trace.length) return sentenceOf(t(s, "summary.allowedEmpty", {}));
    const notes: string[] = [];
    if (decision.deliverAt) notes.push(t(s, "note.deliverAt", { at: decision.deliverAt.toISOString() }));
    for (const n of decision.nearLimit) notes.push(t(s, "note.nearLimit", { check: n.check, used: String(n.used), limit: String(n.limit) }));
    for (const id of decision.shadowed) notes.push(t(s, "note.shadowed", { check: id }));
    return sentenceOf(t(s, "summary.allowed", { at: decision.evaluatedAt.toISOString(), notes: notes.length ? `; ${notes.join("; ")}` : "" }));
  }
  const stopId = decision.rejectedBy ?? decision.deferredBy;
  const entry = stopId ? [...decision.trace].reverse().find((e) => e.id === stopId && (e.outcome === "reject" || e.outcome === "defer")) : undefined;
  if (!entry) return sentenceOf(t(s, "summary.heldUnknown", {}));
  const stop = stopFacts(entry);
  const clause = t(s, stop.template, stop.facts);
  // For a deferral the hold ends at retryAt; when the clause already names the
  // instant (snooze's reason is "snoozed until X"), naming it twice reads worse.
  const clauseSaysWhen = stop.facts.until !== undefined;
  const until = stop.facts.holdUntil ?? (!clauseSaysWhen && decision.deferredBy ? decision.retryAt?.toISOString() : undefined);
  return sentenceOf(t(s, "summary.held", { clause, ...(until ? { until } : {}) }));
}

/**
 * Render a decision as sentences. Deterministic: the same decision always
 * produces the same explanation, and nothing outside the decision is read.
 */
export function explain(decision: Decision, options: ExplainOptions = {}): Explanation {
  const language = options.language ?? "en";
  const overlay = options.catalogs?.[language];
  if (language !== "en" && !overlay) {
    throw new Error(`no sentence catalog for language "${language}"; pass one with the catalogs option`);
  }
  const s: Sentences = { ...en, ...overlay };
  return { summary: summarize(decision, s), checks: decision.trace.map((entry) => explainEntry(entry, s)) };
}
