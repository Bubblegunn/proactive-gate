/**
 * A Mastra output processor. Put it in the agent's `outputProcessors`; when
 * the gate rejects, the processor calls abort(reason) and the agent's result
 * is stopped before it reaches the user.
 *
 *   outputProcessors: [gateProcessor({ gate, toInput: ({ messages }) => ({ user, candidate: { id, type: "reply" } }) })]
 */
import type { Gate } from "../gate.js";
import type { EvaluateInput } from "../types.js";
import { describe } from "./ai-sdk.js";

export interface ProcessorArgs<M = unknown> {
  messages: M[];
  abort: (reason?: string) => never;
}

export interface OutputProcessor<M = unknown> {
  id: string;
  processOutputResult(args: ProcessorArgs<M>): Promise<M[]>;
}

export function gateProcessor<M = unknown>(options: {
  gate: Gate;
  toInput: (args: { messages: M[] }) => EvaluateInput;
  id?: string;
  commit?: boolean;
}): OutputProcessor<M> {
  const commit = options.commit ?? true;
  return {
    id: options.id ?? "proactive-gate",
    async processOutputResult({ messages, abort }) {
      const input = options.toInput({ messages });
      const decision = await options.gate.evaluate(input);
      if (!decision.allowed) return abort(`proactive-gate: ${describe(decision)}`);
      if (commit && !(await options.gate.commit(decision, input))) return abort("proactive-gate: a budget was exhausted at commit");
      return messages;
    },
  };
}
