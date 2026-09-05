/**
 * One span per check through the gate's hooks. The tracer interface below is
 * the subset of @opentelemetry/api the example needs; pass `trace.getTracer("gate")`.
 *
 * Run with: npx tsx examples/otel.ts
 */
import { createGate, defaultChecks } from "proactive-gate";
import type { GateHooks } from "proactive-gate";

interface Span { setAttribute(key: string, value: string | number | boolean): unknown; end(): void }
interface Tracer { startSpan(name: string): Span }

export function otelHooks(tracer: Tracer): GateHooks {
  const spans = new Map<string, Span>();
  return {
    before(ctx, check) {
      const span = tracer.startSpan(`gate.check ${check.id}`);
      span.setAttribute("gate.user", ctx.user.id);
      span.setAttribute("gate.candidate", ctx.candidate.id);
      spans.set(check.id, span);
    },
    after(_ctx, check, outcome, ms) {
      const span = spans.get(check.id);
      if (!span) return;
      span.setAttribute("gate.outcome", outcome.kind);
      if ("reason" in outcome && outcome.reason) span.setAttribute("gate.reason", outcome.reason);
      span.setAttribute("gate.ms", ms);
      span.end();
      spans.delete(check.id);
    },
    error(_ctx, check, error) {
      const span = spans.get(check.id);
      span?.setAttribute("gate.error", error instanceof Error ? error.message : String(error));
      span?.end();
      spans.delete(check.id);
    },
    finally(decision) {
      const span = tracer.startSpan("gate.decision");
      span.setAttribute("gate.allowed", decision.allowed);
      if (decision.rejectedBy) span.setAttribute("gate.rejectedBy", decision.rejectedBy);
      span.end();
    },
  };
}

// A console tracer so the example runs without a collector.
const consoleTracer: Tracer = {
  startSpan(name) {
    const attributes: Record<string, unknown> = {};
    return { setAttribute: (k, v) => (attributes[k] = v), end: () => console.log(name, attributes) };
  },
};

const gate = createGate({ checks: defaultChecks(), hooks: otelHooks(consoleTracer) });
await gate.evaluate({ user: { id: "ayse", consent: true, timezone: "Europe/Istanbul" }, candidate: { id: "c1", type: "reminder" } });
