# logfire-observability

Self-contained OpenClaw plugin that traces agent runs, tool calls, and messages to [Logfire](https://logfire.pydantic.dev) via OpenTelemetry.

No dependency on `diagnostics-otel` or any other plugin. Ships its own OTLP exporter.

## What gets traced

| Span | Fires when | Attributes |
|------|-----------|------------|
| `message.received` | Inbound user message | channel, from, content |
| `agent.run` | LLM call start → end | agent, provider, prompt preview, response, duration, message count |
| `tool.<name>` | Each tool execution | tool name, params, result, call ID |

All spans include `openclaw.sessionKey` and `openclaw.agent` for filtering.

## Install

```bash
# From the repo root
cd openclaw-plugins/logfire-observability
npm install

# Link into your OpenClaw instance
openclaw plugins install -l /path/to/openclaw-plugins/logfire-observability
```

Or copy the folder to `~/.openclaw/extensions/logfire-observability/` and run `npm install` there.

## Configure

Add to your `openclaw.json` (or `~/.clawdbot/openclaw.json`):

```json
{
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

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `logfireToken` | string | **(required)** | Your Logfire project write token |
| `logfireEndpoint` | string | `https://logfire-us.pydantic.dev/v1/traces` | OTLP endpoint (change for EU: `https://logfire-eu.pydantic.dev/v1/traces`) |
| `serviceName` | string | `openclaw` | Service name shown in Logfire |
| `captureContent` | boolean | `true` | Include message text, LLM responses, tool results |
| `captureToolParams` | boolean | `true` | Include tool call parameters |
| `maxAttributeLength` | number | `4096` | Truncate attributes beyond this length |

### Getting a Logfire token

1. Go to [logfire.pydantic.dev](https://logfire.pydantic.dev)
2. Create a project (or use an existing one)
3. Go to Settings > Write Tokens > Create Token
4. Copy the `pylf_v1_us_...` token

## Disable diagnostics-otel (optional)

This plugin replaces the need for `diagnostics-otel`. If you had it enabled, you can disable it to avoid duplicate base-level traces:

```json
{
  "plugins": {
    "entries": {
      "diagnostics-otel": {
        "enabled": false
      }
    }
  }
}
```

Or keep both if you want the built-in metrics from `diagnostics-otel` alongside the detailed agent traces from this plugin.

## Viewing traces in Logfire

Once installed, open your Logfire project dashboard. You'll see:

- **`agent.run`** spans for each LLM interaction, with nested `tool.*` child spans
- **`message.received`** spans for inbound messages
- Filter by `openclaw.agent` to isolate a specific agent
- Filter by `openclaw.tool.name` to see all uses of a specific tool
- Search `openclaw.error` to find failed runs

### Useful Logfire queries

```sql
-- Failed agent runs
SELECT * FROM spans WHERE span_name = 'agent.run' AND attributes->>'openclaw.success' = 'false'

-- Slowest tool calls
SELECT span_name, duration FROM spans WHERE span_name LIKE 'tool.%' ORDER BY duration DESC LIMIT 20

-- Messages by channel
SELECT attributes->>'openclaw.channel', count(*) FROM spans WHERE span_name = 'message.received' GROUP BY 1
```

## Architecture

```
User message
  └─ message.received span
  └─ agent.run span (parent)
       ├─ tool.web_search span
       ├─ tool.read_file span
       └─ tool.send_message span
```

The plugin creates its own `NodeTracerProvider` with a `BatchSpanProcessor` and `OTLPTraceExporter` pointed at Logfire. No global OTel registration — avoids the module isolation bug that breaks `deep-trace` + `diagnostics-otel`.
