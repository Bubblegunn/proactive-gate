/**
 * `proactive-gate init` writes a policy you can read and edit, and prints the
 * few lines that wire it into the framework you named. The goal is that the
 * distance between "npm i" and a gate that actually runs is one command.
 */
import { presets } from "./presets.js";

export const FRAMEWORKS = ["ai-sdk", "mastra", "langchain", "openai-agents", "none"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

/** The order LILA runs, as a policy document. A preset is appended when one is named. */
export function buildPolicy(preset?: string): Record<string, unknown> {
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
    { id: "dailyBudget", limit: 5, bypassPriority: "critical" },
  ];
  if (preset) checks.splice(checks.length - 1, 0, { preset });
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

const decision = await gate.evaluate({ user, candidate });
if (decision.allowed && (await gate.commit(decision, { user, candidate }))) {
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

/** Everything init writes and prints, as data, so the test does not need a filesystem. */
export function plan(options: { preset?: string; framework?: Framework; out: string }): { policy: string; message: string } {
  if (options.preset && !presets[options.preset]) {
    throw new Error(`unknown preset "${options.preset}"; known presets: ${Object.keys(presets).join(", ")}`);
  }
  const framework = options.framework ?? "none";
  if (!FRAMEWORKS.includes(framework)) {
    throw new Error(`unknown framework "${framework}"; known frameworks: ${FRAMEWORKS.join(", ")}`);
  }
  const preset = options.preset ? presets[options.preset] : undefined;
  const lines = [
    `wrote ${options.out}`,
    "",
    preset
      ? `preset ${options.preset}: ${preset.note}\nsources:\n${preset.sources.map((s) => `  ${s}`).join("\n")}\n`
      : "no preset: the ten checks above are the default order. `proactive-gate init --list` shows the platform and legal presets.\n",
    `wire it in (${framework}):`,
    "",
    snippetFor(framework, options.out),
    "",
    `then replay a day against it before you ship:`,
    `  npx proactive-gate replay day.jsonl --policy ${options.out} --commit`,
  ];
  return { policy: `${JSON.stringify(buildPolicy(options.preset), null, 2)}\n`, message: lines.join("\n") };
}
