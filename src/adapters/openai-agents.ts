/**
 * An OpenAI Agents SDK tool input guardrail. Attach it to the send tool with
 * `defineToolInputGuardrail`-compatible shape; a rejection trips the wire with
 * the reason in outputInfo.
 *
 *   tool({ name: "send_message", inputGuardrails: [gateToolInputGuardrail({ gate, toInput: ({ input }) => input.gate })] })
 */
import type { Gate } from "../gate.js";
import type { EvaluateInput } from "../types.js";
import { describe } from "./ai-sdk.js";

export interface GuardrailArgs<I = unknown> {
  input: I;
  context?: unknown;
}

export interface GuardrailResult {
  tripwireTriggered: boolean;
  outputInfo: { reason?: string; surfaces?: string[]; deliverAt?: string };
}

export interface ToolInputGuardrail<I = unknown> {
  name: string;
  execute(args: GuardrailArgs<I>): Promise<GuardrailResult>;
}

export function gateToolInputGuardrail<I = unknown>(options: {
  gate: Gate;
  toInput: (args: GuardrailArgs<I>) => EvaluateInput;
  name?: string;
  commit?: boolean;
}): ToolInputGuardrail<I> {
  const commit = options.commit ?? true;
  return {
    name: options.name ?? "proactive-gate",
    async execute(args) {
      const input = options.toInput(args);
      const decision = await options.gate.evaluate(input);
      if (!decision.allowed) return { tripwireTriggered: true, outputInfo: { reason: describe(decision) } };
      if (commit && !(await options.gate.commit(decision, input))) return { tripwireTriggered: true, outputInfo: { reason: "a budget was exhausted at commit" } };
      return { tripwireTriggered: false, outputInfo: { surfaces: decision.surfaces, ...(decision.deliverAt ? { deliverAt: decision.deliverAt.toISOString() } : {}) } };
    },
  };
}
