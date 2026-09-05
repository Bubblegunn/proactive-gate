/**
 * LangChain middleware that wraps tool calls. For the tools listed in `tools`
 * the gate decides first; a rejection returns a tool message carrying the
 * reason instead of running the tool.
 *
 *   createAgent({ tools: [sendMessage], middleware: [gateMiddleware({ gate, tools: ["send_message"], toInput: (req) => req.toolCall.args.gate })] })
 */
import type { Gate } from "../gate.js";
import type { EvaluateInput } from "../types.js";
import { describe } from "./ai-sdk.js";

export interface ToolCallRequest {
  toolCall: { name: string; id?: string; args: Record<string, unknown> };
}

export interface ToolMessageLike {
  type: "tool";
  content: string;
  tool_call_id: string;
  status: "success" | "error";
}

export interface ToolCallMiddleware<R extends ToolCallRequest = ToolCallRequest, T = unknown> {
  name: string;
  wrapToolCall(request: R, handler: (request: R) => Promise<T>): Promise<T | ToolMessageLike>;
}

export function gateMiddleware<R extends ToolCallRequest = ToolCallRequest, T = unknown>(options: {
  gate: Gate;
  tools: string[];
  toInput: (request: R) => EvaluateInput;
  commit?: boolean;
}): ToolCallMiddleware<R, T> {
  const commit = options.commit ?? true;
  const watched = new Set(options.tools);
  return {
    name: "proactive-gate",
    async wrapToolCall(request, handler) {
      if (!watched.has(request.toolCall.name)) return handler(request);
      const input = options.toInput(request);
      const decision = await options.gate.evaluate(input);
      const refuse = (reason: string): ToolMessageLike => ({ type: "tool", content: `proactive-gate: ${reason}`, tool_call_id: request.toolCall.id ?? "", status: "error" });
      if (!decision.allowed) return refuse(describe(decision));
      if (commit && !(await options.gate.commit(decision, input))) return refuse("a budget was exhausted at commit");
      return handler(request);
    },
  };
}
