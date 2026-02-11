import { SpanStatusCode, context as otelContext, trace, type Span, type Context, type Tracer } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "openclaw.logfire-observability";
const TRACER_VERSION = "1.1.1";

interface ActiveRun {
  span: Span;
  ctx: Context; // OTel context with agent.run span — used to parent tool spans
  toolSpans: Map<string, Span>; // keyed by toolCallId for parallel-safe lookup
  toolStack: Span[]; // fallback LIFO for events missing toolCallId
}

function truncate(str: string | undefined | null, maxLen: number): string {
  if (!str) return "";
  return str.length > maxLen ? str.slice(0, maxLen) + "...[truncated]" : str;
}

function safeStringify(value: unknown, maxLen: number): string {
  try {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    return truncate(str, maxLen);
  } catch {
    return "[unstringifiable]";
  }
}

function extractTextContent(content: unknown, maxLen: number): string {
  if (typeof content === "string") return truncate(content, maxLen);
  if (Array.isArray(content)) {
    const parts = content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text ?? "");
    return truncate(parts.join("\n"), maxLen);
  }
  return safeStringify(content, maxLen);
}

export default {
  id: "openclaw-logfire-observability",
  name: "Logfire Observability",
  version: TRACER_VERSION,

  register(api: any) {
    const cfg = api.pluginConfig ?? {};

    // ── Validate config ──────────────────────────────────────────
    const logfireToken: string | undefined = cfg.logfireToken;
    if (!logfireToken) {
      api.logger?.error?.(
        "logfire-observability: missing logfireToken in config — plugin disabled. " +
        "Add your Logfire write token to openclaw.json under plugins.entries.logfire-observability.config.logfireToken"
      );
      return;
    }

    const endpoint: string = cfg.logfireEndpoint || "https://logfire-us.pydantic.dev/v1/traces";
    const serviceName: string = cfg.serviceName || "openclaw";
    const captureContent: boolean = cfg.captureContent !== false;
    const captureToolParams: boolean = cfg.captureToolParams !== false;
    const maxLen: number = typeof cfg.maxAttributeLength === "number" ? cfg.maxAttributeLength : 4096;

    // ── Set up self-contained OTLP exporter ──────────────────────
    const exporter = new OTLPTraceExporter({
      url: endpoint,
      headers: {
        Authorization: `Bearer ${logfireToken}`,
      },
    });

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });

    // Use our own tracer from our own provider — no global registration,
    // no conflict with diagnostics-otel or any other plugin.
    const tracer: Tracer = provider.getTracer(TRACER_NAME, TRACER_VERSION);

    api.logger?.info?.(
      `logfire-observability: initialized (endpoint=${endpoint} service=${serviceName} content=${captureContent} toolParams=${captureToolParams})`
    );

    // Active agent runs keyed by sessionKey
    const runs = new Map<string, ActiveRun>();

    // ── message_received ─────────────────────────────────────────
    api.on("message_received", (event: any, ctx: any) => {
      const span = tracer.startSpan("message.received", {
        attributes: {
          "openclaw.channel": ctx.channelId ?? "unknown",
          "openclaw.from": event.from ?? "unknown",
          "openclaw.account": ctx.accountId ?? "unknown",
          ...(captureContent && event.content
            ? { "openclaw.message.content": truncate(event.content, maxLen) }
            : {}),
        },
      });
      span.end();
    });

    // ── before_agent_start ───────────────────────────────────────
    api.on("before_agent_start", (event: any, ctx: any) => {
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "unknown";

      // End any stale run for this session
      const stale = runs.get(sessionKey);
      if (stale) {
        endAllToolSpans(stale, true);
        stale.span.setAttribute("openclaw.incomplete", true);
        stale.span.end();
        runs.delete(sessionKey);
      }

      const attrs: Record<string, string | number | boolean> = {
        "openclaw.agent": ctx.agentId ?? "unknown",
        "openclaw.sessionKey": sessionKey,
        "openclaw.provider": ctx.messageProvider ?? "unknown",
        "openclaw.prompt.length": event.prompt?.length ?? 0,
        "openclaw.messages.count": event.messages?.length ?? 0,
      };
      if (captureContent && event.prompt) {
        attrs["openclaw.prompt.preview"] = truncate(event.prompt, 1024);
      }

      const span = tracer.startSpan("agent.run", { attributes: attrs });
      // Create an OTel context with this span as the active span.
      // Tool spans started within this context become children of agent.run.
      const spanCtx = trace.setSpan(otelContext.active(), span);
      runs.set(sessionKey, { span, ctx: spanCtx, toolSpans: new Map(), toolStack: [] });
    });

    // ── before_tool_call ─────────────────────────────────────────
    api.on("before_tool_call", (event: any, ctx: any) => {
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "unknown";
      const parent = runs.get(sessionKey);

      const attrs: Record<string, string | number | boolean> = {
        "openclaw.tool.name": event.toolName,
        "openclaw.sessionKey": sessionKey,
        "openclaw.agent": ctx.agentId ?? "unknown",
      };
      if (captureToolParams && event.params) {
        attrs["openclaw.tool.params"] = safeStringify(event.params, maxLen);
      }

      // Start tool span as a child of the agent.run span via parent context
      const span = tracer.startSpan(
        "tool." + event.toolName,
        { attributes: attrs },
        parent?.ctx, // passes parent context → makes this a child span
      );

      if (parent) {
        // If we have a toolCallId, use the Map for parallel-safe lookup.
        // Otherwise fall back to the LIFO stack.
        if (event.toolCallId) {
          parent.toolSpans.set(event.toolCallId, span);
        } else {
          parent.toolStack.push(span);
        }
      } else {
        api.logger?.debug?.(`logfire-observability: tool.${event.toolName} fired without active agent run`);
        span.end();
      }
    });

    // ── tool_result_persist ──────────────────────────────────────
    api.on("tool_result_persist", (event: any, ctx: any) => {
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "unknown";
      const parent = runs.get(sessionKey);

      // Look up the matching tool span: prefer Map by toolCallId, fall back to stack
      let span: Span | undefined;
      if (event.toolCallId && parent?.toolSpans.has(event.toolCallId)) {
        span = parent.toolSpans.get(event.toolCallId);
        parent.toolSpans.delete(event.toolCallId);
      } else {
        span = parent?.toolStack.pop();
      }

      if (span) {
        if (event.toolName) span.setAttribute("openclaw.tool.name", event.toolName);
        if (event.toolCallId) span.setAttribute("openclaw.tool.callId", event.toolCallId);
        if (event.isSynthetic) span.setAttribute("openclaw.tool.synthetic", true);

        if (captureContent && event.message) {
          const msg = event.message as any;
          if (msg.content) {
            span.setAttribute("openclaw.tool.result", extractTextContent(msg.content, maxLen));
          }
        }
        span.end();
      }
    });

    // ── agent_end ────────────────────────────────────────────────
    api.on("agent_end", (event: any, ctx: any) => {
      const sessionKey = ctx.sessionKey ?? ctx.agentId ?? "unknown";
      const active = runs.get(sessionKey);

      // End any dangling tool spans
      if (active) {
        endAllToolSpans(active, false);
      }

      const span = active?.span;
      if (span) {
        span.setAttribute("openclaw.success", event.success ?? true);
        if (event.durationMs != null) span.setAttribute("openclaw.durationMs", event.durationMs);
        if (event.error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: event.error });
          span.setAttribute("openclaw.error", truncate(event.error, maxLen));
        }
        if (event.messages?.length) {
          span.setAttribute("openclaw.messages.total", event.messages.length);

          // ── Extract token usage, cost, and model from assistant messages ──
          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let costUsd = 0;
          let responseModel: string | undefined;

          for (let i = event.messages.length - 1; i >= 0; i--) {
            const msg = (event.messages as any[])[i];
            if (msg?.role !== "assistant") continue;

            // Capture last assistant response content
            if (captureContent && !responseModel && msg.content) {
              span.setAttribute("openclaw.response", extractTextContent(msg.content, maxLen));
            }

            // Extract model name from the last assistant message
            if (!responseModel && msg.model) {
              responseModel = msg.model;
            }

            // Extract token usage — handle multiple field naming conventions
            const u = msg.usage;
            if (u) {
              totalInput += u.input ?? u.inputTokens ?? u.input_tokens ?? 0;
              totalOutput += u.output ?? u.outputTokens ?? u.output_tokens ?? 0;
              totalCacheRead += u.cacheRead ?? u.cache_read ?? u.cacheReadTokens ?? u.cache_read_tokens ?? 0;
              totalCacheWrite += u.cacheWrite ?? u.cache_write ?? u.cacheWriteTokens ?? u.cache_write_tokens ?? 0;
            }

            // Extract cost
            if (typeof msg.costUsd === "number") costUsd += msg.costUsd;
            if (typeof msg.cost_usd === "number") costUsd += msg.cost_usd;
          }

          // GenAI semantic convention attributes
          const totalTokens = totalInput + totalOutput;
          if (totalInput > 0) span.setAttribute("gen_ai.usage.input_tokens", totalInput);
          if (totalOutput > 0) span.setAttribute("gen_ai.usage.output_tokens", totalOutput);
          if (totalTokens > 0) span.setAttribute("gen_ai.usage.total_tokens", totalTokens);
          if (totalCacheRead > 0) span.setAttribute("gen_ai.usage.cache_read_tokens", totalCacheRead);
          if (totalCacheWrite > 0) span.setAttribute("gen_ai.usage.cache_write_tokens", totalCacheWrite);
          if (responseModel) span.setAttribute("gen_ai.response.model", responseModel);
          if (costUsd > 0) span.setAttribute("openclaw.llm.cost_usd", costUsd);
        }
        span.end();
        runs.delete(sessionKey);
      }
    });

    // ── Graceful shutdown ────────────────────────────────────────
    api.on("shutdown", async () => {
      api.logger?.info?.("logfire-observability: flushing and shutting down...");
      await provider.forceFlush();
      await provider.shutdown();
    });

    /** End all pending tool spans for a run (from both Map and stack). */
    function endAllToolSpans(run: ActiveRun, markIncomplete: boolean) {
      for (const ts of run.toolSpans.values()) {
        if (markIncomplete) ts.setAttribute("openclaw.incomplete", true);
        ts.end();
      }
      run.toolSpans.clear();
      for (const ts of run.toolStack) {
        if (markIncomplete) ts.setAttribute("openclaw.incomplete", true);
        ts.end();
      }
      run.toolStack.length = 0;
    }

    api.logger?.info?.(
      "logfire-observability: hooks registered (message_received, before_agent_start, before_tool_call, tool_result_persist, agent_end, shutdown)"
    );
  },
};
