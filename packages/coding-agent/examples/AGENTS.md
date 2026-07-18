# packages/coding-agent/examples

Runnable examples for the public Senpi SDK and extension API. Examples are documentation-quality code and must reflect shipped APIs, not private core internals. Unqualified paths below are relative to this directory; `packages/...` paths are repository-relative.

## STRUCTURE

```text
extensions/        Tools, commands, UI, providers, hooks, resources
extensions/*/      Multi-file examples and nested private workspaces
sdk/               Programmatic SDK usage
rpc-extension-ui.ts RPC-compatible extension UI example
extensions/kimi-deferred-tools.ts  Deferred tool discovery/activation example
```

## CONVENTIONS

- Import public package surfaces such as `@code-yeongyu/senpi` and `@earendil-works/pi-ai`; do not reach into `packages/coding-agent/src/core/` internals.
- Keep examples small enough to teach one pattern, while preserving real error, cleanup, cancellation, and persistence behavior where relevant.
- Extension factories have no top-level runtime side effects. Register work through the public `pi.*` API and lifecycle events.
- New interactive examples should use configurable keybindings and themed TUI helpers. Existing demos may keep fixed controls when the control scheme is part of the example. Direct terminal writes belong only in examples explicitly teaching a terminal protocol; ordinary SDK examples may use normal stdout.
- Tool string enums use the shared `StringEnum` helper for provider compatibility.
- SDK examples should use `ModelRuntime` for auth/custom-model/session composition; deprecated static catalog helpers import from `@earendil-works/pi-ai/compat`.
- Deferred-tool examples preserve the Kimi flow: expose search first, activate via `pi.setActiveTools()`, and register lifecycle work in `session_start`.
- Stateful examples persist reconstructable state in session entries or tool-result details so fork/resume behavior remains valid.
- Nested example packages are private workspaces with exact-pinned dependencies. Treat their manifests and lock impact as production dependency changes.

## DOCUMENTATION CONTRACT

- Keep `extensions/README.md`, `packages/coding-agent/docs/extensions.md`, and `packages/coding-agent/docs/sdk.md` aligned with public API changes.
- New public extension capabilities should include a focused example when usage is not obvious from types alone.
- Do not present experimental or internal behavior as stable API.

## VALIDATION

- Run the focused tests for the public API demonstrated by the example.
- Typecheck examples through root `npm run check`.
- Interactive examples require real CLI or visual QA when their behavior changes.
