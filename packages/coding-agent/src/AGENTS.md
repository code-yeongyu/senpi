# packages/coding-agent/src

## OVERVIEW

Runtime bootstrap and public entry points (score 13: large code tree, public barrel, dense exports); this guide owns startup boundaries, not the core or mode implementations.

## STRUCTURE

```text
cli.ts -> cli-main.ts -> main.ts   Runtime selection, lightweight dispatch, full CLI
index.ts                         Public SDK exports; not the executable entry
rpc-entry.ts                     Dedicated RPC executable entry
cli/                             Argument/auth/startup adapters
client/                          RemoteSession facade exported as package ./client
bun/                             Compiled-Bun entry and provider registration adapters
beta/                            Removable OMO local-update feature
core/                            Session/services/providers/resources
modes/                           Interactive, print, RPC and app-server hosts
utils/                           Platform and terminal support
```

## WHERE TO LOOK

| Task | Location | Boundary |
|---|---|---|
| Bun-installed CLI starts under Node | `cli.ts`, `bun-runtime.ts`, `bun-global-launcher.ts` | Resolve the symlink target before re-exec |
| Startup latency / debugger inheritance | `compile-cache.ts`, `inspector-policy.ts` | Cache setup follows Bun selection and precedes full CLI loading |
| Broken installed dependency repair | `self-update-bootstrap.ts` | Runs before loading the full engine |
| Install/update/config commands | `package-manager-cli.ts` | Separate package-management dispatch |
| Config, brand, install and asset paths | `config.ts` | Source, installed package and compiled binary have different roots |
| Agent-directory migrations | `brand-dir-migration.ts`, `legacy-senpi-dir-migration.ts`, `extension-system-migration.ts`, `migrations.ts` | Preserve migration-specific entry paths |
| Invalid launch directory | `valid-cwd.ts` | Imported before the rest of CLI bootstrap |
| Local OMO beta update | `beta/omo-local-update.ts` | Production API is `runOmoLocalUpdateBeta`; other helpers are test seams |

## CONVENTIONS

- `cli.ts` answers root `--version` without loading the engine; keep the deferred `cli-main.ts` import boundary.
- The CLI stays in-process unless custom Node `execArgv` or inherited Inspector options require a child. Forward the child's exit code or signal.
- Bun re-exec deliberately drops Node `execArgv`; `SENPI_RUNTIME` controls the explicit runtime choice.
- Compile-cache setup also publishes its directory for a spawned `cli-main` child; preserve both startup paths.
- `config.ts` distinguishes source, package-manager and Bun-binary installs. Asset lookup must not manufacture `dist/dist/` paths.

## ANTI-PATTERNS

- Static-importing the full CLI engine above the version/bootstrap-repair fast paths.
- Treating `bin/senpi` as launcher implementation; it is only a link to built output.
- Importing beta test helpers as production APIs or folding removable beta behavior into the ordinary bootstrap.
- Conflating `src/client/` with JSONL RPC: it wraps the separate `pi-client` / `pi-protocol` session stack.
