import * as checks from "./checks.js";
import { presets } from "./presets.js";
import type { Check, GateOptions, Policy, PolicyEntry, Priority } from "./types.js";

type Options = Record<string, unknown>;
type Factory = (options: Options) => Check;

const num = (o: Options, key: string): number | undefined => (typeof o[key] === "number" ? (o[key] as number) : undefined);
const str = (o: Options, key: string): string | undefined => (typeof o[key] === "string" ? (o[key] as string) : undefined);
const bool = (o: Options, key: string): boolean | undefined => (typeof o[key] === "boolean" ? (o[key] as boolean) : undefined);
const prio = (o: Options, key: string): Priority | undefined => str(o, key) as Priority | undefined;
const strs = (o: Options, key: string): string[] | undefined => (Array.isArray(o[key]) ? (o[key] as string[]) : undefined);
const opt = <T>(value: T | undefined, key: string): Record<string, T> => (value === undefined ? {} : { [key]: value });

const budgetOptions = (o: Options) => ({ ...opt(num(o, "limit"), "limit"), ...opt(prio(o, "bypassPriority"), "bypassPriority"), ...opt(num(o, "nearLimit"), "nearLimit") });

/** Every check a JSON policy may name, with the options it reads. */
export const KNOWN_CHECKS: Record<string, Factory> = {
  killSwitch: (o) => checks.killSwitch(() => bool(o, "on") === true),
  consent: () => checks.consent(),
  enabled: () => checks.enabled(),
  mode: (o) => checks.mode({ allow: strs(o, "allow") ?? ["normal"] }),
  snooze: (o) => checks.snooze({ ...opt(bool(o, "defer"), "defer") }),
  mute: () => checks.mute(),
  intensity: (o) => (o.floors ? checks.intensity(o.floors as Record<"low" | "normal" | "high", Priority>) : checks.intensity()),
  quietHours: (o) => checks.quietHours({ ...opt(prio(o, "priorityFloor"), "priorityFloor") }),
  trustRamp: (o) => checks.trustRamp({ ...opt(num(o, "days"), "days"), ...opt(prio(o, "minPriority"), "minPriority") }),
  dismissalCooldown: (o) => checks.dismissalCooldown({ ...opt(num(o, "dismissals"), "dismissals"), ...opt(num(o, "withinDays"), "withinDays"), ...opt(num(o, "silenceDays"), "silenceDays") }),
  adaptiveTiming: () => checks.adaptiveTiming(),
  dailyBudget: (o) => checks.dailyBudget(budgetOptions(o)),
  weeklyBudget: (o) => checks.weeklyBudget(budgetOptions(o)),
  monthlyBudget: (o) => checks.monthlyBudget(budgetOptions(o)),
  utilityFloor: (o) => checks.utilityFloor({ costFalseAlarm: num(o, "costFalseAlarm") ?? 1, costMissedHelp: num(o, "costMissedHelp") ?? 1 }),
  boundedDeferral: (o) => checks.boundedDeferral({ ...opt(num(o, "lambda"), "lambda"), ...opt(num(o, "interruptCost"), "interruptCost"), ...opt(num(o, "staleness"), "staleness"), ...opt(num(o, "boundSeconds"), "boundSeconds") }),
  allowedWindow: (o) => checks.allowedWindow({ start: str(o, "start") ?? "08:00", end: str(o, "end") ?? "21:00", timezone: str(o, "timezone") ?? "user", ...opt(prio(o, "priorityFloor"), "priorityFloor"), ...opt(str(o, "id"), "id") }),
  requiresConsent: (o) => checks.requiresConsent({ name: str(o, "name") ?? "consent", ...(o.when ? { when: o.when as { start: string; end: string; timezone: string } } : {}), ...opt(str(o, "id"), "id") }),
  rateLimit: (o) => checks.rateLimit({ limit: num(o, "limit") ?? 1, perSeconds: num(o, "perSeconds") ?? 1, ...opt(str(o, "keyBy") as "user" | "channel" | undefined, "keyBy"), ...opt(str(o, "id"), "id") }),
  recentInteraction: (o) => checks.recentInteraction({ withinHours: num(o, "withinHours") ?? 48 }),
  windowBudget: (o) => checks.windowBudget({ limit: num(o, "limit") ?? 1, withinHours: num(o, "withinHours") ?? 48 }),
};

const SUPPORTED_MAJOR = 1;

/** Compile a JSON policy into gate options. Throws on unknown ids, unknown presets, or an unsupported specVersion. */
export function compilePolicy(policy: Policy): GateOptions {
  const major = Number(String(policy.specVersion).split(".")[0]);
  if (!Number.isInteger(major) || major !== SUPPORTED_MAJOR) {
    throw new Error(`policy specVersion ${policy.specVersion} is not supported; this package implements spec ${SUPPORTED_MAJOR}.x`);
  }
  if (!Array.isArray(policy.checks) || !policy.checks.length) throw new Error("policy.checks must be a non-empty array");
  const compiled: Check[] = [];
  for (const entry of policy.checks as PolicyEntry[]) {
    const { shadow, ...rest } = entry as Options & { shadow?: boolean };
    let built: Check[];
    if (typeof rest.preset === "string") {
      const preset = presets[rest.preset];
      if (!preset) throw new Error(`unknown preset "${rest.preset}"; known presets: ${Object.keys(presets).join(", ")}`);
      const { preset: _name, ...options } = rest;
      built = preset(options);
    } else if (typeof rest.id === "string") {
      const factory = KNOWN_CHECKS[rest.id];
      if (!factory) throw new Error(`unknown check "${rest.id}"; known checks: ${Object.keys(KNOWN_CHECKS).join(", ")}`);
      const { id: _id, ...options } = rest;
      built = [factory(options)];
    } else {
      throw new Error("each policy entry needs an id or a preset");
    }
    if (shadow) for (const c of built) c.shadow = true;
    compiled.push(...built);
  }
  return {
    checks: compiled,
    ...(policy.onStoreError ? { onStoreError: policy.onStoreError } : {}),
    ...(policy.keyPrefix !== undefined ? { keyPrefix: policy.keyPrefix } : {}),
  };
}
