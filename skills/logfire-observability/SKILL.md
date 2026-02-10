---
name: logfire-observability
description: Full OpenClaw observability in Pydantic Logfire — agent traces, tool calls, metrics, and logs via OpenTelemetry
homepage: https://github.com/rita-aga/openclaw-logfire-observability
metadata:
  openclaw:
    emoji: "🔥"
    requires:
      env:
        - LOGFIRE_TOKEN
    os:
      - darwin
      - linux
      - win32
    primaryEnv: LOGFIRE_TOKEN
---

# Logfire Observability

Sends OpenClaw agent traces, tool calls, and messages to [Pydantic Logfire](https://logfire.pydantic.dev) via OpenTelemetry.

## Install the plugin

```bash
openclaw plugins install openclaw-logfire-observability
```

## Configure

Add to your `openclaw.json`:

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
      },
      "diagnostics-otel": {
        "enabled": true
      }
    }
  }
}
```

Replace `YOUR_TOKEN_HERE` with your Logfire write token (from Settings > Write Tokens in your Logfire project).

Then restart OpenClaw.

## What you get

- **Agent traces** with parent-child nesting (agent.run → tool.* spans)
- **Metrics**: token usage, cost, duration, queue health, session state
- **Logs**: full OpenClaw log forwarding
- **Diagnostic traces**: model usage, webhooks, message processing

See the full [README](https://github.com/rita-aga/openclaw-logfire-observability) for architecture details, config options, and Logfire query examples.
