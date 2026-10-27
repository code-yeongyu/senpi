# JS kernel permission core

This is the core portion of senpi#4309. It provides the transport and lifetime
contract for a host `CellDecider`; it does not connect the permission extension.

## Host integration

`JavaScriptKernelOptions.permissions` supplies a current epoch snapshot and
`decide(token, call)`. Tokens identify the owning session and execution cwd.
The decision is either `pass` or `deny` with a rule's permission, pattern and
layer. The core does not interpret rule syntax or implement allow/ask precedence.

The host calls `revokeSessionKernels(sessionId)` when effective enforcement
changes. The call kills every authority word synchronously, interrupts parked
checks and waits for retirement. New cells wait for this completion. An
abandoned retirement permanently fences cell admission for the session and
emits `onRevocationFailed({ sessionId, kernelId })`.

The integration PR must connect that event to direct-tool admission. Direct
tools are not fenced by this core alone. Cross-session kernel-tool refusal
belongs to PR 2b; `resolveInvocationToken(request, options)` is its host seam.
For now each invocation gets a distinct token minted by the kernel's owner.

## Runtime invariants

Both worker entries load `interpose.js` first. It captures and patches builtins
before importing the runtime, including before a package can obtain a static
builtin binding. Originals stay in module-local closures. The one-time runtime
initializer does not export a token store or original functions.

The initial covered operations are `child_process.spawnSync`, `Bun.spawnSync`
and `fs.writeFileSync`. Arguments are analyzed only on the active path. Direct
argv becomes shell-quoted command text; a shell invocation uses the text the
shell actually receives. Requested path spelling is preserved for policy;
execution still resolves relative paths against the kernel cwd.

Each worker owns four bounded shared-memory slots. A generation-tagged CAS
claims each transition. The host claims WRITING before decoding the request or
calling the decider, so the requester cannot rewrite bytes the host is reading.
A timed-out WRITING slot remains host-owned, while unclaimed and interrupted
requests become ABANDONED. A stale interrupt cannot affect a later generation.
Checks have a 2000 ms worker-side deadline and fail closed on
transport, sizing, decoding or authority errors.

Authority follows `AsyncLocalStorage` rather than a mutable current-cell global.
No-token operations pass only when every bound token is alive and inactive;
idle code consults the kernel word. Settlement kills active tokens, but leaves
inactive continuations alive without retaining them in the host registry.
An interrupt or timeout releases tokens the same way. Cancellation still
kills the invocation token. A dead kernel word overrides
every token, including inactive tokens from settled runs. A token's death
takes precedence over its inactive bit.

Cell-created global Workers use a private MessagePort proxy. The host constructs
the instrumented worker and observes its exit directly, including nested
workers. The proxy forwards messages and transfer lists; each child gets its
own slot pool and the parent's shared authority. Retirement waits for observed
exit, not merely a termination request or a DEAD word. Inactive Workers use the
kernel lifetime, so later cells can use them or create them from a continuation.
User workerData is restored before user imports and preloads. User frames,
including primitives and objects resembling transport frames, remain data;
internal transfer envelopes carry a per-Worker key. MessagePorts transferred
through a raw `parentPort` frame are transferred on to the cell; a frame the
host cannot forward becomes a `messageerror` event and never throws in the
host listener. Error events carry the error
and its available source coordinates, and observed exit dispatches close.

## Scope boundary

Full API coverage is PR 3. This core is not a sandbox and does not claim read
completeness.

Known limitation: reads performed by the runtime's native module resolver (bare packages, tsconfig aliases, package.json #imports, symlinked packages) are not covered by this work; tracked in #4380.
