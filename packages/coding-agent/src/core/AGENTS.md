# packages/coding-agent/src/core

Session runtime, model/provider stack, session persistence, settings, resources. 85 flat `.ts` files (~31.6k LOC) plus seven subtrees, including the shared `credential-pool/`. Score 11: large code-heavy domain with dense symbols/exports and seven module subtrees. Reach for the extension API before adding anything here.

## HOTSPOTS (flat files >500 LOC)

| File | LOC | Owns |
|---|---|---|
| `agent-session.ts` | 9031 | `AgentSession`: prompt/steer/follow-up, tool registry, compaction admission/recovery, retry/fallback, abort provenance, navigation, extension binding |
| `package-manager.ts` | 2777 | `DefaultPackageManager`: install/update/remove, source parsing, git/npm, resource precedence |
| `settings-manager.ts` | 2086 | Layered global/project settings, JSONC, locking, queued writes, migrations |
| `session-manager.ts` | 2035 | Append-only JSONL entry stream, version-3 migrations, branching, labels, bounded header scans |
| `resource-loader.ts` | 1576 | `DefaultResourceLoader`: extension/hook/prompt/skill/theme discovery, precedence, generated shims |
| `model-resolver.ts` | 1056 | Scope parsing, minimatch narrowing, Cursor legacy aliases, ambiguity diagnostics, CLI/initial/session selection |
| `model-runtime.ts` | 1094 | `ModelRuntime`: provider catalog composition, auth, refresh, availability snapshots, streaming |
| `auth-storage.ts` | 766 | `AuthStorage` + file/read-only/in-memory backends; lock-backed JSON, 0600 credentials |
| `provider-composer.ts` | 606 | Provider auth composition and availability |
| `model-config.ts` | 578 | Model validation and config resolution |
| `sdk.ts` | 570 | Session factories and runtime wiring |
| `skills.ts` | 529 | Skill discovery and invocation formatting |

`ModelRegistry` (`model-registry.ts`) is a synchronous compatibility facade over `ModelRuntime` — not a second implementation.

## WHERE TO LOOK

| Task | File |
|---|---|
| Session lifecycle / turn execution | `agent-session.ts` |
| New/switch/fork/import session | `agent-session-runtime.ts` (`createAgentSessionRuntime`) |
| Wire services into a session | `agent-session-services.ts` |
| Model selection / scope resolution | `model-resolver.ts` |
| Provider auth composition | `provider-composer.ts`, `provider-api-key-auth.ts`, `provider-header-auth.ts` |
| Credential storage / account listing | `auth-storage.ts`, `credential-accounts.ts` |
| Shared credential rotation / health | `credential-pool/{rotation-stream,state-store,classify,failover,env-slots}.ts` |
| Pending-work coordination / write ownership | `session-work-barrier.ts`, `session-write-reservation.ts` |
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
- **Branding propagates via `SENPI_BRAND`**; `scrubBrandFromEnvironment()` (`brand.ts`) clears only the JS-level `process.env` view. Under Bun, `delete process.env.X` does not unsetenv for spawned children (verified 2026-08-25: a `Bun.spawn` child still sees the original value after the delete), so tool children inherit the full launcher env — `SENPI_BRAND`, `OMO_CODING_AGENT_DIR`, and `SENPI_CODING_AGENT_DIR` included. Never rely on the scrub to keep brand or agent-dir state out of subprocesses; pass an explicit sanitized `env` at spawn where that matters (the vitest quarantine in `test/setup.ts` is the model).
- Bash output is sanitized (ANSI/binary), bounded, and spilled to a temp file when truncated. Preserve abort-signal and chunk callbacks.
- Node imports use `node:` in newer files; `auth-storage.ts` retains bare `fs`/`path`. Mixed by history, not by accident.

## ANTI-PATTERNS

- Implementing an extension-capable feature here instead of `extensions/builtin/`.
- Mutating credentials through `ReadOnlyAuthStorage` (mutators throw by design) or bypassing lock/revision handling in the file backend. `credential-pool/state-store.ts` is a health-only sidecar: never persist credential material there; env slots use installation-local HMAC revisions.
- Assuming a session operation owns terminal state during compaction/retry/abort — ownership, deferred queues, epochs, and provenance exist to prevent duplicate transitions.
- Relying on `provider-composer.ts`'s `@deprecated` field for authentication; it is retained only for extension-source compatibility.
- Dropping legacy Cursor model aliases or model compatibility flags when touching resolution paths.

## NOTES

- `core/changes.md` is the fork ledger for this directory — read the relevant dated section before touching a hotspot.
- `output-guard.ts` holds process-global mutable stdio state with retry/backpressure timing; treat it as a process-wide singleton, not a helper.
- `session-summary-lru.ts` / `session-summary-cache.ts` enforce byte budgets; summary regeneration is not free.
