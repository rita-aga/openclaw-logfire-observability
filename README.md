# logfire-observability

Full OpenClaw observability in [Pydantic Logfire](https://logfire.pydantic.dev). Get agent traces, tool calls, metrics, and logs — all in one dashboard.

This setup combines two plugins:

| Plugin | What it sends to Logfire | Source |
|--------|-------------------------|--------|
| **logfire-observability** (this plugin) | Agent→tool trace hierarchy with params, results, and parent-child nesting | Custom, ships here |
| **diagnostics-otel** (built-in) | Metrics (tokens, cost, duration), logs, webhook/queue/session telemetry | Ships with OpenClaw |

Both are configured to export to Logfire via OTLP. Together they give you full coverage.

## Quick start

### 1. Get a Logfire token

1. Go to [logfire.pydantic.dev](https://logfire.pydantic.dev)
2. Create a project (or use an existing one)
3. Go to Settings > Write Tokens > Create Token
4. Copy the `pylf_v1_us_...` token

### 2. Install this plugin

```bash
# From the repo root
cd openclaw-plugins/logfire-observability
npm install

# Link into your OpenClaw instance
openclaw plugins install -l /path/to/openclaw-plugins/logfire-observability
```

Or copy the folder to `~/.openclaw/extensions/logfire-observability/` and run `npm install` there.

### 3. Configure both plugins

Add the following to your `openclaw.json` (or `~/.clawdbot/openclaw.json`).

Replace `YOUR_TOKEN_HERE` with your Logfire write token in **both** places:

```json
{
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://logfire-us.pydantic.dev",
      "headers": {
        "Authorization": "Bearer pylf_v1_us_YOUR_TOKEN_HERE"
      },
      "serviceName": "openclaw",
      "traces": true,
      "metrics": true,
      "logs": true
    }
  },
  "plugins": {
    "entries": {
      "logfire-observability": {
        "enabled": true,
        "config": {
          "logfireToken": "pylf_v1_us_YOUR_TOKEN_HERE"
        }
      }
    }
  }
}
```

Then restart OpenClaw (`sudo systemctl restart clawdbot` or `openclaw restart`).

> **EU region?** Change the endpoint to `https://logfire-eu.pydantic.dev` and set `logfireEndpoint` to `https://logfire-eu.pydantic.dev/v1/traces`.

## What you get in Logfire

### From logfire-observability (this plugin)

Detailed agent execution traces with parent-child nesting:

```
User message
  └─ message.received span
  └─ agent.run span (parent)
       ├─ tool.web_search span
       ├─ tool.read_file span
       └─ tool.send_message span
```

| Span | Fires when | Key attributes |
|------|-----------|----------------|
| `message.received` | Inbound user message | channel, from, content |
| `agent.run` | LLM call start → end | agent, provider, prompt preview, response, duration, message count |
| `tool.<name>` | Each tool execution | tool name, params, result, call ID |

All spans include `openclaw.sessionKey` and `openclaw.agent` for filtering.

### From diagnostics-otel (built-in)

Operational metrics, logs, and diagnostic traces:

**Metrics**
| Metric | Type | What it tracks |
|--------|------|----------------|
| `openclaw.tokens` | counter | Token usage by type (input, output, cache, prompt, total) |
| `openclaw.cost.usd` | counter | Estimated cost per run |
| `openclaw.run.duration_ms` | histogram | Agent run duration |
| `openclaw.context.tokens` | histogram | Context window limit vs used |
| `openclaw.webhook.received` | counter | Inbound webhooks |
| `openclaw.webhook.duration_ms` | histogram | Webhook processing time |
| `openclaw.message.queued` / `.processed` | counters | Message throughput |
| `openclaw.queue.depth` / `.wait_ms` | histograms | Queue health |
| `openclaw.session.state` / `.stuck` | counters | Session lifecycle |
| `openclaw.run.attempt` | counter | Run retry tracking |

**Logs** — All OpenClaw logs forwarded to Logfire via OTLP (when `logs: true`).

**Traces** — `model.usage`, `webhook.processed`, `webhook.error`, `message.processed`, `session.stuck` spans.

## Config reference

### logfire-observability (plugin config)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logfireToken` | string | **(required)** | Your Logfire project write token |
| `logfireEndpoint` | string | `https://logfire-us.pydantic.dev/v1/traces` | OTLP trace endpoint |
| `serviceName` | string | `openclaw` | Service name shown in Logfire |
| `captureContent` | boolean | `true` | Include message text, LLM responses, tool results |
| `captureToolParams` | boolean | `true` | Include tool call parameters |
| `maxAttributeLength` | number | `4096` | Truncate attributes beyond this length |

### diagnostics-otel (top-level diagnostics config)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diagnostics.enabled` | boolean | `false` | Enable diagnostics |
| `diagnostics.otel.enabled` | boolean | `false` | Enable OTLP export |
| `diagnostics.otel.endpoint` | string | — | OTLP endpoint base URL |
| `diagnostics.otel.headers` | object | — | Custom headers (use for Logfire auth) |
| `diagnostics.otel.serviceName` | string | `openclaw` | Service name |
| `diagnostics.otel.traces` | boolean | `true` | Export traces |
| `diagnostics.otel.metrics` | boolean | `true` | Export metrics |
| `diagnostics.otel.logs` | boolean | `false` | Export logs |
| `diagnostics.otel.sampleRate` | number | `1.0` | Trace sample rate (0.0–1.0) |

## Useful Logfire queries

```sql
-- Failed agent runs (from logfire-observability)
SELECT * FROM spans WHERE span_name = 'agent.run' AND attributes->>'openclaw.success' = 'false'

-- Slowest tool calls (from logfire-observability)
SELECT span_name, duration FROM spans WHERE span_name LIKE 'tool.%' ORDER BY duration DESC LIMIT 20

-- Token usage by model (from diagnostics-otel)
SELECT attributes->>'openclaw.model', sum(value) FROM metrics WHERE name = 'openclaw.tokens' GROUP BY 1

-- Cost per channel (from diagnostics-otel)
SELECT attributes->>'openclaw.channel', sum(value) FROM metrics WHERE name = 'openclaw.cost.usd' GROUP BY 1

-- Messages by channel (from logfire-observability)
SELECT attributes->>'openclaw.channel', count(*) FROM spans WHERE span_name = 'message.received' GROUP BY 1
```

## Architecture

```
                          ┌──────────────────────────────────┐
                          │           Logfire                 │
                          │   (traces, metrics, logs)         │
                          └──────────┬───────────────────────┘
                                     │ OTLP/HTTP
                          ┌──────────┴───────────────────────┐
                          │                                    │
              ┌───────────┴──────────┐         ┌──────────────┴──────────┐
              │ logfire-observability │         │    diagnostics-otel     │
              │   (this plugin)      │         │      (built-in)         │
              ├──────────────────────┤         ├─────────────────────────┤
              │ agent.run traces     │         │ metrics (tokens, cost)  │
              │ tool.* child spans   │         │ diagnostic traces       │
              │ message.received     │         │ log forwarding          │
              │                      │         │ webhook/queue/session   │
              └───────────┬──────────┘         └──────────────┬──────────┘
                          │ api.on() hooks                    │ onDiagnosticEvent()
                          └───────────┬───────────────────────┘
                                      │
                              ┌───────┴────────┐
                              │    OpenClaw     │
                              └────────────────┘
```

The two plugins use different event systems (`api.on()` vs `onDiagnosticEvent()`) and different OTel setups (self-contained provider vs NodeSDK). They don't conflict — `logfire-observability` avoids global OTel registration, sidestepping the module isolation bug where jiti's per-plugin scoping prevents shared TracerProviders.

## Using only this plugin

If you don't need metrics/logs and just want agent traces, you can use `logfire-observability` alone — no need to enable `diagnostics-otel`. The trace hierarchy (agent.run → tool.*) works independently.
