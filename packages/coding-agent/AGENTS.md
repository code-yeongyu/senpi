# packages/coding-agent

`@code-yeongyu/senpi` is the user-facing CLI and the highest-conflict upstream fork surface. Use the extension API before editing `src/core/`.

## STRUCTURE

```text
src/cli.ts, cli-main.ts, main.ts   Bootstrap, args, mode dispatch
src/package-manager-cli.ts         install/update/config subcommands (incl. `senpi update --models`)
src/core/agent-session.ts          Session lifecycle and runtime
src/core/dynamic-prompt/           Dynamic system-prompt assembly + workstation facts
src/core/model-runtime.ts          Model runtime bootstrap
src/core/model-config.ts           Per-model config resolution
src/core/models-store.ts           Persisted model store
src/core/provider-composer.ts      Provider payload composition
src/core/remote-catalog-provider.ts Remote model-catalog fetch
src/core/runtime-credentials.ts    Credential resolution and refresh
src/core/extensions/               Public extension API and loader
src/core/extensions/builtin/       In-tree fork extensions; bundled extensions (e.g. codemode) resolved via resource-loader.ts
src/core/tools/                    Upstream-parity built-in tools
src/core/compaction/               Core compaction mechanics
src/modes/interactive/             TUI mode and components
src/modes/app-server/              App-server transport and RPC registry
src/modes/rpc/                     JSONL RPC mode/client/types
src/modes/print-mode.ts            One-shot mode
test/suite/harness.ts              Preferred faux-provider harness
test/                              Test domains, fixtures, QA, integration gates
examples/                          Extension and SDK examples
src/changes.md                     Root fork-change record
```

## WHERE TO LOOK

| Task | First choice |
|---|---|
| Add tool, command, flag, or hook | `src/core/extensions/builtin/` |
| Change extension contract | `src/core/extensions/types.ts` and `src/core/extensions/changes.md` |
| Change session lifecycle | `src/core/agent-session.ts` |
| Change model/provider/catalog/auth runtime | `src/core/model-runtime.ts` + related `model-*/provider-*` modules |
| Change keybinding | `src/core/keybindings.ts` |
| Change interactive UI | `src/modes/interactive/` |
| Change RPC/app-server | matching directory under `src/modes/` |
| Add regression | `test/suite/regressions/` |
| Add or update an example | `examples/` and the matching public docs |

## CONVENTIONS

- Extension discovery includes builtin, project, user, settings, and CLI paths; preserve load, bind, event, reload, and shutdown ordering.
- Use `pi.registerTool()`, `pi.registerCommand()`, and `pi.registerFlag()` before adding core surfaces.
- Keybindings are configurable through `KEYBINDINGS`; never match hardcoded key literals.
- Public extension API changes require the nearest `changes.md` entry. Read `docs/extensions.md` before claiming a hook is missing.
- Keep branding consistent: package `@code-yeongyu/senpi`, binary `senpi`, config directory `.senpi`.
- Preserve the inlined UUIDv7 implementation; do not add a `uuid` dependency.
- Do not run real providers in tests. Use `test/suite/harness.ts` and the faux provider.
- RPC/app-server streams are LF-framed and request-correlated; preserve pending-work rejection on disconnect or child exit. Inbound NDJSON readers are not size-bounded; outbound stdio waits for stdout backpressure (`transports/stdio.ts`) and WebSocket closes slow clients at queue cap (`transports/websocket-connection-handler.ts`); preserve those contracts.
- MCP token/log storage preserves restricted directory/file permissions; do not widen inherited child environments. RPC child stderr is currently emitted and embedded raw, so treat diagnostics as potentially secret-bearing and do not claim redaction without implementing it.

## ANTI-PATTERNS

- Implementing extension-capable features in core.
- Editing `src/core/slash-commands.ts` for fork-only commands.
- Hardcoding keys, spending tokens in tests, or using real API credentials.
- Running release-only `prepublishOnly` as a repair command.
- Editing generated distribution output.

## VALIDATION

- Run changed test files from this package; issue regressions use `<issue>-<slug>.test.ts`.
- Code changes require root `npm run check` plus the applicable `senpi-qa` CLI channel and saved evidence.
- Interactive changes also follow `src/modes/interactive/AGENTS.md`; extension/tool changes follow their nearest child guide.
- App-server, test, and example changes follow their local `AGENTS.md` files.
- Keep `src/changes.md`, nested `changes.md`, public docs, and examples aligned with fork behavior.
