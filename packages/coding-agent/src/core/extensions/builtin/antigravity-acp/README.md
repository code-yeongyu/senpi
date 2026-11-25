# antigravity-acp

Senpi / OmO provider extension that drives the official `agy acp` (Antigravity CLI Agent Client Protocol) binary over JSON-RPC 2.0 stdio and bridges Senpi host tools over a loopback HTTP MCP server (`senpi-host`).

- **No credential storage or token proxying:** `agy` manages its own authentication using `GEMINI_API_KEY` (`gemini-api-key`) or Vertex AI / Gemini Enterprise (`agent-platform`).
- **Explicit opt-in:** Disabled until opted in via `antigravityAcpProvider.enabled: true` in global `settings.json` (`~/.senpi/agent/settings.json` or `~/.omo/agent/settings.json`), `SENPI_ANTIGRAVITY_ACP_ENABLED=true`, or `/login antigravity-acp`. Project-level settings cannot enable the provider or set `executablePath`.

## Configuration

In your global agent `settings.json` (e.g. `~/.senpi/agent/settings.json` or `~/.omo/agent/settings.json`):

```json
{
  "antigravityAcpProvider": {
    "enabled": true,
    "authMethod": "gemini-api-key",
    "resumeMode": "auto"
  }
}
```

### Supported `authMethod` values
- `"gemini-api-key"` (default) — passes `GEMINI_API_KEY` to `agy` (Google's documented path for external agent harnesses).
- `"agent-platform"` — passes `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and `GOOGLE_APPLICATION_CREDENTIALS` for Vertex AI / Gemini Enterprise.

### Environment overrides
- `SENPI_ANTIGRAVITY_ACP_ENABLED` (`true` / `false`)
- `SENPI_ANTIGRAVITY_ACP_EXECUTABLE` (custom path to `agy`)
- `SENPI_ANTIGRAVITY_ACP_AUTH_METHOD` (`gemini-api-key` | `agent-platform`)
- `SENPI_ANTIGRAVITY_ACP_RESUME` (`auto` | `off`)
