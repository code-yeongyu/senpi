# packages/coding-agent

`@code-yeongyu/senpi` is the user-facing CLI and the highest-conflict upstream fork surface. Use the extension API before editing `src/core/`.

## STRUCTURE

```text
src/cli.ts, cli-main.ts, main.ts   Bootstrap, args, mode dispatch
src/bun-runtime.ts              Bun-vs-Node runtime selection for bun-installed CLI (`SENPI_RUNTIME` pin)
src/bun/cli.ts, src/bun/register-cursor-agent.ts   Bun-binary entry; static cursor-agent module install
src/package-manager-cli.ts         install/update/config subcommands (incl. `senpi update --models`)
src/core/agent-session.ts          Session lifecycle and runtime
src/core/cursor-exec-bridge.ts     Maps Cursor exec frames to session tools (cursorExecHandlers wiring)
src/core/cursor-exec-bridge-session.ts  Per-session Cursor exec bridge state
src/core/agent-abort-provenance.ts Abort ownership across retries and event dispatch
src/core/agent-settled-delivery.ts Cancellable extension messages after settlement
src/core/dynamic-prompt/           Dynamic system-prompt assembly + workstation facts
src/core/model-runtime.ts          Model runtime bootstrap
src/core/model-config.ts           Per-model config resolution
src/core/models-store.ts           Persisted model store
src/core/provider-composer.ts      Provider payload composition
src/core/remote-catalog-provider.ts Remote model-catalog fetch
src/core/runtime-credentials.ts    Credential resolution and refresh
src/core/auth-providers.ts         Provider auth registration
src/core/provider-timeout-retry.ts Provider timeout/retry policy
src/core/retry-fallback/           Model fallback chains + billing classification
src/core/project-trust.ts, trust-manager.ts  Project trust decisions
src/core/resource-loader.ts        Bundled extension/resource resolution
src/core/session-resident-store.ts Session-resident state store
src/core/session-discovery.ts, session-record.ts, session-summary*.ts  Session listing, record shape, summary cache/LRU
src/core/extensions/               Public extension API and loader
src/core/extensions/builtin/       In-tree fork extensions; bundled extensions (e.g. codemode) resolved via resource-loader.ts
src/core/tools/                    Upstream-parity built-in tools
src/core/compaction/               Core compaction mechanics
src/modes/interactive/             TUI mode and components
src/modes/app-server/              App-server transport and RPC registry; runtime.ts
                                   wiring, search/ fuzzy file search
src/modes/rpc/                     JSONL RPC mode/client/types, shared Unix-socket multi-session host,
                                   ensureHost handshake, lifecycle supervisor/watchdog, and the ordered command
                                   surface (get_commands / commands_changed)
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
- RPC-mode JSONL is bounded and strict: LF-only framing, `MAX_RPC_LINE_CHARACTERS` 16 MiB line ceiling with oversized-record resynchronization, and `MAX_RPC_MESSAGE_CHARACTERS` 1,000,000-character message limit (`src/modes/rpc/jsonl.ts`, `src/modes/rpc/rpc-input-validation.ts`); preserve those bounds. App-server outbound stdio waits for stdout backpressure (`transports/stdio.ts`) and WebSocket closes slow clients at queue cap (`transports/websocket-connection-handler.ts`); app-server inbound NDJSON readers are not size-bounded — preserve those contracts.
- The RPC command surface (`get_commands`, post-baseline `commands_changed`, `command_invocation`/`skill_invocation` metadata) is owned by `src/modes/rpc/`; the suppressed initial `commands_changed` (baseline digest starts `undefined`) is intentional — see `src/modes/rpc/AGENTS.md`.
- MCP token/log storage preserves restricted directory/file permissions; do not widen inherited child environments. RPC child stderr is currently emitted and embedded raw, so treat diagnostics as potentially secret-bearing and do not claim redaction without implementing it.

## DOCS (`docs/`)

This section replaces the former `docs/AGENTS.md`. `docs/` ships in the npm tarball (`package.json` `files` includes `"docs"`) and `test/documentation.test.ts` rejects any Markdown page there that is not reachable from `docs.json`, so agent guidance lives here instead.

### Navigation manifest

`docs.json` has two top-level keys: `navigation` (ordered section and page list) and `redirects`.
Sections are `{ "title", "items": [{ "title", "path" }] }`; page paths are relative to `docs/`.

- Every new `.md` file needs an entry in `docs.json` under `navigation`.
- Renamed or moved pages need a `redirects` entry to avoid broken links.
- Navigation-only stubs without real content belong in `redirects`, not `navigation`.

### Landing page and images

`index.md` is the landing page. Images live under `docs/images/`:
`doom-extension.png`, `exy.png`, `interactive-mode.png`, `tree-view.png`.

New images go in `docs/images/`. Don't reference images by absolute URL when a relative path works.

### Protocol and reference pages

These pages must track their implementation counterparts. Treat them as specs, not tutorials.

| Page | Tracks |
|------|--------|
| `docs/rpc.md` | `src/modes/rpc/` |
| `docs/app-server.md` | `src/modes/app-server/` |
| `json.md` | JSONL wire format and record shapes |
| `session-format.md` | Session file structure and field types |
| `extensions.md` | Public extension API in `src/core/extensions/`; largest page — API tables must match `types.ts` |
| `release-guide.md` | Release tooling; canonical check/build/test/lock command sequences |

Preserve LF line endings and exact field names in these pages. Field spellings and JSONL record
structures are asserted by tests; prose-only rewording can still break them.

### Validators

- `packages/coding-agent/test/qa/app-server/task20-doc-example-check.ts`: Spins up a live
  app-server process and validates that JSON examples in `app-server.md` match actual server
  behavior. Prose edits to `app-server.md` that change JSON shapes will fail this test.

### Terminology

Docs mix `senpi` and upstream `Pi` branding in legacy text. Don't do broad rebrand sweeps
during focused edits; update only the immediate context you're working in.

Consistent names: CLI binary is `senpi`, config directory is `.senpi`, npm package is
`@code-yeongyu/senpi`. Don't use `codex`, `pi`, or `openai-codex` in new prose.

### Security rules

- `bearerTokenEnv` names an environment variable, not a token value. Examples must never put
  a literal token in the JSON config; the implementation warns when it detects one.
- OAuth tokens persist under the agent directory at runtime. Don't surface them in doc examples
  or log snippets.
- MCP config values are not shell-expanded. Don't document or imply `$VAR` substitution in
  JSON config examples.
- `mcp.md` must not advertise URL-mode elicitation; it's not a shipped feature.

### Anti-patterns

- No new `.md` file without a `docs.json` entry.
- Don't edit protocol page prose without checking whether `task20-doc-example-check.ts` would break.
- Don't copy claims from upstream Pi docs without verifying they apply to the senpi fork.
- Don't embed bearer tokens, session IDs, or raw API keys in example output.

## ANTI-PATTERNS

- Implementing extension-capable features in core.
- Editing `src/core/slash-commands.ts` for fork-only commands.
- Hardcoding keys, spending tokens in tests, or using real API credentials.
- Running release-only `prepublishOnly` as a repair command.
- Editing generated distribution output.

## VALIDATION

- Run changed test files from this package; issue regressions use `<issue>-<slug>.test.ts`.
- Code changes require root `bun run check` plus the applicable `senpi-qa` CLI channel and saved evidence.
- Interactive changes also follow `src/modes/interactive/AGENTS.md`; extension/tool changes follow their nearest child guide.
- App-server, test, and example changes follow their local `AGENTS.md` files.
- Keep `src/changes.md`, nested `changes.md`, public docs, and examples aligned with fork behavior.

---
Generated: 2026-08-22 | Commit: `a5eed4453`
