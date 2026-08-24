# packages/coding-agent/src/core

Session runtime, model/provider stack, session persistence, settings, resources. 72 flat `.ts` files (~28.8k LOC) plus six subtrees with their own AGENTS.md (`tools/`, `extensions/`, `dynamic-prompt/`, `compaction/`, `export-html/`, `retry-fallback/`). Reach for the extension API before adding anything here.

## HOTSPOTS (flat files >500 LOC)

| File | LOC | Owns |
|---|---|---|
| `agent-session.ts` | 8007 | `AgentSession`: prompt/steer/follow-up, tool registry, compaction admission/recovery, retry/fallback, abort provenance, navigation, extension binding |
| `package-manager.ts` | 2760 | `DefaultPackageManager`: install/update/remove, source parsing, git/npm, resource precedence |
| `settings-manager.ts` | 2022 | Layered global/project settings, JSONC, locking, queued writes, migrations |
| `session-manager.ts` | 1818 | Append-only JSONL entry stream, version-3 migrations, branching, labels, bounded header scans |
| `resource-loader.ts` | 1609 | `DefaultResourceLoader`: extension/hook/prompt/skill/theme discovery, precedence, generated shims |
| `model-resolver.ts` | 1054 | Scope parsing, minimatch narrowing, Cursor legacy aliases, ambiguity diagnostics, CLI/initial/session selection |
| `model-runtime.ts` | 931 | `ModelRuntime`: provider catalog composition, auth, refresh, availability snapshots, streaming |
| `auth-storage.ts` | 724 | `AuthStorage` + file/read-only/in-memory backends; lock-backed JSON, 0600 credentials |

`ModelRegistry` (`model-registry.ts`) is a synchronous compatibility facade over `ModelRuntime` — not a second implementation.

## WHERE TO LOOK

| Task | File |
|---|---|
| Session lifecycle / turn execution | `agent-session.ts` |
| New/switch/fork/import session | `agent-session-runtime.ts` (`createAgentSessionRuntime`) |
| Wire services into a session | `agent-session-services.ts` |
| Model selection / scope resolution | `model-resolver.ts` |
| Provider auth composition | `provider-composer.ts`, `provider-api-key-auth.ts`, `provider-header-auth.ts` |
| Credential storage | `auth-storage.ts` |
| Session persistence / branching | `session-manager.ts` |
| Settings read/write | `settings-manager.ts` |
| Bash execution (local or injected remote ops) | `bash-executor.ts` |
| Skill discovery + prompt formatting | `skills.ts` |
| Keybinding config + migration | `keybindings.ts` |
| Transport message conversion / image elision | `messages.ts` |

## CONVENTIONS

- **Layering is explicit**: services → runtime/session lifecycle → `AgentSession`. Dependency injection through option interfaces and factories, never global construction.
- **Session state is event-driven**: typed discriminated event unions, abort signals, queues, barriers, deferred settlement. No polling.
- **Provider/auth availability is capability-derived** — enumerate compatibility providers and inspect credentials/env; never hard-code availability from UI names.
- **Persistence is lock-backed**: `proper-lockfile` for credentials and file model stores, revision checks, atomic/coalesced reloads. Settings writes are queued with self-write tracking.
- **Branding propagates via `SENPI_BRAND`** then is scrubbed from spawned tool environments (`brand.ts`) so child engines never inherit it.
- Bash output is sanitized (ANSI/binary), bounded, and spilled to a temp file when truncated. Preserve abort-signal and chunk callbacks.
- Node imports use `node:` in newer files; `auth-storage.ts` retains bare `fs`/`path`. Mixed by history, not by accident.

## ANTI-PATTERNS

- Implementing an extension-capable feature here instead of `extensions/builtin/`.
- Mutating credentials through `ReadOnlyAuthStorage` (mutators throw by design) or bypassing lock/revision handling in the file backend.
- Assuming a session operation owns terminal state during compaction/retry/abort — ownership, deferred queues, epochs, and provenance exist to prevent duplicate transitions.
- Relying on `provider-composer.ts`'s `@deprecated` field for authentication; it is retained only for extension-source compatibility.
- Dropping legacy Cursor model aliases or model compatibility flags when touching resolution paths.

## NOTES

- `core/changes.md` (3.5k lines) is the fork ledger for this directory — read the relevant dated section before touching a hotspot.
- `output-guard.ts` holds process-global mutable stdio state with retry/backpressure timing; treat it as a process-wide singleton, not a helper.
- `session-summary-lru.ts` / `session-summary-cache.ts` enforce byte budgets; summary regeneration is not free.
