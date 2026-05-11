# agent-system Extension Changes

## 2026-05-11 - Extracted to external repository

### What changed
- Removed the builtin `agent-system` extension implementation from senpi-mono.
- Kept this tombstone `changes.md` because fork merge contracts track this path.
- The extension now lives as the sibling repository `../pi-extensions/pi-agent-system`.
- `permission-system` owns its own wildcard matcher so it no longer imports agent-system internals.

### Why
- Agent profiles and per-agent tool filtering are extension features and can ship as an external extension like the other `pi-extensions` repositories.
- Removing the builtin reduces monorepo surface area and avoids carrying agent-profile docs/tests inside senpi-mono.

### Why the extension system can handle this now
- `ExtensionAPI.getAllTools()`, `setActiveTools()`, and `before_agent_start` are sufficient for the extracted extension to filter tools and append per-agent prompt fragments.
- `background-task` already passes the agent type through `SANEPI_AGENT_TYPE`.

### Expected merge conflict zones
- `builtin/index.ts` if upstream adds or reorders builtins.
- `permission-system/evaluate.ts` if upstream changes wildcard rule evaluation.
