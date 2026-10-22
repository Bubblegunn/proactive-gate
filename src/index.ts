export { createGate } from "./gate.js";
export type { Gate, PolicyGateOptions } from "./gate.js";
export { explain, en } from "./explain.js";
export type { CheckSentence, Explanation, ExplainOptions, SentenceFacts, Sentences, SentenceTemplate } from "./explain.js";
export { compilePolicy, KNOWN_CHECKS } from "./policy.js";
export { policySchema } from "./policy-schema.js";
export type { JsonSchema } from "./policy-schema.js";
export { presets } from "./presets.js";
export type { Preset } from "./presets.js";
export { MemoryStore, RedisStore, PostgresStore, SqliteStore } from "./stores.js";
export type { RedisLike, PostgresLike } from "./stores.js";
export * as checks from "./checks.js";
export { defaultChecks, localClock, inWindow, budgetKey, weeklyBudgetKey, monthlyBudgetKey, dismissalKey } from "./checks.js";
export { PRIORITY_RANK } from "./types.js";
export type {
  Candidate,
  Check,
  CheckContext,
  CheckOutcome,
  Decision,
  EvaluateInput,
  GateHooks,
  GateOptions,
  OutcomeEvent,
  Policy,
  PolicyEntry,
  Priority,
  Store,
  SyncStore,
  Surface,
  TraceEntry,
  UserState,
} from "./types.js";

export { createInboundConsent, parseKeyword, STOP_KEYWORDS, START_KEYWORDS } from "./inbound.js";
export type { InboundConsent, InboundConsentOptions, InboundKeywords, InboundResult, InboundAction, InboundInput } from "./inbound.js";
