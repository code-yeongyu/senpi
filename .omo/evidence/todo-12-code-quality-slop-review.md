# Todo 12 Recovery Retry Proof Self-Review

Date: 2026-07-20
Base commit: `b07e6c8fd0cd5231d794f28a08f84c32f44f0dbf`
Scope: corrective test/evidence hardening only; production remains unchanged.

## Verdict

PASS. The corrective diff closes the independent verifier's HTTP-wire, retry-control, AgentSession-observable, bounded-signal, multi-retry, and custom-provider proof gaps without changing runtime behavior.

## Real HTTP boundary

- The localhost server reads every request body to completion and parses JSON.
- Both SDK attempts assert `model: upstream-nonclaude-model`, `stream: true`, identical structural bodies, empty messages, and mock-only `Authorization: Bearer test` with no `x-api-key`.
- Selected runtime model remains `claude-alias`, proving activation and wire identity are separate.
- The `maxRetries: 1` path observes two HTTP requests, one provider stream, one wrapper start, and `recovered-antml-0`.
- The real `maxRetries: 0` control observes one HTTP request, terminal error, and zero recovered calls.
- Mutation RED changed the wire model to the selected alias and failed exactly on the captured JSON body model field.

## AgentSession boundary

- Subscription is installed before `prompt()`.
- A bounded event promise waits for exactly two `auto_retry_start` events; no fixed sleep or polling is used.
- Two separate partial/error calls preserve only their own literal candidates and emit no tool calls or tool lifecycle.
- The third logical call recovers `recovered-antml-0` with exact arguments `{ value: second-attempt }`.
- Echo executes exactly once with those arguments and emits exactly one start/end lifecycle pair.
- A fourth provider call returns final assistant text `Final`; prompt completion and non-streaming session state are asserted.

## Custom provider boundary

- `extension-custom-recovery` is registered through `ModelRuntime.registerProvider`, with its own provider ID, API, model catalog, and `streamSimple` handler.
- The extension-selected Claude model recovers independently of the built-in/native provider fixture.

## Code quality and scope

- Changed files are tests only.
- No `any`, dynamic imports, ignored type errors, fixed sleeps, polling loops, credentials, paid endpoints, generated files, dependencies, or production changes.
- New helper files are below 250 LOC; the existing main runtime test is exactly 250 LOC.
- Localhost servers bind to `127.0.0.1` ephemeral ports and close in `finally`.

## Raw evidence

- `retry-proof-red.txt`
- `retry-proof-green.txt`
- `runtime-agent-unfiltered-twice-01.txt`
- `provider-retry-green-01.txt`
- `runtime-auth-provider-green-01.txt`
- `root-tsgo-green-01.txt`
- `builds-green-01.txt`
- `browser-green-01.txt`
- `biome-diff-loc-green-01.txt`
- `nonmutating-gates-green-01.txt`
