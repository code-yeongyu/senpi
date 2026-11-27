# JS kernel permission core

This is the core portion of senpi#4309. It provides the transport and lifetime
contract for a host `CellDecider`; it does not connect the permission extension.

## Host integration

`JavaScriptKernelOptions.permissions` supplies a current epoch snapshot and
`decide(token, call)`. Tokens identify the invoking session and execution cwd.
The decision is either `pass` or `deny` with a rule's permission, pattern and
layer. The core does not interpret rule syntax or implement allow/ask precedence.

The host calls `revokeSessionKernels(sessionId)` when effective enforcement
changes. The call kills every authority word synchronously, interrupts parked
checks and waits for retirement. New cells wait for this completion. An
abandoned retirement permanently fences cell admission for the session and
emits `onRevocationFailed({ sessionId, kernelId })`.

The integration PR must connect that event to direct-tool admission. Direct
tools are not fenced by this core alone.

The coding-agent dispatcher stamps `options.invoker.sessionId` from its own
SessionManager. Neither cell data nor tool arguments can override that identity.
Registered extension event handlers also bind their own host context, rather
than inheriting a parent task tool's identity when a child emits an event.
The shared host pump forwards these options to `resolveInvocationToken` before
posting an invocation frame. Absent or owner identity mints an owner token;
another session is refused before the body runs if either session enforces,
with `reason: "cross_session_authority"` and the enforcing session identified.
The attached `rule` names a deny rule activating that session's enforcement;
it does not claim that this rule matched an operation inside the unexecuted
tool body. Otherwise the token identifies the invoker.
Python applies the same cross-session check before posting to the interpreter.

Live kernel owners publish their current permission snapshots to the host-only
invocation registry. The permission integration supplies `permissions.resolveSession`
for sessions without a kernel, returning that session's current state and cwd.
Without integration or a registered kernel, a session has no enforcing state in
this core and retains the existing inactive behavior. No invoker identity or
session resolver is accepted by the worker protocol. An active JS invocation
also binds its destination kernel to the invoker's revocation lifecycle. A
settled inactive invocation keeps that binding until the worker retires, so
the invoker's revocation still reaches the continuations it left behind.

## Runtime invariants

Both worker entries load `interpose.js` first. It captures and patches builtins
before importing the runtime, including before a package can obtain a static
builtin binding. Originals stay in module-local closures. The one-time runtime
initializer does not export a token store or original functions.

Operation families are installed by `interpose-fs.js`, `interpose-process.js`,
`interpose-bun.js` and `interpose-sqlite.js` through the same check closure.
Arguments are analyzed only on the active path. Direct
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

PR 3 extends the operation table without changing authority or slot messages.
Resource tables retain each open's path and access modes; locally granted
operations still check authority liveness before using a resource. Engine
package-resolution reads and process retirement use one-time, closure-private
originals, rather than gaining an exemption for an installation path.

The module plugin observes resolution only and lets the native loader handle
attributes. Cell import and require routes also check relative and absolute
paths. Dynamic-code preflight runs in the host AST preparer so workers remain
dependency-free and direct eval retains lexical scope.

Native capability residual: Bun 1.4.4 makes both the global `Bun` binding and `Bun.plugin`
non-writable and non-configurable. The cell-local binding can guard plugin calls;
native libraries' plugin calls and non-literal dynamic evaluation remain available.
The native-loader regression matrix verifies that code reached through these routes
still encounters the enforced synchronous/asynchronous spawn and write checks.
The engine adds no onLoad transform. Final acceptance of this named residual
remains with the lead.
This core is not a sandbox and does not claim read completeness.

Known limitation: in natively loaded dependencies, Bun.plugin registration and non-literal eval are not refused (Bun 1.4.4 makes Bun.plugin immutable); code loaded that way still runs under the enforced spawn and write checks; tracked in #4380.

Known limitation: reads performed by the runtime's native module resolver (bare packages, tsconfig aliases, package.json #imports, symlinked packages) are not covered by this work; tracked in #4380.
