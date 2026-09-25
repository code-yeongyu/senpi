# senpi-desktop-tool fork changes

## 2026-09-24 - Desktop package wired into the workspace (senpi#2128)

### What changed

- `packages/desktop-tool/`: skeleton package (empty entry plus one placeholder test) wired into the workspace, the build phases, the entry-graph budgets, and the bundled-workspace staging. Todo 24 fills it.

### Why

- Desktop computer use (senpi#2128) ships as five flat TS packages. Every enumerating script has to know about all five before any of them gains behavior, or publish staging breaks.

### Why an extension could not handle it

- This package is fork-only. The wiring lives in root build and publish scripts that run before any extension loads.

### Expected merge conflict zones

- None in this package: it does not exist upstream.

## 2026-09-25 - The `computer` tool, permission tiers, settings, and `/computer` (senpi#2128)

### What changed

- `packages/desktop-tool/src/{tool,params,permission,settings,session,activation,command,host-policy}.ts`: `createComputerTool` returns the search-exposed `computer` `ToolDefinition` whose `kernelPrelude` carries the eval-kernel `computer` facade. `computerPermissionParser` maps each input to a `computer` request with the `read` or `exec` tier. `ComputerSettingsSchema` and `resolveComputerSettings` define the `computer.*` settings. `ComputerHandle` holds activation, the armed stop chord, and the user-only `stop()`/`resume()`. `runComputerCommand` implements `/computer on|off|status|stop|resume`. `isSupportedHost` accepts darwin, linux, and win32.
- `packages/desktop-tool/package.json`: depends on `-prelude`, `-protocol`, `-service`, and `typebox`.

### Why

- The desktop engine and service need a senpi tool surface: discoverable through tool_search, gated by permission-system tiers, and stoppable by the user without a TUI.

### Why an extension could not handle it

- This package is the extension-side half. The coding-agent `computer-use` builtin (todo 26) registers the tool, the parser, and the command. This package imports no coding-agent code.

### Expected merge conflict zones

- None in this package: it does not exist upstream.
