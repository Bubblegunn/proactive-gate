/**
 * `proactive-gate init` writes a policy you can read and edit, and prints the
 * few lines that wire it into the framework you named. The goal is that the
 * distance between "npm i" and a gate that actually runs is one command.
 */
import { presets } from "./presets.js";

export const FRAMEWORKS = ["ai-sdk", "mastra", "langchain", "openai-agents", "none"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** The two-letter codes `--legal` accepts, each the legal preset of one jurisdiction. */
export const LEGAL_CODES: Record<string, string> = { us: "usTcpa", eu: "euEprivacy", kr: "krNetworkAct50", in: "inTcccp", br: "brLgpd" };

export interface PolicyOptions {
  /** The short policy from the skill, instead of the full twelve-check order. */
  minimal?: boolean;
  /** The daily budget per user. Defaults to 3 with minimal, 5 without. */
  daily?: number;
}

/**
 * The full twelve-check order, as a policy document, or with `minimal` the short policy the
 * skill shows. Presets are appended in the order given, before the daily budget.
 */
export function buildPolicy(preset?: string | string[], options: PolicyOptions = {}): Record<string, unknown> {
  const names = preset === undefined ? [] : Array.isArray(preset) ? preset : [preset];
  const presetChecks = names.map((name) => ({ preset: name }));
  const limit = options.daily ?? (options.minimal ? 3 : 5);
  if (options.minimal) {
    return {
      specVersion: "1.0.0",
      checks: [{ id: "consent" }, { id: "dedupe", windowSeconds: 86400 }, { id: "snooze", defer: true }, { id: "quietHours" }, ...presetChecks, { id: "dailyBudget", limit }],
    };
  }
  const checks: Array<Record<string, unknown>> = [
    { id: "consent" },
    { id: "enabled" },
    { id: "mode", allow: ["normal"] },
    { id: "snooze", defer: true },
    { id: "mute" },
    { id: "intensity" },
    { id: "quietHours", priorityFloor: "critical" },
    { id: "trustRamp", days: 7, minPriority: "high" },
    { id: "dismissalCooldown", dismissals: 3, withinDays: 30, silenceDays: 7 },
    ...presetChecks,
    { id: "dailyBudget", limit, bypassPriority: "critical" },
  ];
  return { specVersion: "1.0.0", onStoreError: "open", checks };
}

const SNIPPETS: Record<Framework, (file: string) => string> = {
  "ai-sdk": (file) => `import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";
import { gateToolApproval } from "proactive-gate/ai-sdk";

const gate = createGate({ policy: JSON.parse(await readFile("${file}", "utf8")) });
const approve = gateToolApproval({ gate, toInput: (call) => call.input.gate });

// Give the send tool needsApproval: true, then answer each request:
const { approved, reason } = await approve(call);
// addToolApprovalResponse({ id: call.approvalId, approved, reason })`,

  mastra: (file) => `import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";
import { gateProcessor } from "proactive-gate/mastra";

const gate = createGate({ policy: JSON.parse(await readFile("${file}", "utf8")) });

// In the agent definition:
//   outputProcessors: [gateProcessor({ gate, toInput: ({ messages }) => ({ user, candidate }) })]
// A rejection calls abort(reason) before the result reaches the user.`,

  langchain: (file) => `import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";
import { gateMiddleware } from "proactive-gate/langchain";

const gate = createGate({ policy: JSON.parse(await readFile("${file}", "utf8")) });

// createAgent({
//   tools: [sendMessage],
//   middleware: [gateMiddleware({ gate, tools: ["send_message"], toInput: (call) => call.args.gate })],
// })
// A rejection returns a tool message carrying the reason instead of running the tool.`,

  "openai-agents": (file) => `import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";
import { gateToolInputGuardrail } from "proactive-gate/openai-agents";

const gate = createGate({ policy: JSON.parse(await readFile("${file}", "utf8")) });

// tool({
//   name: "send_message",
//   inputGuardrails: [gateToolInputGuardrail({ gate, toInput: (input) => input.gate })],
// })
// A rejection trips the wire with the reason in outputInfo.`,

  none: (file) => `import { readFile } from "node:fs/promises";
import { createGate } from "proactive-gate";

const gate = createGate({ policy: JSON.parse(await readFile("${file}", "utf8")) });
const input = { user, candidate, now: new Date() };
const decision = await gate.evaluate(input);
if (decision.allowed && (await gate.commit(decision, input))) {
  await send(candidate);
} else {
  log.info({ reason: decision.reason, rejectedBy: decision.rejectedBy }, "not sent");
}`,
};

export function snippetFor(framework: Framework, file: string): string {
  return SNIPPETS[framework](file);
}

export function presetLines(): string {
  return Object.entries(presets)
    .map(([name, preset]) => `  ${name.padEnd(28)}${preset.sources[0] ?? ""}`)
    .join("\n");
}

export function listText(): string {
  return `presets (append one to the policy, or leave it out):\n${presetLines()}\n\nframeworks: ${FRAMEWORKS.join(", ")}`;
}

/**
 * Turns the names and legal codes into preset names, in the order given, each once.
 * An unknown name or code throws and lists the known ones.
 */
export function resolvePresets(names: string[], legal: string[] = []): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (!Object.hasOwn(presets, name)) throw new Error(`unknown preset "${name}"; known presets: ${Object.keys(presets).join(", ")}`);
    out.push(name);
  }
  for (const code of legal) {
    if (!Object.hasOwn(LEGAL_CODES, code)) throw new Error(`unknown legal code "${code}"; known codes: ${Object.keys(LEGAL_CODES).join(", ")}`);
    out.push(LEGAL_CODES[code]!);
  }
  return [...new Set(out)];
}

export interface PlanOptions extends PolicyOptions {
  preset?: string | string[];
  legal?: string | string[];
  framework?: Framework;
  out: string;
}

/** Everything init writes and prints, as data, so the test does not need a filesystem. */
export function plan(options: PlanOptions): { policy: string; message: string } {
  const framework = options.framework ?? "none";
  if (!FRAMEWORKS.includes(framework)) {
    throw new Error(`unknown framework "${framework}"; known frameworks: ${FRAMEWORKS.join(", ")}`);
  }
  if (options.daily !== undefined && (!Number.isInteger(options.daily) || options.daily < 1)) {
    throw new Error(`--daily takes a whole number of 1 or more, not ${options.daily}`);
  }
  const toList = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
  const names = resolvePresets(toList(options.preset), toList(options.legal));
  const policy = buildPolicy(names, { minimal: options.minimal ?? false, ...(options.daily === undefined ? {} : { daily: options.daily }) });
  const limit = (policy.checks as Array<Record<string, unknown>>).at(-1)!.limit;
  const shape = options.minimal
    ? `minimal policy: consent, dedupe, snooze (deferred), quiet hours and a daily budget of ${limit} per user.`
    : "the policy has ten of the twelve default checks (killSwitch and adaptiveTiming need your own flag and model).";
  const sources = names.flatMap((name) => [`preset ${name}: ${presets[name]!.note}`, "sources:", ...presets[name]!.sources.map((s) => `  ${s}`), ""]);
  const lines = [
    `wrote ${options.out}`,
    "",
    shape,
    "",
    ...(names.length ? sources : ["`proactive-gate init --list` shows the platform and legal presets.", ""]),
    `wire it in (${framework}):`,
    "",
    snippetFor(framework, options.out),
    "",
    "replay a day against it before you ship (no events yet? this writes a generated week first):",
    "  npx proactive-gate simulate --dump-events events.jsonl",
    `  npx proactive-gate replay events.jsonl --policy ${options.out} --commit`,
  ];
  return { policy: `${JSON.stringify(policy, null, 2)}\n`, message: lines.join("\n") };
}
