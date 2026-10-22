import { KNOWN_CHECKS } from "./policy.js";
import { presets } from "./presets.js";

/** The JSON Schema subset the generated document uses. */
export type JsonSchema = Record<string, unknown>;

const PRIORITY: JsonSchema = { $ref: "#/$defs/priority" };
const number = (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: "number", description, ...extra });
const hhmm = (description: string): JsonSchema => ({ $ref: "#/$defs/hhmm", description });

/** What one check is for and the options it reads. The generator refuses a check that has no entry here. */
export interface CheckDoc {
  description: string;
  options: Record<string, JsonSchema>;
}

const BUDGET_OPTIONS: Record<string, JsonSchema> = {
  limit: number("Deliveries allowed per period.", { minimum: 0 }),
  bypassPriority: { ...PRIORITY, description: "Candidates at or above this priority are not counted." },
  nearLimit: number("Fraction of the limit at which a pass carries a nearLimit note.", { exclusiveMinimum: 0, maximum: 1 }),
  tiers: { type: "object", additionalProperties: { type: "number", minimum: 0 }, description: "Limit per user tier. A user's explicit dailyLimit still wins for the daily budget." },
};

/**
 * The options each check in KNOWN_CHECKS reads, with their types. Keys are checked against the
 * options the factories actually read (see test/policy-schema.test.ts), so a renamed option cannot
 * leave this table behind.
 */
export const CHECK_DOCS: Record<string, CheckDoc> = {
  killSwitch: { description: "Rejects every candidate while on is true, or while the named runtime flag is false.", options: { on: { type: "boolean", description: "True to silence everything. Not with flag." }, flag: { type: "string", description: "Name of a runtime flag. The check rejects while it is false. Not with on." } } },
  consent: { description: "Rejects users who have not consented to proactive behaviour, or whose consent is unknown and no surface fails open.", options: { failMode: { type: "object", additionalProperties: { enum: ["open", "closed"] }, description: "Per-surface fail mode used when consent is unknown. A key default sets the rest; closed when unset." } } },
  enabled: { description: "Rejects profiles with proactive behaviour switched off.", options: {} },
  mode: { description: "Only these operating modes may receive proactive messages.", options: { allow: { type: "array", items: { type: "string" }, description: "Allowed modes. Default [\"normal\"]." } } },
  snooze: { description: "A global pause until user.snoozedUntil.", options: { defer: { type: "boolean", description: "True to defer with retryAt instead of rejecting." } } },
  mute: { description: "Rejects candidate types the user muted.", options: {} },
  intensity: {
    description: "Maps the user's intensity setting to a priority floor.",
    options: {
      floors: {
        type: "object",
        additionalProperties: false,
        properties: { low: PRIORITY, normal: PRIORITY, high: PRIORITY },
        description: "Priority floor per intensity setting.",
      },
    },
  },
  quietHours: { description: "Rejects inside the user's quiet hours, in the user's time zone.", options: { priorityFloor: { ...PRIORITY, description: "Candidates at or above this priority pass. Default critical." }, onMissingTimezone: { enum: ["skip", "reject"], description: "With no usable zone: skip (default) or reject." } } },
  trustRamp: { description: "For the first days after sign-up only high priority gets through.", options: { days: number("Length of the ramp in days.", { minimum: 0 }), minPriority: { ...PRIORITY, description: "Lowest priority allowed during the ramp." } } },
  dismissalCooldown: {
    description: "Silences a candidate type after repeated dismissals.",
    options: { dismissals: number("Dismissals that trigger the silence.", { minimum: 1 }), withinDays: number("Window in which they are counted.", { minimum: 1 }), silenceDays: number("How long the type stays silent.", { minimum: 1 }), exemptTypes: { type: "array", items: { type: "string" }, description: "Candidate types the cooldown never silences." } },
  },
  adaptiveTiming: { description: "Never rejects. Lets the caller move delivery to a better moment.", options: {} },
  dedupe: { description: "One delivery per event per window, claimed at commit.", options: { windowSeconds: number("Deduplication window in seconds.", { minimum: 1 }) } },
  dailyBudget: { description: "At most limit deliveries per user per local day.", options: BUDGET_OPTIONS },
  weeklyBudget: { description: "At most limit deliveries per user per local ISO week.", options: BUDGET_OPTIONS },
  monthlyBudget: { description: "At most limit deliveries per user per local month.", options: BUDGET_OPTIONS },
  utilityFloor: { description: "Acts only when the caller's pAccept clears the expected-utility threshold.", options: { costFalseAlarm: number("Cost of alerting when the user did not want it.", { minimum: 0 }), costMissedHelp: number("Cost of staying silent when the user needed it.", { minimum: 0 }) } },
  boundedDeferral: {
    description: "Never rejects. Delays delivery while the user is busy.",
    options: { lambda: number("Rate at which the user becomes free."), interruptCost: number("Cost of interrupting a busy user."), staleness: number("Staleness scale."), boundSeconds: number("Longest wait in seconds.", { minimum: 0 }) },
  },
  allowedWindow: {
    description: "Deliveries only inside [start, end) local time.",
    options: { start: hhmm("Window start."), end: hhmm("Window end."), timezone: { type: "string", description: "IANA zone, or \"user\" for the user's own." }, priorityFloor: PRIORITY },
  },
  requiresConsent: {
    description: "Requires user.consents[name], always or only inside a local-time window.",
    options: {
      name: { type: "string", description: "Key in user.consents." },
      exemptTransactional: { type: "boolean", description: "True to let a candidate that is not promotional through without the consent: transactional, requested or a commitment." },
      when: { type: "object", additionalProperties: false, required: ["start", "end", "timezone"], properties: { start: hhmm("Window start."), end: hhmm("Window end."), timezone: { type: "string" } }, description: "Only inside this window." },
    },
  },
  rateLimit: {
    description: "Fixed-window rate limit keyed by user or channel.",
    options: { limit: number("Deliveries per window.", { minimum: 0 }), perSeconds: number("Window length in seconds.", { minimum: 1 }), keyBy: { enum: ["user", "channel"], description: "What the counter is keyed by." } },
  },
  recentInteraction: { description: "The user wrote to the assistant within the last withinHours.", options: { withinHours: number("Hours since the last inbound message.", { minimum: 0 }) } },
  windowBudget: { description: "At most limit deliveries in the window that opened with the user's last message.", options: { limit: number("Deliveries per window.", { minimum: 0 }), withinHours: number("Window length in hours.", { minimum: 0 }) } },
  freshness: { description: "Refuses content at or after its freshUntil instant, or older than maxAgeSeconds when that is set.", options: { maxAgeSeconds: number("Oldest content allowed, in seconds, counted from createdAt.", { minimum: 0 }) } },
  silence: { description: "Refuses a candidate whose caller-supplied evidence is too thin or repeats nothing new.", options: { minDataPoints: number("Fewest data points the evidence must count.", { minimum: 0 }), minConfidence: number("Lowest confidence the evidence must carry.", { minimum: 0, maximum: 1 }), requireNew: { type: "boolean", description: "True to refuse a candidate that says nothing is new. Default true." } } },
  deadHours: {
    description: "Takes push off the table in an hour when the user acted on too little of what they were sent then. Never rejects.",
    options: {
      minSamples: number("Samples the hour needs before its rate counts.", { minimum: 0 }),
      maxActRate: number("Acted share below which the hour is dead.", { minimum: 0, maximum: 1 }),
      minPriority: { ...PRIORITY, description: "Candidates at or above this priority keep push. Default high." },
    },
  },
  crisisQuiet: { description: "Only support candidates pass while the user is in a crisis-support quiet period.", options: {} },
};

/** The options a preset reads from its entry. Presets not listed read none. */
export const PRESET_OPTIONS: Record<string, Record<string, JsonSchema>> = {
  lineMessagingApi: { plan: { enum: ["communication", "light", "standard"], description: "LINE pricing plan." } },
  whatsappBusiness: { template: { type: "boolean", description: "True for an approved template message, which may be sent outside the 24-hour window." } },
  assistantNudge: {
    dailyLimit: number("Deliveries a day before the budget refuses. Default 3.", { minimum: 0 }),
    exemptTypes: { type: "array", items: { type: "string" }, description: "Candidate types the dismissal cooldown never silences." },
  },
};

const firstSentence = (text: string): string => {
  const end = text.search(/\.\s/);
  return end === -1 ? text : text.slice(0, end + 1);
};

/** The policy document as a JSON Schema, generated from KNOWN_CHECKS and presets so it cannot list a check that does not exist. */
export function policySchema(): JsonSchema {
  const checkIds = Object.keys(KNOWN_CHECKS);
  const missing = checkIds.filter((id) => !(id in CHECK_DOCS));
  const stale = Object.keys(CHECK_DOCS).filter((id) => !(id in KNOWN_CHECKS));
  if (missing.length || stale.length) {
    throw new Error(`CHECK_DOCS and KNOWN_CHECKS disagree: missing ${JSON.stringify(missing)}, stale ${JSON.stringify(stale)}`);
  }
  const shadow: JsonSchema = { type: "boolean", description: "True to record what the check would do without letting it decide." };
  const entries: JsonSchema[] = [
    ...checkIds.map((id) => {
      const doc = CHECK_DOCS[id]!;
      return {
        title: id,
        description: doc.description,
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { const: id }, shadow, ...doc.options },
      };
    }),
    ...Object.entries(presets).map(([name, preset]) => ({
      title: name,
      description: firstSentence(preset.note),
      type: "object",
      additionalProperties: false,
      required: ["preset"],
      properties: { preset: { const: name }, shadow, ...(PRESET_OPTIONS[name] ?? {}) },
    })),
  ];
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/Bubblegunn/proactive-gate/spec/schema/policy.strict.schema.json",
    title: "proactive-gate policy",
    description: "Generated by `npm run schema` from the checks and presets the package knows. Rejects unknown check ids, preset names and options.",
    type: "object",
    additionalProperties: false,
    required: ["specVersion", "checks"],
    properties: {
      $schema: { type: "string" },
      specVersion: { type: "string", pattern: "^1\\.\\d+\\.\\d+$", description: "The spec major this package implements is 1." },
      onStoreError: { enum: ["open", "closed"], description: "What to do when a store-backed check throws. Default open." },
      keyPrefix: { type: "string", description: "Prefix for every key the gate writes. Default pg:." },
      checks: { type: "array", minItems: 1, items: { oneOf: entries }, description: "Checks in the order they run." },
    },
    $defs: {
      priority: { enum: ["low", "normal", "high", "critical"] },
      hhmm: { type: "string", pattern: "^([01]\\d|2[0-3]):[0-5]\\d$|^24:00$", description: "HH:MM, 24-hour." },
    },
  };
}
