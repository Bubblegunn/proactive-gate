/**
 * Vercel AI SDK tool approvals. Give the send tool `needsApproval: true` and
 * answer each approval request through the gate:
 *
 *   const approve = gateToolApproval({ gate, toInput: (call) => call.input.gate });
 *   const { approved, reason } = await approve(call);
 *   // then addToolApprovalResponse({ id: call.approvalId, approved, reason })
 *
 * Typed against the shape of a tool call, not against the `ai` package, so
 * nothing needs to be installed to build proactive-gate.
 */
import type { Gate } from "../gate.js";
import type { EvaluateInput } from "../types.js";

export interface ToolApprovalRequest {
  toolName?: string;
  toolCallId?: string;
  approvalId?: string;
  input?: unknown;
}

export interface ToolApprovalResult {
  approved: boolean;
  reason?: string;
}

export function gateToolApproval<T extends ToolApprovalRequest>(options: {
  gate: Gate;
  toInput: (call: T) => EvaluateInput;
  /** Also consume the budget on approval. Default true. */
  commit?: boolean;
}): (call: T) => Promise<ToolApprovalResult> {
  const commit = options.commit ?? true;
  return async (call) => {
    const input = options.toInput(call);
    const decision = await options.gate.evaluate(input);
    if (!decision.allowed) return { approved: false, reason: describe(decision) };
    if (commit && !(await options.gate.commit(decision, input))) return { approved: false, reason: "a budget was exhausted at commit" };
    return { approved: true, ...(decision.deliverAt ? { reason: `deliver at ${decision.deliverAt.toISOString()}` } : {}) };
  };
}

export function describe(decision: { rejectedBy?: string; deferredBy?: string; retryAt?: Date; reason?: string }): string {
  if (decision.deferredBy) return `deferred by ${decision.deferredBy} until ${decision.retryAt?.toISOString()}: ${decision.reason}`;
  return `rejected by ${decision.rejectedBy}: ${decision.reason}`;
}
