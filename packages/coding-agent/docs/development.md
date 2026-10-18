# Development

See [AGENTS.md](../../../AGENTS.md) at the monorepo root for fork-specific guidelines (`changes.md` contract, extension-first philosophy, tab indent / 120 width, etc.).

## Setup

```bash
git clone https://github.com/code-yeongyu/senpi
cd senpi
bun install
bun run build
```

Run from source:

```bash
/path/to/senpi/pi-test.sh
```

The script can be run from any directory. Senpi keeps the caller's current working directory.

### Experimental remote harness

The upstream remote harness server/client integration lives under `packages/coding-agent/src/experimental/` and is development-only. Run it from the repository with:

```bash
PI_EXPERIMENTAL=1 ./pi-test.sh server
PI_EXPERIMENTAL=1 ./pi-test.sh client
```

`PI_SERVER_DIR` overrides the server profile and socket directory (default: `~/.pi/server`). `PI_SERVER_ID` selects the logical server ID when `--server-id` is omitted.

The `experimental/plugin` subpath and the experimental server/client commands resolve only under the `source` condition in a checkout. Their implementations are excluded from npm packages and standalone binaries. Unlike upstream, `@earendil-works/pi-client` and `@earendil-works/pi-protocol` remain runtime dependencies of `@code-yeongyu/senpi`, and the `./client` entry point stays published; only the experimental sources are source-only. The local SDK and stdio RPC API are unchanged.

## Forking / Rebranding

This repo is itself a rebrand of upstream `pi-mono` to `senpi`. The runtime identity (CLI name, config dir, env var prefix) is configured via `package.json`:

```json
{
  "piConfig": {
    "name": "senpi",
    "configDir": ".senpi"
  }
}
```

Change `name`, `configDir`, and `bin` field for your fork. Affects CLI banner, config paths, and environment variable names.

## Path Resolution

Three execution modes: bun install, standalone binary (`bun build --compile`), tsx from source.

**Always use `src/config.ts`** for package assets:

```typescript
import { getPackageDir, getThemesDir } from "./config.js";
```

Never use `__dirname` directly for package assets.

## Debug Command

`/debug` (hidden) writes to `~/.senpi/agent/senpi-debug.log`:
- Rendered TUI lines with ANSI codes
- Last messages sent to the LLM

## Testing

```bash
bun run test            # Vitest across workspaces (skips live-API; default test runner)
./pi-test.sh        # Launch the CLI from source via tsx for manual testing (--no-env unsets API keys)
bun run check       # Biome + tsc + browser-smoke check (pre-commit equivalent)
```

Live-API tests are env-gated vitest tests. Set `PI_ENABLE_LIVE_API_TESTS=1` (or a per-provider flag from `packages/ai/test/live-api-gates.ts`) plus the provider API keys, then run `bun run test`.

Run a specific test from the package, or from the repository root through the workspace runner (the root form runs the `scripts/` tests first):

```bash
bun run --cwd packages/coding-agent test -- test/specific.test.ts
bun run test --workspace packages/coding-agent -- test/specific.test.ts
```

### Published package smoke test

After building, run `npm run check:package-install`. It packs the public packages and installs only coding-agent as a direct dependency in a temporary directory outside the repository. Local tarball overrides select declared transitive dependencies without installing development-only packages. The check verifies SDK imports and CLI startup without credentials or model requests.

`npm run check` also checks runtime dependency declarations and rejects excluded development sources pulled into a package's build through imports.

## Project Structure

```
packages/
  ai/           # @earendil-works/pi-ai — LLM provider abstraction
  agent/        # @earendil-works/pi-agent-core — Agent loop and message types
  tui/          # @earendil-works/pi-tui — Terminal UI components
  coding-agent/ # @code-yeongyu/senpi — CLI and interactive mode (this package)
```

See the monorepo root [AGENTS.md](../../../AGENTS.md) for the full task → location map.
