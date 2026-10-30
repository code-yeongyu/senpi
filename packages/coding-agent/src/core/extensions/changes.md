## 2026-10-29 - ctx.afterSessionStart publishes recovered work after startup (senpi#4827)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.afterSessionStart?(publish)`, an optional hook that runs `publish` once every handler of the current `session_start` dispatch has returned (immediately outside a dispatch).
- `packages/coding-agent/src/core/extensions/runner.ts`: `createContext()` implements it with the existing `SessionStartTurnGate.admit()`, the same post-dispatch point that starts turns requested during `session_start`. The deferred `publish` is skipped once the runner is stale (the session was switched, replaced, reloaded or disposed before the dispatch ended), and a promise it returns is observed: a `StaleExtensionContextError` is dropped and any other rejection is reported through `emitError`, never left unhandled.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/extension.ts`: the `session_start` handler hands `resumeDanglingQuestion` to `ctx.afterSessionStart` instead of publishing the recovered question from inside the dispatch, returning its promise so the runner observes it; it never awaits the answer.

### Why

- Handlers run serially and ask-user precedes websearch, so a question recovered on `resume`/`reload` was published (on RPC: the select request emitted) while later handlers such as websearch's async config load were still running. RPC `switch_session` does not await binding, so a client could answer mid-startup and its lifecycle rows landed before the startup status/widget requests (E25 O6). Awaiting `resumeDanglingQuestion` changes nothing (it has no `await`), and awaiting the question would block startup on a person.
- A switch or new session can retire the old generation while its `session_start` dispatch is still suspended in a later handler; a deferred publish then read the stale `ctx.sessionManager`, which throws, and the rejection was unhandled.

### Why an extension could not handle it

- Only the runner knows when the last `session_start` handler of a dispatch has returned; an extension sees its own handler only.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext` after `getAskUserSettings`.
- `packages/coding-agent/src/core/extensions/runner.ts`: `createContext()` after `getAskUserSettings`.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/extension.ts`: end of the `session_start` handler.

## 2026-10-29 - Extension transports must send requests to model.baseUrl (senpi#4765)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: the `registerProvider`, `streamSimple` and `ProviderConfig.baseUrl` docs state the contract: when models.json sets a `baseUrl` (provider or `models[i]`), every model of that provider carries it, and an extension that supplies its own transport (`streamSimple`, `images`, `classifiers`, or a native `Provider`'s `stream`) must send requests to `model.baseUrl`.

### Why

- senpi#4765: a models.json baseUrl now wins over the extension's for every model. A custom transport that builds its own URL instead of reading `model.baseUrl` would still ignore the user's setting, so the registration contract says so. In-tree transports: `custom-provider-anthropic` already reads `model.baseUrl`; `vertex-model-garden` (#4817), the `custom-provider-gitlab-duo` example (#4818) and `anthropic-subscription` (#4822) are fixed in stacked PRs; `cursor-cli-oauth` cannot, because the Cursor CLI it spawns has no base-URL option (decision pending).

### Why an extension could not handle it

- The registration contract is the public `ProviderConfig` type extensions program against; only its docs can state it.

### Expected merge conflict zones

- LOW: the `registerProvider` doc block and the `ProviderConfig.baseUrl` doc comment in `types.ts`.

## 2026-10-29 - Extension RPC handlers receive a trusted owner context (senpi#4728, #4775)

### What changed

- `packages/coding-agent/src/core/extensions/rpc-context.ts` (new): `ExtensionRpcRequestContext` with `ownerId`, `disconnectSignal` and a synchronous `admit(dispatch)`. `ExtensionRpcRequestHandler` gains an optional second `context` argument; data-only handlers stay source compatible.
- `packages/coding-agent/src/core/extensions/rpc-request.ts` (new): the runner's request dispatch, admitting the handler call and its result through the captured context. Internal calls without a transport pass `undefined`, never a fabricated owner.
- `packages/coding-agent/src/core/extensions/loader.ts`: map `@code-yeongyu/senpi/session-worker-data` for loaded extensions (virtual module and jiti alias), so an extension shares the host's per-session-Worker data registry instead of failing to resolve the subpath.
- `packages/coding-agent/src/core/extensions/runner.ts`, `types.ts`, `index.ts`, `packages/coding-agent/src/index.ts`: `requestRpc(name, data, context?)` delegates to `rpc-request.ts`; the context types are exported.

### Why

- A shared host lets several connections call the same extension. Handlers could not tell which transport called them or cancel work when that caller left, so a long-running ceremony could finish for a departed or replaced caller (senpi#4728, #4775).

### Why an extension could not handle it

- Transport identity never reached the extension boundary: `connection-handler.ts` dropped it before `requestRpc`, and request JSON is caller-controlled, so an extension cannot derive a trustworthy owner itself.

### Expected merge conflict zones

- LOW: `requestRpc` in `runner.ts` (now a delegation) and the `ExtensionRpcRequestHandler` export in `types.ts`.

## 2026-10-29 - Extensions hear when an RPC client starts receiving extension events (job widgets P4b)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `onRpcEvent` emits `senpi:extension-rpc-subscribed` (no data) on the extension event bus right after it subscribes, which happens when an RPC connection starts receiving extension events (handshake capability or a `set_client_info` that declares `extension_events`, and each session re-bind). Documented in `docs/rpc.md`.

### Why

- Extension events are not replayed, so an extension holding a state snapshot (job widgets) had no moment to send it to a late client.

### Why an extension could not handle it

- Only the runner knows when an RPC client subscribes; extensions see the bus, not connections.

### Expected merge conflict zones

- LOW: `ExtensionRunner.onRpcEvent`.

## 2026-10-28 - registerMcpServer JSDoc states the session-order clash rule (senpi#4625, part of #4607)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: the `registerMcpServer` JSDoc says that when several extensions register the same name, the declaration from the extension earliest in the session's extension order is kept, regardless of which registered first. It replaces "a name another extension registered first is kept". JSDoc only; no type or runtime change.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: the JSDoc ships in the public `.d.ts` and has to match the registry (`mcp-server-registry.ts`, bound to the runner's extension list in `runner.ts`), which keeps the earliest extension in session order, not the earliest registration in time.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: this is the public extension API's own documentation, which only the API definition can carry.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: the `registerMcpServer` JSDoc block in `ExtensionAPI`, a fork-added member with no upstream counterpart at that line.

## 2026-10-28 - Upstream MCP extension API: getMcpServers, unregisterMcpServer, mcp_servers_change (senpi#4604, fixes #4597)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI` gains `unregisterMcpServer(name)` and `getMcpServers(): RegisteredMcpServer[]`; `RegisteredMcpServer` is upstream's `{ name, config, extensionPath }` and `RegisteredMcpServerDeclaration` now extends it with `registrationCwd`; the `McpServersChangeEvent` (`mcp_servers_change`) joins `ExtensionEvent` and the `pi.on` overloads; `ExtensionRuntimeState.mcpServers` holds the registry; `ExtensionContext.extensionConnectsMcpServers?()` reports whether a loaded extension handles the event.
- `packages/coding-agent/src/core/extensions/mcp-server-registry.ts` (new): `McpServerRegistry`, the runtime-level index of the extension records' `mcpServers` maps: `track`/`untrack` at load, `bind(extensions)` from the runner so only the final bound extension set counts, in the runner's order (first declaration per name wins, as before); `declarations()`, `list()` copies, `changed()` and the change listener.
- `packages/coding-agent/src/core/extensions/loader.ts`: `createExtensionRuntime()` creates the registry; `initializeExtension` tracks the record (and untracks it when the factory fails); `registerMcpServer` keeps writing the record's `mcpServers` map (cloned) and notifies the registry; `unregisterMcpServer` and `getMcpServers` follow.
- `packages/coding-agent/src/core/extensions/runner.ts`: the constructor binds the registry to its extension list, so extensions the resource loader dropped after loading (replaced, shadowed after trust, filtered) register nothing; `getRegisteredMcpServers()` reads the registry; `bindCore` arms the registry change listener to emit `mcp_servers_change`; `extensionConnectsMcpServers()` is `hasHandlers("mcp_servers_change")` and is exposed on the extension context.
- `packages/coding-agent/src/core/extensions/index.ts`: exports the `RegisteredMcpServer` and `McpServersChangeEvent` types.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`, `loader.ts`, `runner.ts`: `pi-mcp-adapter` 5.1 and other extensions written against the upstream Pi 1.x API probe `registerMcpServer` and then call `pi.getMcpServers()` unconditionally; without the rest of upstream's contract they threw `pi.getMcpServers is not a function` at every session start (code-yeongyu/oh-my-openagent#11582).
- `packages/coding-agent/src/core/extensions/mcp-server-registry.ts`: one runtime-level list keeps `pi.getMcpServers()`, the event payload and the built-in gateway's view identical, as upstream does.
- `packages/coding-agent/src/core/extensions/index.ts`: extensions need the public types.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`, `loader.ts`, `runner.ts`, `mcp-server-registry.ts`, `index.ts`: the `pi` API surface, the runtime registry and event dispatch are host-side; an extension cannot add members to `pi` or emit runner events.

### Expected merge conflict zones

- MEDIUM: `ExtensionAPI` around `registerMcpServer`, the `ExtensionEvent` union, the `pi.on` overload list and `ExtensionRuntimeState` in `types.ts`; upstream carries the same members with its own `McpServerConfig` type and `McpServerRegistry` module path.
- LOW: the `registerMcpServer`/`unregisterMcpServer`/`getMcpServers` block in `loader.ts`, the change-listener lines in `bindCore` and the context getters in `runner.ts`.

## 2026-10-27 - `ctx.sessionEnv` on the extension context (fixes senpi#4381)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.sessionEnv` (read-only, absent when the opener gave none) and the `getSessionEnv` context action.
- `packages/coding-agent/src/core/extensions/runner.ts`: the context getter, bound from the session's action like `browserEngine`.
- `packages/coding-agent/src/core/extensions/builtin/terminal/tools/bash.ts`: `SessionEnvSource.sessionEnv`; `sessionEnvOverrides` starts from it, so the PTY bash tool, its background sessions and the tool child's placement all apply the session's caller env beneath the `PI_*` values.

### Why

- Tool subprocesses are spawned by the terminal extension, which reads per-session values only through the context it is handed.

### Why an extension could not handle it

- The context contract itself is the change; an extension cannot add a getter to the context it receives.

### Expected merge conflict zones

- LOW: the `browserEngine` getter block in `ExtensionContext` and `ExtensionContextActions` (`types.ts`), the getter block in `runner.ts`, the `SessionEnvSource` type and the first line of `sessionEnvOverrides` in the terminal bash tool.

## 2026-10-27 - The input event says whether the user or an agent sent the input (senpi#4482)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new exported `InputAttribution = "user" | "agent"`; `InputEvent` gains a required `attribution` field. `source` keeps its meaning (the channel the input arrived on).
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitInput` takes an optional sixth argument `attribution`, defaulting to what `source` alone implies (`interactive` => `"user"`; `extension`, and `rpc` from a connection whose role is unknown => `"agent"`), and puts it on every `input` event.
- `packages/coding-agent/src/core/extensions/index.ts`: re-exports `InputAttribution`.

### Why

- An extension that must react only to the person's own messages (OmO computer use lifting its Esc stop on the user's next message, code-yeongyu/oh-my-openagent#11459) could not tell typed or the user's own client input from input an extension, tool, subagent or a parent agent's RPC client sends (senpi#4471).

### Why an extension could not handle it

- Only the session knows who started an input; the `input` event carried just the channel, and `source: "extension"` covers both an extension's own sends and a person's answer delivered through the extension API.

### Expected merge conflict zones

- LOW: the `InputEvent` interface and the `InputSource` alias in `types.ts`; `emitInput`'s signature and event literal in `runner.ts`; the `Input*` re-export block in `extensions/index.ts`.

## 2026-10-27 - provider_login_start: awaited extension event before a provider login (senpi#4436)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new `ProviderLoginStartEvent` (`provider`, `signal`, `progress`), its `pi.on("provider_login_start")` overload, its entry in the `ExtensionEvent` union, and `ExtensionRuntimeState.emitProviderLoginStart`.
- `packages/coding-agent/src/core/extensions/loader.ts`: `pi.registerProvider(name, config)` wraps `config.oauth.login` through `withProviderLoginStart`, and the unbound runtime's `emitProviderLoginStart` resolves at once.
- `packages/coding-agent/src/core/extensions/runner.ts`: the runner owns `runtime.emitProviderLoginStart` from construction; `emitProviderLoginStart` awaits every handler in order, reporting a failing handler as an extension error.
- `packages/coding-agent/src/core/extensions/provider-login-start.ts` (fork-only): the wrapper.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: the Claude subscription login moves to the bundled `claude` CLI (senpi#4436), so a host extension (omo's claude-code component) must download and pin the binary before the login resolves it. Every login entry point (TUI `/login`, RPC `login_start`, account commands) reaches the registered config, so one wrap at registration covers them all.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: one extension cannot run code inside another extension's provider login; only the host can order an awaited cross-extension event before it.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/types.ts`: the `ExtensionEvent` union, `pi.on` overloads and `ExtensionRuntimeState` fields.
- LOW: `packages/coding-agent/src/core/extensions/loader.ts`: `registerProvider` in the extension API and the unbound runtime defaults.
- LOW: `packages/coding-agent/src/core/extensions/runner.ts`: the runner constructor and the emit helpers next to `emitResourcesDiscover`.

## 2026-10-26 - Host-bound kernel-tool invoker identity (senpi#4390, part of #4309)

### What changed

- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts`: add host-only invocation identity.
- `packages/coding-agent/src/core/extensions/runner.ts`: stamp the invoking SessionManager's identity after every caller-supplied option.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: bind dispatcher-free tool calls to their host context.
- `packages/coding-agent/src/core/extensions/loader.ts`: bind registered event and hook handlers to their emitting host context without replacing their registered-handler metadata. A stale context (session replacement reports `session_extensions_removed` on the invalidated runner) binds no invoker, so its handler still runs without borrowing the emitting scope's identity.

### Why

- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts`: cross-session kernel permissions need a host-authenticated caller.
- `packages/coding-agent/src/core/extensions/runner.ts`: cell arguments and inherited capabilities must not select the permission session.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: a capability captured in a parent still runs with the child's host identity.
- `packages/coding-agent/src/core/extensions/loader.ts`: a child handler must not inherit a parent's task-tool invoker and bypass cross-session admission.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts`: this contract crosses the dispatcher and kernel host.
- `packages/coding-agent/src/core/extensions/runner.ts`: only the dispatcher owns the calling session's SessionManager.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: the host wrapper owns the fallback execution boundary.
- `packages/coding-agent/src/core/extensions/loader.ts`: handler registration is the common host boundary for every event and hook dispatch path.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts`: invocation options.
- `packages/coding-agent/src/core/extensions/runner.ts`: the lazy kernelTools context getter.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: registered tool execution.
- `packages/coding-agent/src/core/extensions/loader.ts`: the owned registered-handler wrapper.

## 2026-10-26 - Bound provider actions receive the registering extension's path (senpi#4334, fixes #4328)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `bindCore`'s `providerActions.registerProvider` and
  `registerNativeProvider` take an optional third/second `extensionPath`; the pre-bind queue flush and the
  post-bind `runtime.registerProvider`/`registerNativeProvider` pass it through. The public `pi.registerProvider`
  API is unchanged.

### Why

- The model runtime reports which extension defined a provider (`get_auth_providers` `origin.extensionPath`), and
  only the runner knows the registering extension.

### Why an extension could not handle it

- The registering extension's path is host-side bookkeeping the runner owns; an extension cannot report it for
  another extension's registration.

### Expected merge conflict zones

- LOW: the `providerActions` parameter type of `bindCore`, the pending-registration flush loop and the post-bind
  `runtime.registerProvider`/`registerNativeProvider` assignments.

## 2026-10-26 - ambientAuth resolve input can read stored provider env (senpi#4339)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: the extension-facing `ProviderConfig.ambientAuth.resolve` input gains optional `storedProviderEnv(providerId)` — a read-only env-only view of another provider's stored credential (routing metadata only, never keys).

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: ambient lanes that share a cloud credential chain (vertex-garden over google-vertex ADC) need the sibling profile's project; `AuthContext` alone cannot express that read.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the input is part of the public provider contract dispatched by the runner; an extension cannot widen its own resolve input.

### Expected merge conflict zones

- LOW: the `ambientAuth` block inside `ProviderConfig`.

## 2026-10-25 - Ephemeral terminal dialogs for private MCP forms (#4207)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: add an optional ephemeral-dialog flag forwarded to the real in-process terminal dialog adapter; private forms produce no generic blocked event or pending marker.
- `packages/coding-agent/src/core/extensions/runner.ts`: carry an existing host-issued MCP presenter onto the session UI wrapper while retaining its raw UI and lifetime signal.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: form labels, drafts, identifiers, and interaction state must stay outside generic host-status and persistence surfaces.
- `packages/coding-agent/src/core/extensions/runner.ts`: extensions see a wrapped UI object, so presenter identity must survive that wrapper without sending private forms through titled prompt events.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the terminal host owns dialog publication and presentation lifetime, so an extension cannot independently suppress those side effects.
- `packages/coding-agent/src/core/extensions/runner.ts`: the runner creates the UI wrapper and owns ordinary prompt-event publication; the binding cannot recover raw host identity from a serialized or arbitrary UI object.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIDialogOptions` and terminal-only option forwarding; legacy RPC forms keep their existing channel.
- `packages/coding-agent/src/core/extensions/runner.ts`: `wrapUIPromptContext` and host presenter inheritance.

## 2026-10-24 - Before-prompt custom message placement (senpi#4166)

### What changed

- `types.ts`: an optional `message.placement: "before-prompt"` requests persisted
  delivery before the current prompt. `docs/extensions.md` documents its ordering.

### Why

Hidden user-role notices must not become the final user request.

### Why an extension could not handle it

The shared extension result contract must carry placement to session ingestion.

### Expected merge conflict zones

- `types.ts`: `BeforeAgentStartEventResult`.

## 2026-10-22 - Extensions cannot open engine custody keys (senpi#3986)

### What changed

- `packages/coding-agent/src/core/extensions/lifecycle-api.ts`: `pi.lifecycle.obligations.open` and a token's `transfer` refuse keys under `delivery:` or `wake-source:` with a typed `ReservedCustodyKey` error; the engine's own calls are unaffected.

### Why

- `packages/coding-agent/src/core/extensions/lifecycle-api.ts`: the engine identifies its delivery tickets and wake sources by those prefixes, so an extension ticket under them would be cancelled on a queue clear or retired as a stale wake source.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/lifecycle-api.ts`: the guard sits on the extension API itself; an extension cannot restrict what other extensions pass to `pi.lifecycle.obligations`.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/lifecycle-api.ts`: `createLifecycleApi` now wraps `obligations`; upstream changes to that factory need the wrapper kept.

## 2026-10-22 - `pi.session.relocationTargets()` and `pi.session.requestRelocation()` (senpi#3959)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts`: the `pi.session` object forwards `relocationOffered()`, `relocationTargets(signal?)` and `requestRelocation({ target, reason }, signal?)` to the bound `SessionControlActions` (types in `session-control-types.ts`, results in `core/session-relocation.ts`).

### Why

- `packages/coding-agent/src/core/extensions/loader.ts`: the builtin `relocate-session` extension's tools need the session's relocation host through the public API.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/loader.ts`: `pi.session` is built here; the loader is the only place that creates it.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/loader.ts`: LOW: two methods appended after `persistHeaderNow` in the `session` block of the API object.

## 2026-10-23 - QuestionResponse.cancelOrigin (sisyphuslabs/omo-desktop-app#4042)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new `QuestionCancelOrigin` (`user`, `ui_failure`, `turn_abort`, `session_closed`, `ask_user_disabled`) and an optional `QuestionResponse.cancelOrigin`. A question UI sets `user` on a cancel the user chose; the ask-user builtin sets the rest. `showsPartialAnswers` in `builtin/ask-user/format.ts` is the one place that reads it: only `user` and `ui_failure` cancels show the model the answers given before the cancel.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: the lead rule for #4042 delivers partial answers for a cancel the user chose and keeps every lifecycle cancel (turn abort, session close, ask-user disabled, a closed RPC connection) silent. Only the surface that saw the cancel knows which it was, so the origin has to travel on the response.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: `QuestionResponse` is the contract between `ExtensionUIContext.question` implementations (TUI, RPC) and the ask-user builtin; neither side can add a field the other does not see.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/types.ts`, `QuestionResponse`.

## 2026-10-21 - Itemized sendMessage custody (senpi#3811)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `pi.sendMessage` accepts `options.items` (`SendMessageItem`: `itemId`, `producer`, optional `runRef`, `content`, `details`) and then returns `Promise<readonly SendMessageReceipt[] | undefined> | void` (`itemId`, `entryId`, `disposition: "notice_persisted" | "message_persisted"`, `noticeId?`; `undefined` from a host without item custody, `void` from an implementation that predates `items`, so a single-signature `sendMessage(...): void` implementation or test double of `Pick<ExtensionAPI, "sendMessage">` stays assignable); without items it still returns `void`. `ExtensionActions` gains the optional host action `sendItemizedMessage`.
- `packages/coding-agent/src/core/extensions/loader.ts`: routes an itemized send to that action and returns its receipts; a host without it delivers the batch plainly and answers no receipts.
- `packages/coding-agent/src/core/extensions/runner.ts`: binds `sendItemizedMessage`, admitting a triggered batch through the same `session_start` turn gate as a plain send and answering its receipts once it runs.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: design 4.5 makes item identity part of the engine protocol: omo's idle coordinator batches wakes and must record each one done only on its own receipt, and a batch a Stop holds must become one notice per item instead of one merged wake.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: only the engine decides at admission whether a hold applies and owns the notice ledger an item is stored in.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: the `sendMessage` overloads, `SendMessageHandler` and `ExtensionActions`. `packages/coding-agent/src/core/extensions/loader.ts`: the `sendMessage` action stub. `packages/coding-agent/src/core/extensions/runner.ts`: the `bindCore` action copies.

## 2026-10-21 - Pause state and run fences for extensions (senpi#3811)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext` gains optional `getPauseState()` (the session's hold records and pause seq) `fenceRun(runRef)` and `releaseRunFence(runRef)` (drops a cancelled run's fence); new `SessionHoldRecord` and the `session_hold_changed` event, fired when the session becomes paused or resumed (a user Stop, a parent's run pause, a release); a run fence alone does not pause the session, so adding or releasing only a fence fires nothing.
- `packages/coding-agent/src/core/extensions/runner.ts`: binds those context actions from the session and guards them with `assertActive()`.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: omo's runner pauses the workflow run a user Stop interrupted, so it must see the Stop and fence wakes tagged with that run, and release the fence when `workflow cancel` ends that run.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the extension context and event union are the engine's public extension API.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: the `ExtensionContext`/`ExtensionContextActions` members and the event union; the context-action binding in the runner.

## 2026-10-19 - session_move_export and session_move_import events (senpi#3676)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `SessionMoveExportEvent { moveId, dir }` and `SessionMoveImportEvent { moveId, dir }` join the session events, with their `on()` overloads.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitSessionMove(event)` runs the `session_move_export` or `session_move_import` handlers, each under the `session_shutdown` handler budget (warned at `warnMs`, its `signal` aborted at the cap), and returns every failure (a throw or a handler still running at the cap), each also reported as an extension error. A `move` release refuses on any export failure; the import hand-over keeps the moved state for the next open on any import failure (senpi#3681 review).
- `packages/coding-agent/src/core/extensions/types.ts`: both move events carry `signal: AbortSignal`, and `SessionMoveImportEvent` carries `redelivered: boolean` (senpi#3681 delta review).

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: extensions with per-session state outside the session folder need a contract to hand it to a move and get it back on the receiver.
- `packages/coding-agent/src/core/extensions/types.ts`: a handler past the cap keeps running; without the signal it cannot know to stop, and without `redelivered` an idempotent handler cannot cheaply tell a second delivery from the first.
- `packages/coding-agent/src/core/extensions/runner.ts`: the ordinary emit swallows handler errors, so one failed import would discard the only copy of the moved state, and an unbounded export handler could hold a `move` release (and, on its interrupt path, the session's closed admission) forever.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: these are new host lifecycle events; only the host knows when a session is sealed for a move or first opened after one.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/types.ts`, the session event union and the `on()` overload list; `packages/coding-agent/src/core/extensions/runner.ts`, one method before `dispatchEmit` and two type imports.

## 2026-10-22 - ProviderConfig.ownsAccountSelection (senpi#2081)

### What changed

- `types.ts`: optional `ownsAccountSelection` on `ProviderConfig`. A provider whose lane chooses among its own stored accounts sets it, and the generic credential pool then never wraps that provider.

### Why

senpi#2081: a lane that picks its own accounts, wrapped by the generic pool, had its verdicts pinned on outer slots it never used, and every slot ended up blocked.

### Why an extension could not handle it

The flag is the extension's way to tell the core pool not to wrap it; the core reads it.

### Expected merge conflict zones

- The tail of `ProviderConfig`, after `fallbackEligible`.

## 2026-10-22 - Expose lifecycle actions to extensions (senpi#3864)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: adds the optional `lifecycle` action (`LifecycleApi`).
- `packages/coding-agent/src/core/extensions/runner.ts`: binds the lifecycle action and resolves it at invocation.
- `packages/coding-agent/src/core/extensions/loader.ts`: gives loaded extensions the lifecycle API.
- `packages/coding-agent/src/core/extensions/index.ts`: exports the lifecycle API types.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: builtin task/goal extensions report child state and runs to the engine lifecycle.
- `packages/coding-agent/src/core/extensions/runner.ts`: a retired runner must not reach a replaced session.
- `packages/coding-agent/src/core/extensions/loader.ts`: extensions get the same action surface as builtins.
- `packages/coding-agent/src/core/extensions/index.ts`: extension authors type against them.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: this is the extension contract itself.
- `packages/coding-agent/src/core/extensions/runner.ts`: the runner owns action binding.
- `packages/coding-agent/src/core/extensions/loader.ts`: the loader builds the extension API object.
- `packages/coding-agent/src/core/extensions/index.ts`: public barrel.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionActions`.
- `packages/coding-agent/src/core/extensions/runner.ts`: runtime action binding in `initialize`.
- `packages/coding-agent/src/core/extensions/loader.ts`: API object construction.
- `packages/coding-agent/src/core/extensions/index.ts`: type exports.

## 2026-10-21 - Resolve lifecycle actions after extension initialization (senpi#3864)

### What changed

`packages/coding-agent/src/core/extensions/loader.ts` exposes a lazy lifecycle facade. Reading or spreading the extension API during factory initialization does not require a bound session; invoking lifecycle actions still resolves and checks the current runtime.

### Why

`packages/coding-agent/src/core/extensions/loader.ts`: the eager lifecycle getter threw while existing extension factories spread `pi` to wrap other actions, before session binding was possible.

### Why an extension could not handle it

`packages/coding-agent/src/core/extensions/loader.ts`: the loader owns the shared API object and its binding lifecycle.

### Expected merge conflict zones

`packages/coding-agent/src/core/extensions/loader.ts`: the lifecycle member of `createExtensionAPI`.

## 2026-10-21 - Question options say how the answer is delivered (senpi#3864)

### What changed

`packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIContext.question` options gain `deliver?: "tool-result" | "user-message"`. ask-user passes `user-message` for an async question and for a question resumed after a restart, `tool-result` otherwise.

### Why

A `user-message` answer is reported as a person's input when ask-user delivers it (the question-input release). The RPC adapter reports a validated answer too, so without this signal an async or resumed answer over `extension_ui_response` counted twice.

### Why an extension could not handle it

The UI adapter that validates the answer is core RPC and only sees the question options.

### Expected merge conflict zones

The `question?` member of `ExtensionUIContext` in `packages/coding-agent/src/core/extensions/types.ts`.

## 2026-10-21 - A person's answer keeps its origin through the session_start gate (senpi#3917)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: the runner owns the person-answer token. `questionInput` sets it, and `runtime.sendUserMessage` takes it at ADMISSION (when the extension calls it) and passes the origin with the action through the `session_start` turn gate.
- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionActions.sendUserMessage` (internal, not the public `SendUserMessageHandler`) takes an optional `inputOrigin`.

### Why

- `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`: the session-held token was cleared by a microtask before the gate drained, so an answer delivered during `session_start` ran as `extension` (review of senpi#3860, r5 LOW-1).

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`: origin is an engine-owned classification; extensions must not be able to assert a person origin through the public API.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/core/extensions/runner.ts`, `runtime.sendUserMessage` in `initialize` and the `bindQuestionInput` closure in `createContext`; `packages/coding-agent/src/core/extensions/types.ts`, `ExtensionActions.sendUserMessage`.

## 2026-10-21 - Deterministic discovered extension registration (omo#10775)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts` sorts directory entries by name before discovering extension entrypoints. Explicit configured path and package-manifest order remain intact.

### Why

- Filesystem enumeration order must not decide the registration order of prompt-contributing handlers.

### Why an extension could not handle it

- Discovery runs before extension handlers are registered.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/loader.ts`: LOW, `discoverExtensionsInDir`, immediately after the directory read.

## 2026-10-21 - Preserve human-answer delivery while releasing holds (senpi#3853)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`: the context-keyed question capability only establishes attendance and releases hold custody; answers still use the existing `pi.sendUserMessage` path and extension input source.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts`: signal human attendance before delivering an answer through the current extension API, including after reload.

### Why

- `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`: replacing answer delivery bypassed replacement-runner observers and invoked interactive-only hooks in attended sessions.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/runner.ts`, `packages/coding-agent/src/core/extensions/types.ts`: context capability identity and hold admission are engine-owned; extensions retain their established message delivery API.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: context binding. `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContextActions.questionInput`.

## 2026-10-21 - Bind lifecycle custody and child reporting (senpi#3864)

### What changed

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts` and `packages/coding-agent/src/core/extensions/index.ts` expose `pi.lifecycle.obligations`, generation-fenced `reportChild`, `markRunCompleted` and the `sendMessage` ticket option. The runner's existing UI-prompt tracker supplies stable TUI attention identity and lifecycle open/close notifications.

### Why

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts` and `packages/coding-agent/src/core/extensions/index.ts`: producers must transfer custody before sending a result, and the engine must fold the runner's current child state without relying on a client UI.

### Why an extension could not handle it

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/runner.ts` and `packages/coding-agent/src/core/extensions/index.ts`: the extension facade, native delivery boundary and TUI request tracker are core bindings.

### Expected merge conflict zones

`packages/coding-agent/src/core/extensions/types.ts`: ExtensionAPI, ExtensionActions and sendMessage options. `packages/coding-agent/src/core/extensions/loader.ts`: runtime facade. `packages/coding-agent/src/core/extensions/runner.ts`: bindCore and withUIPrompt. `packages/coding-agent/src/core/extensions/index.ts`: public type exports.

## 2026-10-21 - Expose held-wake source admission and release (senpi#3853)

### What changed

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: Adds optional engineTurnsHeld()/noteHeldWake(source) context actions and held_wakes_released { sources }; contexts also receive the internal question-input capability without exposing human-origin assertions on sendUserMessage.

### Why

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: Goal continuations must check the hold before charging or rendering, then revalidate current state after release.

### Why an extension could not handle it

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: The context and event contracts and their core bindings are upstream runtime surfaces.

### Expected merge conflict zones

`packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts`: ExtensionContext, ExtensionContextActions, SessionEvent, event overloads, bindCore, createContext, and emit helpers.

## 2026-10-19 - Tool barrier extension API and `workspaceEffect` (senpi#3717)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolDefinition.workspaceEffect?: "read" | "write"`; `ExtensionAPI.armToolBarrier(spec)` / `releaseToolBarrier(id)`; optional `ExtensionActions.armToolBarrier` / `releaseToolBarrier`.
- `packages/coding-agent/src/core/extensions/loader.ts`: the `pi.armToolBarrier` / `pi.releaseToolBarrier` methods (arming throws on a runtime bound without the action; releasing answers false).
- `packages/coding-agent/src/core/extensions/runner.ts`: `bindCore` copies the two optional actions into the runtime.

### Why

A client that captures a pre-turn workspace checkpoint had to finish the capture before sending the prompt, because a write tool could run before it was ready; that capture sat on the send-to-first-request path. A session tool barrier lets the prompt go out at once while workspace-changing tools wait for the client's release.

### Why an extension could not handle it

This is the public extension contract itself: the classification field and the arm/release methods have to exist on `ToolDefinition` and `ExtensionAPI`.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolDefinition` after `annotations`, `ExtensionAPI` after `getActiveTools`, the end of `ExtensionActions`.
- `packages/coding-agent/src/core/extensions/loader.ts`: the API object after `getActiveTools`.
- `packages/coding-agent/src/core/extensions/runner.ts`: the optional-action lines after `sessionControl` in `bindCore`.

## 2026-10-19 - Suggest a fresh session with a handoff when a large session's cache has expired (senpi#3230)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionWidgetOptions` gains `actions?: readonly ExtensionWidgetAction[]` (`{ label, command }`), choices offered with a string-array widget. `command` is ordinary slash-command text.

### Why

The handoff hint offers two choices on one line. The TUI and every RPC client must reach the same command handler, so the choice is carried as the command text itself rather than a host-specific callback (one implementation, no RPC-only path).

### Why an extension could not handle it

The widget options type is the public extension contract; an extension cannot add a field the hosts read.

### Expected merge conflict zones

- LOW: `types.ts` `ExtensionWidgetOptions`, next to `WidgetPlacement`.

## 2026-10-19 - A tool's job on the tool child: per-call placement, wakes and child exits (senpi#3740)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolDefinition.childJob` (`ToolChildJob`: the built-in job `kind`, its `args`, an optional `result` rewrite with the generation it ran on, `placement(params)` - `server`, `child` or `both` per call - `wake(value, generation)` for what the child reports later, and `childExited(generation)`).

### Why

The terminal tools run on the session's tool child, but a call naming a server-owned session (a monitor) must stay on the server, and the child's background sessions report their exit after the job that started them ended.

### Why an extension could not handle it

Placement and the tool child's channel are owned by the session's dispatcher; a tool can only declare them on its definition.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolChildJob` before `ToolChildModule`, and `childJob` on `ToolDefinition`.

## 2026-10-18 - registerChildModule and ctx.offload (senpi#3566 todo 8)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ChildModuleRegistration`, `RegisteredChildModule`, `OffloadOptions`; `ExtensionAPI.registerChildModule`; optional `ExtensionContext.offload` (optional only so contexts built outside a runner still type-check; every runner-built context has it); `Extension.childModules`; `ExtensionContextActions.offload`.
- `packages/coding-agent/src/core/extensions/loader.ts`: `registerChildModule` validates a file-backed registration (an inline function or empty field throws `offload_bad_registration`) and records it with the registering extension's source.
- `packages/coding-agent/src/core/extensions/types.ts` docs: a module's export receives `(args, host)` on both runtimes; `OffloadOptions.deadlineMs` must be finite and above 0 (senpi#3622 review).
- `packages/coding-agent/src/core/extensions/runner.ts`: `getAllChildModules()` (a later id wins, and a replacement from another extension file is logged once) and the context's `offload`, which delegates to the session's action and fails `offload_unavailable` where no session backs the runner.

### Why

The plan's offload API: an extension names a module file once and runs it where the session's runtime places work, on the tool child or in-process.

### Why an extension could not handle it

Registration and the context are the extension API itself.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: the new interfaces before `ToolDefinition`, the `ExtensionContext` head, `registerChildModule` beside `registerFilesystemPolicy`, `Extension.childModules`, and `ExtensionContextActions`'s head.
- `packages/coding-agent/src/core/extensions/loader.ts`: `registerChildModule` beside `registerFilesystemPolicy` and the types import.
- `packages/coding-agent/src/core/extensions/runner.ts`: `getAllChildModules` beside `getAllRegisteredTools`, the `offload` member of `createContext`, and `offloadFn`.

## 2026-10-19 - Quit budget start, stated precisely (senpi#3711 follow-up)

### What changed

- `packages/coding-agent/src/core/extensions/shutdown-quit-budget.ts`: the `QuitDeadline` comment says the budget counts from the moment the shutdown emission is armed. The entry below says "the quit request time"; `armProcessExitBudget()` actually runs inside `emitSessionShutdownEvent`, so the steps a quit takes before the handlers (stopping the TUI, draining input, closing the control endpoint) are not counted. No behavior change.

### Why

- Review LOW on #3713: the docs and this tracker overstated where the budget starts.

### Why an extension could not handle it

- Documentation of the runner's own budget.

### Expected merge conflict zones

- LOW: the `QuitDeadline` doc comment in `shutdown-quit-budget.ts`.

## 2026-10-19 - One total budget for quit-time session_shutdown handlers (senpi#3711)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `resolveSessionShutdownBudget` also reads `sessionShutdownQuitBudgetMs`. `emitSessionShutdownEvent` takes `{ processExit }` and, for a quit that ends the process, calls the new `armProcessExitBudget()`, which records the quit request time. For such a quit, `dispatchEmit` starts one `QuitDeadline` from that time and gives each handler its own cap shortened to what remains of it. A handler cut by that deadline is logged once with `console.warn` (extension path and elapsed ms only) instead of an extension error; the per-handler cap still reports an error as before. Reload, new, resume, fork and an RPC host closing one session (a quit that does not exit) are unchanged.
- `packages/coding-agent/src/core/extensions/shutdown-quit-budget.ts` (new): `QuitDeadline`, `SessionShutdownBudget`, `QuitHandlerBudget`.

### Why

- An idle quit took about 10 s (senpi#3711): one handler ran until the 10 s per-handler cap and quit waited on it. Several slow handlers could stack their caps. When the process exits right after shutdown, waiting longer than a short total only delays the exit. A quit on an RPC host that keeps running is excluded: there a detached handler would keep running while its extension's handles and provider scope are closed.

### Why an extension could not handle it

- The runner owns how long the host waits on each `session_shutdown` handler; an extension cannot bound the others.

### Expected merge conflict zones

- MEDIUM: `runner.ts` `emitSessionShutdownEvent`, `armProcessExitBudget`, `resolveSessionShutdownBudget`, `runSessionShutdownHandler` and the `session_shutdown` branch of `dispatchEmit`; the settings and `shutdown-quit-budget.ts` imports.

## 2026-10-19 - Closing a session closes what its extension code left open (senpi#2292)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts`: every callback an extension registers (`pi.on` handlers, tool `execute`, commands, shortcuts, `pi.rpc.handle` handlers) and the factory call itself run through `ownedBy` / `runOwnedBy`, which enter that extension instance's handle ledger for the call's async chain. Tool definitions are stored as a copy whose `execute` is the owned wrapper. Builtin extensions are passed through unchanged.
- `packages/coding-agent/src/core/extensions/runner.ts`: the constructor registers its extension instances with the handle ledger, and `emitSessionShutdownEvent` calls `reclaimRunnerHandles(runner)` after the `session_shutdown` handlers ran, and also when no extension registered one. A runner the ledger never saw (a test double) reclaims nothing.
- `packages/coding-agent/src/core/extensions/extension-handle-tracking.ts` (new): process-level hooks on `setTimeout`/`setInterval`/`clear*`, `Bun.serve`, `Bun.listen`, `net.Server.prototype.listen` and `net.Socket.prototype.connect`, installed on first use. A handle is recorded only when an owner is in the async context AND the creating stack frame is that extension's code.
- `packages/coding-agent/src/core/extensions/extension-handle-ledger.ts` (new): the per-extension ledger, the ownership test (a file extension owns its package directory, or only its entry file when no `package.json` sits beside it, never senpi's own packages; Bun's `senpi-extension:` module frames are decoded to the file; inline factories and builtins, including bundled extensions relabelled builtin after loading, are not tracked), and the reclaim with its per-extension stderr line.

### Why

On the in-process `--listen` host an extension that never stopped a server it opened from a session kept the server and the memory it referenced until the host exited: measured 17 MB and one listening socket per closed session, linear over 30 sessions (senpi#2292). Q chose to have senpi track and close those handles rather than only document the contract.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/loader.ts`: the loader is where extension callbacks are registered; only it can enter the extension's ownership around every call into extension code.
- `packages/coding-agent/src/core/extensions/runner.ts`: the reclaim must run after every extension's `session_shutdown` handler, on the one teardown path the runner owns; a leaking extension is by definition the one that does not clean up after itself.

### Expected merge conflict zones

- LOW: `loader.ts` `createExtensionAPI` (`on`, `registerTool`, `registerCommand`, `registerShortcut`, `rpc.handle`) and the factory call in `initializeExtension`.
- LOW: `runner.ts` `emitSessionShutdownEvent` body and one line in the `ExtensionRunner` constructor.

## 2026-10-19 - Extension importer reuses prepared module source across host starts (senpi#3716)

### What changed

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: `createBunExtensionImporter(virtualModules, builtinRedirects, { preparedCache: { dir, release } })` prepares each module with a generation token in place of the generation, stores the result in a disk cache (`bun-extension-prepared-cache.ts`), and on a later start reuses it after re-resolving every static import edge and re-checking the package `type`. The entry key covers the senpi release (passed by the loader), the Bun version, the runtime module path, the extension namespace and the source of the code that shapes the bytes (the importer, the CommonJS import rewrite and clause parser, the whole strict-directive module via `strictDirectiveModuleSource`, the lexer entry); the lexer package itself changes only with a release, which `release` covers; the token is then replaced with the live generation. The strict-directive helpers moved unchanged to `bun-extension-strict-directive.ts`.
- `packages/coding-agent/src/core/extensions/loader.ts`: the session loader passes `preparedCache: { dir: <agentDir>/cache/extension-modules, release: VERSION }`. The tool child's module-job importer passes none and behaves as before.

### Why

Every new host transpiled and rewrote the whole extension graph again (about 700 modules for the OmO plugin, 2.6 MB in its two largest files). A desktop thread starts its own host, so this sat on the path from "New thread" to the first model request.

### Why an extension could not handle it

The importer is the core loader that evaluates extensions; an extension cannot change how itself is loaded.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: fork-only file; the `load()` body and the new `prepare` closure.
- `packages/coding-agent/src/core/extensions/loader.ts`: LOW, the `createBunExtensionImporter(...)` call in `createExtensionModuleImporter`.

## 2026-10-19 - pi.getSubscriptionLimits() and pi.onSubscriptionLimits() (senpi#3684)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI` gains `getSubscriptionLimits(): readonly AccountLimits[]` and `onSubscriptionLimits(listener): () => void`.
- `packages/coding-agent/src/core/extensions/loader.ts`: both read the process's `subscriptionLimits` store, the one `get_subscription_limits` serves.

### Why

The OmO TUI side panel polled the usage endpoints itself. With the engine polling, an extension reads the same records the desktop gets, and the second poller goes away.

### Why an extension could not handle it

The store is core state; an extension has no other path to it.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: LOW, after `getPermissionPreset()` and the import block.
- `packages/coding-agent/src/core/extensions/loader.ts`: LOW, after `getPermissionPreset()` in the API object and the import block.

## 2026-10-19 - pi.redactForUpload() and pi.hostVersion (senpi#3674)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI` gains `redactForUpload(text, { extraLiterals? }) -> { text, counts }` and `readonly hostVersion`.
- `packages/coding-agent/src/core/extensions/loader.ts`: implements both; `redactForUpload` calls `core/share/upload-redaction.ts`, which is the `/share` redactor (`redactShareText`) with this machine's identity, and `hostVersion` is `VERSION`.
- `packages/coding-agent/src/core/share/share-redaction.ts`: the context takes `extraLiterals`, and the literal pass (which runs last) no longer rewrites placeholders earlier passes wrote, so a literal such as `redacted` or `email` cannot corrupt `<redacted>` or `<email>`.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: features that send text off the machine (the OmO in-app bug report, code-yeongyu/oh-my-openagent#10543) need the same redactor `/share` uses; there must be exactly one set of rules, not a copy inside each extension.
- `packages/coding-agent/src/core/extensions/loader.ts`: the reporting extension also needs the engine version for the report's environment block.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the redactor lives in core (`core/share/`) and is not exported; an extension can only reach it through the API object, and a copied redactor would drift from `/share`.
- `packages/coding-agent/src/core/extensions/loader.ts`: the API object is built here.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: LOW, the `ExtensionAPI` member list after `exec`.
- `packages/coding-agent/src/core/extensions/loader.ts`: LOW, the API object after `exec`, plus the config import.

## 2026-10-18 - ToolDefinition placement metadata and dispatcher-routed extension tools (senpi#3566)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolDefinition` gains `placement?: ToolPlacement` (`"server" | "child"`, default server; a child-placed tool under `--tool-runtime child` fails with `tool_runtime_unavailable` until the tool child lands, never silently running in-process) and `serverPinned?: boolean` (set by built-in tool factories whose definition captures injected `operations` or a filesystem-policy override; the dispatcher pins such tools to the server even when `placement` is `"child"` and logs one notice per tool).
- `packages/coding-agent/src/core/extensions/wrapper.ts`: `wrapRegisteredTool`/`wrapRegisteredTools` take an optional `ToolDispatcher` and route execution through `dispatcher.run({ definition, toolCallId, params, signal, onUpdate, ctx })` with the runner-built context; without a dispatcher the call is unchanged. The active-tool diff (`addedToolNames`) still merges after execution in the wrapper.

### Why

The per-session tool dispatcher (senpi#3566) needs every registered tool call - builtin, extension, and SDK - to cross one seam, and extension tools need an opt-in to run in the session's tool child once it exists.

### Why an extension could not handle it

The wrapper adapts extension tools into core `AgentTool`s and the dispatcher is session-owned runtime state.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: the `ToolDefinition` property list around `namespace`/`annotations` and the `execute` signature.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: `wrapRegisteredTool`'s execute override.

## 2026-10-18 - Extension child_process resolves to a per-process module (senpi#3566)

### What changed

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: `createBunExtensionImporter(virtualModules, builtinRedirects = {})` resolves a specifier that is an own key of `builtinRedirects` to the mapped id before the builtin check (own keys only: a package named after an `Object.prototype` key such as `constructor` resolves as before, so the default path's empty map changes nothing), in every module the extension graph transpiles (transitive dependencies included) and for `require`.
- The session's own extension loader does not use the redirect: on the default in-process path every extension gets the real `node:child_process`, unchanged. Only the tool child's module-job worker builds an importer with `CHILD_PROCESS_REDIRECTS` and the gated module.

### Why

The per-session tool child must not start any process before the server has recorded its containment. Bun ignores `syncBuiltinESMExports`, refuses `Bun.plugin` overrides of builtins and never calls `onResolve` for them, so a named `import { spawnSync } from "node:child_process"` in extension code could not be gated any other way.

### Why an extension could not handle it

The rewrite has to happen where the importer resolves every extension module's specifiers, before any extension code runs.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: the `createBunExtensionImporter` signature and the start of `resolveTarget`.

## 2026-10-18 - ToolDefinition.childModule: a child-placed tool's file-backed body (senpi#3566)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ToolDefinition` gains `childModule?: ToolChildModule` (`{ path, export }`, new exported interface). `path` is absolute or relative to the registering extension file and must stay inside that extension's directory; `export` names a function that receives `{ params, toolCallId }` and returns a structured-cloneable tool result. Under `--tool-runtime child` a `"child"`-placed tool with a `childModule` runs that body as the tool child's `module` job; without one it still reports `tool_runtime_unavailable`. `execute` is unchanged and still runs in-process under the default runtime.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: `wrapRegisteredTool` passes `sourcePath: registeredTool.sourceInfo.path` to `dispatcher.run`, so a relative `childModule.path` resolves against the extension's directory.

### Why

The tool child cannot load the extension loader (it statically reaches every session writer), so a child-placed tool needs a file reference the child can import on its own. The same `{ modulePath, export, args }` job shape is what `ctx.offload` builds on.

### Why an extension could not handle it

Where a tool runs is decided by the session's dispatcher, and the extension's source path is known only to the loader and the wrapper.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: the `ToolDefinition` property list beside `placement`/`serverPinned`, and the new `ToolChildModule` interface just above `ToolDefinition`.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: the `dispatcher.run` call in `wrapRegisteredTool`.

## 2026-10-18 - Agent lifecycle and boundary event handlers run under a host budget (senpi#3650)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: handlers of the agent lifecycle events the session awaits on its event queue (`agent_start`, `agent_end`, `agent_settled`, `turn_start`, `message_start`, `message_update`, `message_end`, `tool_execution_*`) and of the boundary events (`turn_end`, `agent_before_settle` through `emitBoundary`) run under a host budget set with `setEventHandlerBudget(budget, onStall, turnScope)`. The budget is resolved once per emission, before any handler starts; an invalid setting is reported once and the defaults apply, as for `session_shutdown`. Past the warning the stall listener hears it; at the hard cap, or when the turn deadline calls `releaseHeldHandlers(turn)` for the turn that owns the wait, the host reports an extension error (`handler timed out after Nms` / `handler released by the turn deadline`) and moves to the next handler; the handler keeps running detached, its late result is discarded, and a late failure is reported as a stall stage. Lifecycle events and `message_end` dispatch through non-async `dispatchLifecycle` / `emitMessageEnd`, so a timely handler is awaited exactly as before. `session_shutdown` keeps its own budget and messages.
- `packages/coding-agent/src/core/extensions/handler-budget.ts` (new): `runBudgetedHandler` (the `session_shutdown` path, with the abort signal), `runBudgetedSequence` (walks an emission's handlers with a plain `await` each and resumes after a stopped handler in a new run) and turn-scoped `HeldHandlerWaits`.

### Why

One lifecycle handler that never settled held the session's event queue forever (senpi#3650); only `session_shutdown` was host-bounded, and `turn_end` / `agent_before_settle` handlers hold the same queue.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/runner.ts`: the runner is the only place that awaits extension handlers; an extension cannot bound another extension's handler.

### Expected merge conflict zones

- MEDIUM: `runner.ts` `emit` (the lifecycle branch), `emitMessageEnd` and the `emitBoundary` handler loop (both now walk a `runBudgetedSequence`), `runSessionShutdownHandler` (body replaced by `runBudgetedHandler`), the `ExtensionRunner` field block and the methods after `onError`; the `flattenHandlers` / `entryAt` helpers after `snapshotEventHandlers`.

## 2026-10-16 - ProviderConfig declares ambient api-key auth (senpi#2327)

### What changed

`packages/coding-agent/src/core/extensions/types.ts`: the extension-facing `ProviderConfig` gains optional `ambientAuth` (`name`, `resolve({ ctx, signal })`), mirroring the composer input for providers that authenticate from a shared cloud credential chain (Google ADC, AWS env).

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: the `vertex-model-garden` builtin registers through `pi.registerProvider(name, config)`; without the field on the public type, no extension can declare the ambient credential source the composer now understands.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: it is the public type declaration of the provider registration contract; `pi.registerProvider` is typed here and extensions cannot widen it themselves.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: LOW, the `ProviderConfig` field list, beside `oauth` and `fallbackEligible`.

## 2026-10-14 - `AgentEndEvent.deadline` and the goal deadline-stop hold (senpi#3227)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: additive `AgentEndEvent.deadline = { kind: "inactivity" | "max_runtime", limitMs, elapsedMs }` on the turn the deadline lease stopped. No new `stopReason`; expressed as an abort so no consumer breaks.
- `packages/coding-agent/src/core/extensions/builtin/goal/monitor-continuation.ts`, `index.ts`, `reload-reengagement.ts`: a deadline stop is never auto-continued — `afterSystemAbort`, the scheduled/immediate continuation admission, the todo-owed backstop call, and reload re-engagement all hold off while `deadlineStopPendingSinceLastTurn` is pending, until admitted user input clears it. The goal stays `active`; the `deadline-stop` entry renders a "turn stopped on a deadline" notice ending in "Action: send a message to continue".

### Why

A turn ended on a deadline must not be re-prompted back to life by the goal engine; the user, not the engine, decides to resume.

### Why an extension could not handle it

The goal engine is the only owner of its continuation admission; the hold must gate `afterSystemAbort`, the timer fire, the backstop and reload re-engagement at their own call sites, and the `deadline` field belongs on the public `AgentEndEvent` contract every consumer already reads.

### Expected merge conflict zones

- HIGH: `types.ts` `AgentEndEvent` (public API contract).
- MEDIUM: `monitor-continuation.ts` `afterSystemAbort` and `#continueIfEligible`; `index.ts` the `agent_end` handler; `reload-reengagement.ts`.

## 2026-10-15 - pi.getPermissionPreset() (#3301, senpi#2465)

### What changed

`ExtensionAPI.getPermissionPreset(): PermissionPresetName | undefined` returns the preset the permission system enforces for this session now. The loader resolves it through the session's own `sessionManager` from `builtin/permission-system/preset-registry.ts`; before the host binds the runtime there is no session and it returns `undefined`.

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.getPermissionPreset()` declared beside `getFlag`.
- `packages/coding-agent/src/core/extensions/loader.ts`: `getPermissionPreset()` reads the bound session's preset from the permission-system registry.

### Why

Clients (the desktop's Full-access UI) must show the preset actually enforced, including a settings-only Full access and the `full-access` default, not just the flag.

### Why an extension could not handle it

The value lives inside the permission-system builtin, and another extension can only reach it through the public `pi` object. Adding a member to `ExtensionAPI` that every loaded extension's `pi` carries is the loader's job; no extension can extend another extension's API object.

### Expected merge conflict zones

`types.ts` (the Flags block of `ExtensionAPI`) and `loader.ts` (beside `getFlag`).

## 2026-10-15 - The stale guard throws a branded StaleExtensionContextError (senpi#3389)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts` and `packages/coding-agent/src/core/extensions/loader.ts`: `assertActive` throws `StaleExtensionContextError` (fork-only `stale-context-error.ts`, a plain `Error` subclass with the same message) instead of `Error`. `isStaleExtensionContextError` accepts the class first and still matches the two messages.

### Why

- Process-level containment of a retired ctx (senpi#3389) must match the guard exactly, not by message text another error could carry.

### Why an extension could not handle it

- The guard is the runner and loader themselves.

### Expected merge conflict zones

- LOW: the `throw` in each `assertActive` and one import line per file.

## 2026-10-14 - `pi.appendEntry` takes `{ startupBookkeeping }` (senpi#3263)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.appendEntry` and `AppendEntryHandler` take an optional third argument, `AppendEntryOptions` with `startupBookkeeping?: boolean`. Existing two-argument calls are unchanged.
- `packages/coding-agent/src/core/extensions/loader.ts`: the extension API wrapper forwards the options argument to the runtime action.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: a session closed without a conversation should leave no file, but only the extension that wrote a `custom` entry knows whether it is disposable startup bookkeeping or user-created or billed state (senpi#3263). The default stays "keep the file".
- `packages/coding-agent/src/core/extensions/loader.ts`: the option has to cross the loader's API wrapper to reach the session.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the `pi.appendEntry` signature is the public extension contract itself.
- `packages/coding-agent/src/core/extensions/loader.ts`: the API wrapper that every extension calls is built by the loader.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: LOW, the `appendEntry` declaration in `ExtensionAPI` and the `AppendEntryHandler` type.
- `packages/coding-agent/src/core/extensions/loader.ts`: LOW, the `appendEntry` wrapper and the `./types.ts` import list.

## 2026-10-12 - Retire Codex app-server compatibility (senpi#3167)

### What changed

Remove app-server from the executable ExtensionMode contract. TUI, RPC, JSON and print remain supported.

- `packages/coding-agent/src/core/extensions/types.ts`

### Why

The executable Codex compatibility layer is being removed. Shared Native runtime behavior and historical records must remain independent of that layer.

### Why an extension could not handle it

These host contracts, import paths and build or verification targets belong to the repository; an extension cannot retire them.

### Expected merge conflict zones

The listed paths, especially command dispatch, mode unions and process identity imports. Keep the supported runtime branches and the shared utility behavior.

## 2026-10-11 - Typed missing extension RPC handler (senpi#3072 review)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: missing registered RPC handlers throw `ExtensionRpcRequestNotFoundError` with the existing message. The transport distinguishes unavailable eval controls from unknown cell IDs without matching prose.

### Why

The session may deliberately load no codemode extension; clients need a typed unavailable response on both named controls and extension-request aliases.

### Why an extension could not handle it

A handler that was not loaded cannot return an error; the runner owns handler discovery.

### Expected merge conflict zones

- The zero-handler branch of `ExtensionRunner.requestRpc`.

## 2026-10-11 - Host-authenticated user activity subscription (senpi#3140)

### What changed

- `packages/coding-agent/src/core/extensions/user-activity.ts`: creates a session-owned activity source and distinguishes `"draft"` from `"prompt"`. A borrowed UI receiver without a session or its publisher method is a no-op.
- `packages/coding-agent/src/core/extensions/types.ts`: adds optional subscription-only `onUserActivity` to the extension context and its host bindings.
- `packages/coding-agent/src/core/extensions/runner.ts`: binds the host subscriber, tracks its disposal with the extension generation, and reports listener errors without throwing out of the input path.

### Why

- Cache prewarm needs to distinguish actual composer activity from session lifecycle and prompt admission, without importing TUI or RPC implementation classes.

### Why an extension could not handle it

- Only the host knows whether composer text came from a user edit or restoration and when a submitted prompt entered admission. An open event bus is not authoritative: extensions could forge activity on it.

### Expected merge conflict zones

- `types.ts`: context/action subscription signatures; `runner.ts`: context binding and construction; new activity-source module. No change to the typed lifecycle event union.

## 2026-10-11 - Request-local search exclusion and canonical fallback (senpi#3122 review)

### What changed

- `runner.ts` / `types.ts`: request projections disable search by default; optional `allowServerSearch` preserves the keepalive prefix.
- Native Messages/Responses injectors consult session/model failure memory before stripping function declarations and use the effective request model. All unverified routes require explicit opt-in; the live-verified ChatGPT subscription remains default-on.
- `builtin/server-search-fallback.ts` owns non-serialized request metadata and a weakly session-owned failed-model set, preserving adapter-built schemas on fallback.

### Why

- Fallback must not rebuild raw parameter schemas or retry an already rejected native tool on every new prompt.

### Why an extension could not handle it

- The existing native and standalone extensions share the request boundary and session identity.

### Expected merge conflict zones

- Request preparation, native capability predicates, and fallback metadata.

## 2026-10-11 - Native server web search first (senpi#3122)

### What changed

- `builtin/openai-web-search/index.ts` handles first-party Codex Responses as well as API-key Responses, chooses the current `web_search` type for Codex/xAI, and preserves the explicit capability opt-in for compatible routes.
- `builtin/anthropic-web-search/index.ts` documents the exact search-and-encrypted-replay meaning of `supportsWebSearch`, with ccapi's verified contract requiring an explicit model/provider flag.
- `builtin/websearch/` owns one bounded standalone continuation after search-specific errors and additional provider-native shapes; see its local ledger.

### Why

- Requested by @code-yeongyu: use the session model's in-turn server tool before any auxiliary search-model request.

### Why an extension could not handle it

- This is the coordinated behavior of the existing built-in search extensions, using existing provider-request and settled-agent hooks without changing the extension API.

### Expected merge conflict zones

- The native injector capability predicates and the standalone extension's event registrations.

## 2026-10-10 - Identify prepared context projections (senpi#900)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts` labels context events from `prepareProviderRequest` as projections; normal agent dispatch is labeled separately. The unchanged two-phase transformation, cloning, snapshot, and system-message restoration logic now lives in `packages/coding-agent/src/core/extensions/context-dispatch.ts`.
- `packages/coding-agent/src/core/extensions/types.ts` re-exports `ContextEvent` from `packages/coding-agent/src/core/extensions/context-event.ts` with an optional read-only `source` marker. `packages/coding-agent/docs/extensions.md` documents its ownership meaning.

### Why

- A real agent request can reach the context hook before its current user message reaches the session journal. Comparing those lists misclassifies the live request; a prepared projection can also exactly match the journal.

### Why an extension could not handle it

- Only the host dispatcher knows whether it is preparing a separate projection or handling the agent's request. The compaction extension uses that provenance to keep projections on scratch state.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitContext` delegation and `prepareProviderRequest` origin argument. `packages/coding-agent/src/core/extensions/types.ts`: the `ContextEvent` type re-export.

## 2026-10-11 - Retired runners stand down when the first boundary preview fails (senpi#3101)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBoundary` runs its first `buildContext` under the same lease check as every later step. A rejection after the runner retired returns the shared `retired()` result instead of propagating; an active runner still propagates it unchanged. `retired()` is defined before that first build and reports an empty preview when no build completed.

### Why

- A session replaced or reloaded while the initial boundary preview was being built made `emitBoundary` reject on a retired runner, so its callers could still surface a stale-context error, the symptom senpi#2785 removed from every other boundary path.

### Why an extension could not handle it

- The host dispatcher owns the runner lease and builds the preview before any handler runs. An extension cannot intercept that rejection before it reaches the session.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: the start of `emitBoundary` (the initial preview build and the `retired()` helper).

## 2026-10-10 - Retired runners stop boundary dispatch (senpi#2785)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBoundary` checks the active lease before each handler, after awaited handlers, in both the handler and boundary-rebuild failure paths, and before returning a valid result. A local `retired()` helper keeps the five stand-down results in sync.

### Why

- Session disposal or replacement during boundary preview or handler awaits let later obsolete handlers run on a context whose getters correctly reject the retired runner. Obsolete drafts and continuation could also survive retirement.
- A handler or rebuild that was already in flight when the runner retired then failed on that retired state, and the failure paths reported it, so the stale-context stack still reached the user through `emitError` even though the dispatch itself had already lost its lease.

### Why an extension could not handle it

- The host dispatcher owns the runner lease and invokes subsequent handlers. An extension cannot prevent another retired handler from being dispatched.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBoundary` dispatch and result validation. Context getter guards and intentional `session_shutdown` dispatch remain unchanged.

## 2026-10-10 - Reload validates the bytes actually compiled (senpi#3068)

### What changed

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: `compiledSources()` reports SHA-256 fingerprints captured from the exact source strings passed to the transpiler, including lazy imports.
- `packages/coding-agent/src/core/extensions/extension-module-cache.ts`: checks every importer-owned fingerprint before reusing a factory, retiring the whole generation when any source changes or disappears. It no longer assigns disk snapshots to already compiled dependencies.

### Why

- A command can import a dependency after its factory was cached, then that dependency can be edited before reload. Recording its fingerprint at reload time incorrectly blessed the old module with the new file's identity. Content hashes also detect equal-size edits with preserved timestamps, while unchanged reloads still reuse one generation.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts` owns the transpiler input; `packages/coding-agent/src/core/extensions/extension-module-cache.ts` decides whether the host reuses the compiled graph, before the extension factory runs.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts`: source bookkeeping and importer result.
- `packages/coding-agent/src/core/extensions/extension-module-cache.ts`: importer contract and freshness check.

## 2026-10-10 — Shared prompt-preset resolution contract (omo #9851)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/matchers.ts` (new): the model-id matchers and `extract*` helpers moved out of `presets.ts`, now exported. `presets.ts` re-imports them; behavior is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/prompt-preset/contract.ts` (new): a pure, settings-free `resolvePresetName({ providerID, modelID, name? })` replicating the auto-resolution branch, plus `PROMPT_PRESET_MODEL_CASES` (one representative id per auto-resolvable preset) and `AUTO_RESOLVED_PRESET_NAMES`.
- `packages/coding-agent/package.json`: new public `./prompt-presets` export subpath serving the contract.

### Why

The OmO plugin's per-model prompt routing (oh-my-openagent #9856) must resolve model ids to the same presets as the runtime. The resolution logic was internal to this package and not exported, so there was no shared source of truth to pin a cross-repo parity test against. The contract module is the single source of truth; `gpt-5` is a manual-only preset (no model matcher), so the auto-resolvable set intentionally excludes it.

### Why an extension could not handle it

The matchers and precedence live in the builtin prompt-preset extension's own resolution path; exporting them is a change to that module's public surface, not something a separate extension can provide.

### Expected merge conflict zones

The matcher/helper block that moved from `presets.ts` to `matchers.ts`, and the `exports` map in `package.json`.

## 2026-10-08 - A required question never tells the model to proceed without an answer (senpi#2949)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `QuestionRequest` gains optional `required?: boolean`.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/params.ts`: both tool schemas (`ask_user_question` and `request_user_input`) accept an optional `required` boolean.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/schema.ts`: `toCanonical` validates `required` and carries it on the request only when true.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/format.ts`: for a required question, every settlement without an answer (`timed_out`, `cancelled`, `orphaned-after-restart`, `unavailable`) renders "No answer: do not take the action it gates. Keep that action pending and end the turn." in both the tool result and the late-answer frame; a selection made before going idle is shown but labelled not an answer. Calls without the flag render exactly as before.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts`: passes `required` to both formatters; the same-turn re-ask guard uses the no-action text for a required question; the tool description says what `required` does in one clause.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/resume.ts`: a required question that cannot be restored after a restart keeps its flag, so its orphaned notice is the no-action text.
- `packages/coding-agent/src/core/extensions/builtin/hooks/index.ts`: the ask-user timeout Notification renders the required text for a required question, so it no longer says the agent continues on best judgment.

### Why

- An approval gate asked through the question tool had no "no answer means don't" mode: a timeout told the model to "continue the work to completion on your best judgment", and a real model weighed that harness text above the skill's "a timed-out answer is not approval" and took the gated action (senpi#2949).

### Why an extension could not handle it

- The result text of every settlement is produced by the builtin ask-user tool; another extension cannot change what this tool returns.

### Expected merge conflict zones

- LOW: `ask-user/format.ts` `formatBody` and its two exports, `ask-user/params.ts` both parameter objects, `ask-user/tool.ts` `result`/`deliverAnswer`/re-ask guard, `types.ts` `QuestionRequest`.

## 2026-10-08 - ExtensionRunner.emitBusEvent (senpi#2967)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBusEvent(channel, data)` publishes on the shared extension event bus, the counterpart of `onBusEvent`. The session uses it to announce `engine:turn-limit` when it refuses an engine-originated turn.

### Why

- The engine-wide turn bound (`src/core/engine-turn-limit.ts`) lives in the session, not in an extension, and hosts/extensions need an observable signal when it trips.

### Why an extension could not handle it

- The session owns the runner's bus; extensions emit through `pi.events`, which the session cannot reach.

### Expected merge conflict zones

- LOW: `runner.ts` next to `onBusEvent`.

## 2026-10-07 - Opt-in shared transcript for non-mutating context hooks (senpi#2525)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new `ContextHandlerOptions` with `mutatesMessages?: boolean`; the `context` and `context_with_system` `pi.on` overloads accept it; `Extension` gains `nonMutatingContextHandlers?: WeakSet<HandlerFn>`.
- `packages/coding-agent/src/core/extensions/loader.ts`: `pi.on("context" | "context_with_system", handler, { mutatesMessages: false })` records the handler on the extension.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitContext` skips the per-turn `cloneJsonValue` deep copy and shares the live transcript objects (a shallow array copy only) when every `context` and `context_with_system` handler about to run, honoring `excludeExtensionPath`, declared `mutatesMessages: false`. Any undeclared handler keeps the historical behavior: one deep clone up front. Each cloned message is marked transient, so the token estimators compute it directly instead of keying and caching an object that never repeats. Both phases' handler sets are snapshotted once at the start of the pass and used for the decision and both loops, so a handler registered while an earlier one runs joins from the next request and never sees the shared transcript in this one. Entry-id tagging is unchanged: originals resolve through the existing WeakMap, and messages derived by pipeline stages keep identity through `inheritSessionContextEntryId`.

### Why

senpi#2525: the per-turn deep clone of the whole context cost about 27% of a turn's run-loop time on a 10k-message uncompacted session. Handlers that only read or return new objects pay for isolation they never use; the declaration lets them share the transcript, while any undeclared handler forces the clone back on for everyone.

### Why an extension could not handle it

The clone decision is made by the runner before any handler runs; no extension API can observe or change how the host passes `event.messages`.

### Expected merge conflict zones

- `types.ts`: the `pi.on` overload block and the `Extension` handler-registry fields.
- `loader.ts`: the `on()` registration body.
- `runner.ts`: the `emitContext` prologue.

## 2026-10-07 - An extension's model switch names the extension (senpi#2870)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `SetModelHandler` takes an optional `ModelChangeOrigin` as its second argument.
- `packages/coding-agent/src/core/extensions/loader.ts`: `pi.setModel` and `pi.setSessionModel` pass `{ source: "extension", actor: extension.path }`, so the `model_change` entry names the extension that switched. The public API (`pi.setModel(model)`) is unchanged.
- `packages/coding-agent/src/core/extensions/builtin/compaction/switch-admission.ts`: a `PendingModelSwitch` carries the origin of the switch it holds.

### Why

senpi#2870: a switch made by an extension was indistinguishable from one made by the user.

### Why an extension could not handle it

The attribution is added by the loader around every extension's calls.

### Expected merge conflict zones

- `loader.ts`: the `setModel` and `setSessionModel` members of the extension API object.
- `types.ts`: `SetModelHandler`.

## 2026-10-03 - Session-scoped EvalHandleHost provide/read pair (codemode plan node 10)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.provideEvalHandleHost(host)` registers the session's `EvalHandleHost` (the capability declared in `eval-handle-host.ts`: `watch`/`result`/`send`/`cancel`/`output` fenced by owner session, id and `run_epoch`); `ExtensionContext.evalHandleHost` reads it back, optional and absent on runtimes without a provider; `ExtensionRuntimeState.evalHandleHost` is the per-runtime slot.
- `packages/coding-agent/src/core/extensions/loader.ts`: the API method stores the host on the extension runtime (last provider wins); `invalidate()` clears it so a replaced or reloaded session never reads a stale host.
- `packages/coding-agent/src/core/extensions/runner.ts`: `createContext` exposes the slot as the `evalHandleHost` getter beside `kernelTools`.
- `packages/coding-agent/src/index.ts` re-exports the capability types and `EvalHandleError`.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: the task/workpool owner (an extension) provides the capability and codemode (another extension) consumes it per session; the direction is the reverse of `kernelTools` (long-lived, provider-to-consumer), so a call-scoped AsyncLocalStorage does not fit, and a process-global registry would let every session's task extension register into one slot on a multi-session host.
- `packages/coding-agent/src/core/extensions/loader.ts` / `runner.ts`: the runtime is the only object both extensions of one session share, so it is the session-scoped carrier.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns `ExtensionAPI` and `ExtensionContext`; an extension cannot add a surface other extensions receive, and two extensions have no shared per-session object other than the runtime.

### Expected merge conflict zones

- `types.ts`: the `ExtensionContext` body after `kernelTools`, the `ExtensionAPI` tool-registration block after `registerRemovedToolHint`, and the tail of `ExtensionRuntimeState`; `loader.ts` `createExtensionAPI` beside `registerRemovedToolHint` and the `invalidate` closure; `runner.ts` `createContext` getters.

## 2026-10-02 - Extension memory reporters (senpi#2561)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.registerMemoryReporter(name, reporter)` and `MemoryReporter` (`() => Readonly<Record<string, number>>`); `Extension.memoryReporters` is optional for records built before it.
- `packages/coding-agent/src/core/extensions/loader.ts`: the API stores reporters per extension and refuses the report's reserved names.
- `packages/coding-agent/src/core/extensions/runner.ts`: `getMemoryReporters()` returns every extension's reporters in load order.

### Why

- Layers owned by extensions (task children, caches) must appear in the on-demand memory report; only the extension knows their size.

### Why an extension could not handle it

- The report is assembled by the host; an extension needs a registration surface to contribute to it.

### Expected merge conflict zones

- `types.ts` beside `registerMarkdownTransformer`; `loader.ts` `createExtensionAPI` and the extension record literal; `runner.ts` beside `getMarkdownTransformers`.

## 2026-10-02 - Ask-user answer provenance (senpi#2533)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `QuestionResponse.resolvedBy` identifies the answering surface; no-answer terminal outcomes omit it.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/notify.ts`: new bus event `ask-user:closed` (`ASK_USER_CLOSED_EVENT`, `AskUserClosedEvent { requestId, status, resolvedBy? }`, `emitAskUserClosed`). The existing `ask-user:settled` payload's `response` now carries `resolvedBy`; it still fires for the same outcomes (never for `cancelled`).
- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts`, `resume.ts`: `ask-user:closed` fires exactly once per question for every terminal outcome: answers, comments, timeouts, cancellation, unavailable UI, and orphaned restart recovery. Detaching the old UI on reload is not a terminal outcome and emits nothing.
- `packages/coding-agent/src/core/extensions/builtin/ask-user/pending.ts`, `format.ts`: submitted responses keep `resolvedBy`, and blocking tool result details carry it.
- `packages/coding-agent/docs/extensions.md`: documents both bus events and `resolvedBy`.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: integrations mirroring a question need to tell users where it was answered.
- `ask-user:closed`: `ask-user:settled` skips `cancelled`, so an extension never learned that a non-blocking question was cancelled; changing settled would have changed its existing listeners (the hooks builtin).

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: the answering host must provide provenance in the shared response type.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: QuestionResponse.
- Fork-only `builtin/ask-user/` files: the settle path in `tool.ts` `startQuestion`, the unavailable returns in `createAskUserTool`, and `settleUnrestorable` in `resume.ts`.

## 2026-10-01 - Extension load key (senpi#2509)

### What changed

- `packages/coding-agent/src/core/extensions/extension-load-key.ts` (new): `extensionLoadKey(api)` returns the opaque identity of the extension load that created an `ExtensionAPI`, the same object the host holds as that load's runtime.
- `packages/coding-agent/src/core/extensions/loader.ts`: `createExtensionAPI` records that key for every API it builds.

### Why

The tool-search builtin registers its service per extension load, and the session that binds that load adopts it, so no service is shared across sessions.

### Why an extension could not handle it

Only the loader knows which load created an API. The public `ExtensionAPI` is unchanged.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/loader.ts`: the import block and the end of `createExtensionAPI`.

## 2026-10-01 - Commands declare required arguments (senpi#2479)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: expose `RegisteredCommand.requiresArguments`; false submits on picker Enter, and when omitted a declared `argumentHint` makes Enter wait for input.

### Why

A usage hint cannot tell the picker whether bare invocation opens a menu or needs input, so optional-argument commands opt into first-Enter submission.

### Why an extension could not handle it

The host owns the public registration contract.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: RegisteredCommand metadata.

## 2026-09-29 - Explicit Astra Ultrafast request tier (senpi#2399)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: add `ultrafast` to the public ServiceTier type.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: extension contexts and provider registrations must describe the native tier.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts`: an extension cannot widen the host's public extension contract.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: ServiceTier union.

# Core Extensions Changes

## 2026-10-01 - `before_agent_start` distinguishes admitted deliveries (senpi#2424)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `BeforeAgentStartEvent.trigger` adds `"delivery"` for a turn started by an admitted `session_control_delivery`; `"prompt"` and `"extension"` retain their existing meanings.
- `packages/coding-agent/src/core/extensions/session-control-types.ts`: `isSessionControlDeliveryDetails` is the shared predicate for the full admission provenance (`delivery_id`, `source`, and `deliverAs`) consumed by the host and todotools.

### Why

- A session-control delivery is the target session's work request, while an extension bootstrap is not. The two paths previously shared `"extension"`, so an extension could not apply first-request policy correctly.

### Why an extension could not handle it

- The host emits `before_agent_start` and owns the public event discriminant; an extension can only consume the value it receives.

### Expected merge conflict zones

- `types.ts`: the `BeforeAgentStartEvent.trigger` union and its JSDoc.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): shared type roots (contract wave)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: What changed: adopted upstream ToolAnnotations/ToolNamespace/ToolLoadout, outputSchema/defaultActive/prepareLoadout, ExtensionToolContext nested executeTool, parentToolCallId, structuredContent, pi.on() unsubscribe return for every overload, provider_stream_event, context_with_system, agent_before_settle and TurnEndEvent boundary state, virtual models, split ProviderModelConfig, getSettings, InlineExtension replaceable/builtin. Kept fork: ToolExposure direct/search/eval (+ model-only/hidden; deferred/codemode accepted as aliases), search metadata, executeTool<TDetails> API and the single generic ExecuteToolOptions, registerMcpServer(name, McpServerDeclaration), lazy tool activators, removed-tool hints, RPC channel, before_agent_start preview shape, fork provider/runtime registration types. Excluded (D-2, D-5): unregisterMcpServer, getMcpServers, mcp_servers_change, McpServerConfig/McpServerRegistry, cache_warming_decision. Why: omo consumes the fork exposure literals, registerMcpServer, lazy activators and executeTool; upstream additions are adopted only where they do not duplicate a fork capability. Why an extension could not handle it: this file is the extension API contract itself. Expected merge conflict zones: imports, ToolExposure block and normalizeToolExposure, ToolDefinition exposure fields, on() overload list, ExtensionAPI MCP/virtual-model block, ProviderModelConfig, ToolInfo, ExtensionRuntimeState, ExtensionContextActions tail.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; the four shared type roots (plan D-24 contract wave, D-2, D-3, D-16).

### Why an extension could not handle it

They are the public type contracts every provider, the agent loop, extensions and RPC compile against; an extension consumes these types and cannot change them.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): extension loader, runner and wrappers

### What changed

- `packages/coding-agent/src/core/extensions/index.ts`: What changed: union of fork exports (`ExecuteTool*`, `ToolPermissionRequest`) and upstream exports (boundary/draft types, `ContextWithSystemEvent`, `ExtensionToolContext`, `ExtensionVirtualModel`, `ProviderStreamEvent`, `ToolAnnotations`, `ToolLoadout*`, `ToolNamespace`, ...); dropped auto-merged `CacheWarmingDecisionEvent(Result)` and `McpServersChangeEvent` (not in the A2 types). Every re-exported name was checked to exist in `types.ts`. Expected merge conflict zones: the `export type { ... } from "./types.ts"` list.
- `packages/coding-agent/src/core/extensions/loader.ts`: What changed: `pi.on()` returns an unsubscribe for every overload and registers a per-call wrapper (the `previewSafe` WeakSet now records the registered wrapper, which is what the runner dispatches and checks); `createExtensionRuntime()` adds `getSettings`, `pendingVirtualModelRegistrations`, `createContext`, `registerVirtualModel`/`unregisterVirtualModel`; `ExtensionAPI` adds `getSettings()`, `registerVirtualModel()`, `unregisterVirtualModel()`; `createExtension()` derives source/baseDir through `getSyntheticPathSource()`/`isSyntheticPath()` so both `<builtin:x>` and upstream `builtin:x` paths are synthetic; `LoadExtensionsResult.warnings` (upstream duplicate-runtime prevention, 8d897edaa6) is initialised and returned. Kept byte-identical: the static `VIRTUAL_MODULES` alias table (incl. `@code-yeongyu/senpi`), the static bundled imports it references, native Bun importer + `importNodeOnlyApi("jiti/static")` lazy jiti, reserved `tool_search` (builtin scoping), fork `registerMcpServer(name, McpServerDeclaration)` via `validateMcpServerDeclaration`, session control / rpc API, extension module cache. Why: upstream API additions omo and user extensions can call, without giving up the fork loader's single-generation module cache and bundled-name aliases (omo bundle-purity pins the alias set). Why an extension could not handle it: the loader builds the `pi` API object itself. Not adopted: `../mcp-servers.ts` (`McpServerRegistry`, `validateMcpServerConfig`, `unregisterMcpServer`, `getMcpServers`) (D-2); upstream lazy `getCreateJiti()`/`getVirtualModules()` wiring (the fork already defers jiti and keeps its alias table in this file). Per-ref git cache (f444ea5eaf) and the replaced-builtin warning (9d1a650352) live entirely in `package-manager.ts`/`resource-loader.ts` (L7a); the loader-side half of 8d897edaa6 is the `warnings` field above. Expected merge conflict zones: import block (bundled imports vs upstream lazy loaders, source-info helpers, virtual-models import), type import list, `on()` body, the API tail after `rpc` (upstream MCP + virtual model methods), `createExtensionModuleImporter` jiti options, `createExtension` head, `loadExtensionsInternal` locals. Upstream `BUILTIN_PATH_PREFIX`, `getSyntheticPathSource()`, `isSyntheticPath()` adopted beside the fork `system` scope; consumed by `loader.ts`.
- `packages/coding-agent/src/core/extensions/runner.ts`: What changed: adopted upstream `emitBoundary()` (turn_end / agent_before_settle boundary drafts, per-handler preview rebuild, invalid-preview reporting), `createToolContext(toolCallId, signal)` (nested `ctx.tools` / `ctx.executeTool()` backed by `ExtensionContextActions.executeTool` / `getCallableTools`), dispatch over per-dispatch handler snapshots (`snapshotEventHandlers`, so `pi.on()` unsubscribe and registration during a dispatch are safe), `context_with_system` second phase plus system-message restoration after `context` handlers (the filter and restore are skipped when the transcript has no system message, so a `context` handler's `event.messages` stays the list the request carries - fork context-clone contract), `structuredContent` on `tool_result`, fail-closed `user_bash` (invalid results and handler throws reject instead of falling through to local execution), virtual model registration flush and live `registerVirtualModel`/`unregisterVirtualModel`, `runtime.getSettings`, `runtime.createContext`, `ContextWithSystemEvent`/`TurnEndEvent`/`AgentBeforeSettleEvent` removed from the generic `emit()` union. Kept fork: tool-hook lifecycle observer and `nextToolHookRunIndex` pairing (PreToolUse/PostToolUse status), `uiPromptDepth`, `createContext(extensionPath)` per handler, `excludeExtensionPath` on `context`/`context_with_system`/`before_provider_request`, `SESSION_CONTEXT_ENTRY_ID` tagging via `cloneJsonValue`, `emitModelSelect` with live prompt options, the fork `before_agent_start` shape (`systemPrompt` string parameter, `preview`/`previewSafe`, abort `signal`, `trigger`, `{ messages?, systemPrompt? }` result), provider flush through `drainPendingProviderRegistrations`. `createToolContext` gained an optional third `baseContext` parameter so the host's per-invocation context (senpi `steeringSignal`, disposal) is the one the nested-call properties are defined on. Why: upstream nested tool calls, boundary drafts, virtual models and unsubscribe are required by the adopted session projection and extension API; the fork keeps its prompt-preview, hook-status and per-extension context semantics that omo and the fork builtins depend on. Why an extension could not handle it: the runner is the event dispatcher every extension goes through. Not adopted: `emitCacheWarmingDecision` / `CacheWarmingAction` (D-5), `reportUnhandledMcpServers` / `mcp_servers_change` listener / `reportedMcpServers` (D-2), upstream `normalizeBuildSystemPromptOptions` / `forceSystemPrompt` before_agent_start model (C-EX-9). Expected merge conflict zones: import block (pi-ai value import of `getCurrentSystemMessage`, system-prompt import), private field block after `getAgentDirFn`, `bindCore()` runtime copies and the provider/virtual-model flush, `createToolContext` signature, every `for ... of snapshotEventHandlers(...)` loop head in fork-modified emitters (`emitUserBash`, `emitContext`, `emitBeforeProviderRequest`, `emitBeforeProviderHeaders`, `emitBeforeAgentStart`), `emitModelSelect` vs upstream `emitCacheWarmingDecision` slot.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: What changed: extension tools now execute with an `ExtensionToolContext` built by `runner.createToolContext(toolCallId, signal, invocation?.context)`; kept fork per-invocation context factory (steering signal + dispose) and `addedToolNames` lazy-activation reporting. Why: upstream nested tool calls need the tool-call id on the context; the fork's steering-aware invocation context must stay the base object. Why an extension could not handle it: this is the adapter between registered tools and the agent runtime. Expected merge conflict zones: `wrapRegisteredTool` body and signature.

### Why

Upstream v0.99.1 (6a4af07d6) changed these paths while the fork carries its own behavior; the extension loader/runner/wrapper adopt upstream contracts additively and keep the fork builtins, signatures and loader alias table (plan D-2).

### Why an extension could not handle it

This is the extension host itself; extensions cannot redefine how they are loaded, wrapped or dispatched.

### Expected merge conflict zones

Every path listed above conflicts again where upstream edits the hunks named in its line; the fork-kept constructs named there are the anchors to preserve.

## 2026-09-29 - `listAdmittedDeliveries()` reports deliveries the session file refused

### What changed

- `packages/coding-agent/src/core/extensions/session-control-types.ts` (fork-only): `AdmittedDeliveries.failed?: readonly FailedDelivery[]` and the new `FailedDelivery { delivery_id, error }`, present only while non-empty, so a ledger with no refused write is unchanged; `already_admitted` also covers a failed delivery until the file takes a later entry.

### Why

A delivery whose entry the file refused must be settled rather than held (senpi#2328, todo 28); the drain needs to see that it failed and why.

### Why an extension could not handle it

The ledger is the runtime's; this is its public shape.

### Expected merge conflict zones

- `AdmittedDeliveries` in `session-control-types.ts`.

## 2026-09-29 - `pi.session`: external-message admission, its ledger, the durable header and the control endpoint; `session_control_wake`

### What changed

- `packages/coding-agent/src/core/extensions/session-control-types.ts` (new): the contract - `SessionControlActions`, `RegisterControlEndpointOptions` (`inboxDir`, `drain`, optional `isSessionReferenced`), `SessionControlRegistration` (`registered { socket, dispose }` | `unsupported { unsupported_platform | unsupported_mode }` | `failed { reason }`), `SessionControlWakeEvent { reason, reasons, delivery_ids? }`, the admission input/result/gate/ledger types and `SESSION_CONTROL_DELIVERY_TYPE`. Re-exported from `types.ts`, `extensions/index.ts` and the package root.
- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.session: SessionControlActions` (`registerControlEndpoint`, `admissionGate`, `admitExternalMessage`, `listAdmittedDeliveries`, `persistHeaderNow`); the `session_control_wake` event in `ExtensionEvent` and its `on` overload; optional `ExtensionActions.sessionControl`.
- `packages/coding-agent/src/core/extensions/loader.ts`: the runtime starts with a throwing pre-bind `sessionControl` stub; `pi.session.*` asserts the instance is active and delegates to the bound actions.
- `packages/coding-agent/src/core/extensions/runner.ts`: `bindCore` copies `sessionControl` when the host supplies it.
- `packages/coding-agent/src/core/extensions/index.ts`: re-exports the new types.

### Why

The session gateway applies other sessions' messages through one seam inside the target (the OmO thread component): it needs an atomic, idempotent admission call, the runtime's ledger to reconcile claims, a durable session id before exposure, and an endpoint plus edge-driven wakes so an idle target drains without a timer. A plain senpi TUI never registers, so it binds no socket and writes no registry entry.

### Why an extension could not handle it

The atomicity and the ledger live in the session runtime's queues and persistence, and the endpoint needs the TUI's editor, question and stop/continue state; none of it is reachable from the existing API.

### Expected merge conflict zones

- `types.ts`: the `ExtensionEvent` union after `AgentSettledEvent`, the `on` overload after `agent_settled`, the end of `ExtensionAPI` after `events`, the end of `ExtensionActions`, the `session-control-types.ts` import/export lines.
- `loader.ts`: the runtime stub literal after `setSessionFastMode`, the API literal before `rpc`.
- `runner.ts`: the `bindCore` action copies.

## 2026-09-29 - Turns requested during `session_start` dispatch start after every handler (senpi#1972)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `bindCore` routes `sendMessage(..., { triggerTurn: true })` and `sendUserMessage` through a `SessionStartTurnGate`, and `emit` runs a `session_start` dispatch inside that gate (the former `emit` body is now the private `dispatchEmit`; `emit` itself is not `async`, so every other event resolves on exactly the microtask it did before — an extra `async` hop there delayed `agent_end` settlement enough to break `post-compaction-tool-continuation-deadlock`). A turn an extension requests while `session_start` handlers are still being dispatched starts right after the last handler returns, in request order; a synchronous throw from starting it is reported through `emitError` with `RUNTIME_EXTENSION_PATH`. Messages without `triggerTurn`, and turns requested from any other event, go through unchanged and immediately.
- `packages/coding-agent/src/core/extensions/session-start-turn-gate.ts` (new, fork-only): the gate.

### Why

- Handlers run one after another in registration order, and some extensions start a turn from their own `session_start` handler (terminal monitor restore, goal continuation, loop runs). That turn reached the provider before later handlers had set up their per-session state. The Claude subscription provider restores its continuity binding in its `session_start` handler and is registered after those extensions, so the first resumed turn found no binding and re-sent the whole conversation as `flatten / registry_miss` while a valid binding sat on disk (senpi#1972, oh-my-openagent#8424 finding 3).
- Holding the turn removes the order dependency itself: nothing is reordered, ordinary event dispatch and `message_end` rewrite ordering are untouched, and it covers every extension, not just that provider.
- It cannot deadlock a handler: `sendMessage` / `sendUserMessage` are fire-and-forget, so no handler awaits the turn it requested. The held turn still starts inside `AgentSession.bindExtensions` before its binding-phase prompt readiness is cleared, so the senpi goal-resume exemption (b5ec70f266) sees the same state as before.

### Why an extension could not handle it

- The order problem sits between extensions: the extension that starts the turn cannot know which later handler the turn depends on, and a handler cannot run before the ones registered ahead of it. Only the runner sees the whole dispatch.

### Expected merge conflict zones

- LOW: the `sendMessage` / `sendUserMessage` lines in `bindCore`, the `sessionStartTurns` field next to `shutdownHandler`, and the two-line `emit` wrapper above `dispatchEmit`. An upstream edit inside the old `emit` body now lands in `dispatchEmit`.

## 2026-09-29 - `pi.sharedHostEnabled` is removed from the extension API (senpi#2328)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionAPI.sharedHostEnabled` is removed, and so are `ExtensionSessionProfile.sharedHostEnabled` and its `false` default in `DEFAULT_EXTENSION_SESSION_PROFILE`. The profile now carries `sessionKind` and `sessionContext` only; both are unchanged.
- `packages/coding-agent/src/core/extensions/loader.ts`: `ExtensionSessionOptions.sharedHostEnabled` is removed, `sessionProfile()` no longer fills it, and `createExtensionAPI` no longer puts it on the `pi` object. No deprecated alias remains: an extension that reads `pi.sharedHostEnabled` gets `undefined`.
- This supersedes the 2026-09-09 entries below that introduced `ExtensionAPI.sharedHostEnabled` and carried it in `ExtensionSessionProfile`.

### Why

- The field could only ever be `true` inside the interactive shared-host join, which is removed (senpi#2328). Keeping it would advertise a capability no session can have.

### Why an extension could not handle it

- `ExtensionAPI` and the loader that builds it are the extension contract itself.

### Expected merge conflict zones

- LOW: the `ExtensionSessionProfile` interface, `DEFAULT_EXTENSION_SESSION_PROFILE`, and the Session Context block at the head of `ExtensionAPI` in `types.ts`.
- LOW: `ExtensionSessionOptions`, `sessionProfile()`, and the head of the `api` object in `createExtensionAPI` in `loader.ts`.

## 2026-09-27 - `kernelPrelude`, `permissionParser`, and the `tool_activated` event on the extension API

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`:
  - `KernelPreludeContribution`, and `ToolDefinition.kernelPrelude`.
  - `ToolPermissionRequest`, and `ToolDefinition.permissionParser(input, cwd)`.
  - `ToolActivatedEvent`, plus its `pi.on("tool_activated")` overload.
  - `ToolInfo` now carries `kernelPrelude` and `permissionParser`.
- `packages/coding-agent/src/core/extensions/index.ts`: re-exports `KernelPreludeContribution` and `ToolPermissionRequest`.
- `packages/coding-agent/src/core/extensions/kernel-prelude.ts` (new): validates a prelude's exports against the built-in kernel helpers.

### Why

- These are generic extension hooks, so a whole capability can ship from an extension package without edits to senpi core.

### Why an extension could not handle it

- They are public extension API types.

### Expected merge conflict zones

- MEDIUM: the `ToolDefinition` field list, the `ExtensionEvent` union, the `on()` overloads, and the `ToolInfo` pick in `types.ts`.

## 2026-09-27 - Directory entries and JSON dependencies load on Bun 1.3.x (senpi#2164)

### What changed

- `bun-extension-importer.ts`: only files the graph transpiles (`.[cm]?[jt]sx?`) get a `senpi-extension:` id. Every other resolved file (JSON, TOML, text, native addons) resolves to its real path, so Bun's own loader imports or requires it, attributes included. `import()` of an extension path that is a directory resolves it through `Bun.resolveSync` (package `main`/`exports`, then `index.*`) before importing; a regular file keeps the direct realpath, because `Bun.resolveSync` reads a literal `?` in a path as a query.
- `bun-extension-registry.ts`: `onResolve` no longer hands non-JS ids back to Bun's `file` namespace, because the importer no longer mints them. `metadata()` treats an absolute-path id as that file, so `import.meta.resolve` still returns a `file:` URL and `require.resolve` the path for those targets.

### Why

- On Bun 1.3.x a runtime plugin's `onResolve` hand-back to the `file` namespace works only for a statically linked import. A runtime `import()`, a `require()`, or the importer's own top-level import fails with `Cannot find module 'file:/…'` or `ENOENT reading "file:/…"`. This was measured on 1.3.14; 1.4.0 accepts the same hand-back. In practice ajv's `require("./refs/data.json")` broke every `pi-zai-mcp` entry point, and a package extension declared as `"."` (`pi-glm-usage`) never loaded, while native Bun loads both. The existing `preserves import attributes when an extension computes the specifier` regression failed on 1.3.14 for the same reason.

### Why an extension could not handle it

- This is the loader that evaluates extension source; it runs before any extension exists.

### Expected merge conflict zones

- LOW: `resolveTarget`/`fileTarget` and the returned `import()` in `bun-extension-importer.ts`; `metadata().resolvePath` and the `onResolve` body in `bun-extension-registry.ts`.

## 2026-09-25 - before_agent_start says who started the turn (`trigger`) (senpi#2137)

### What changed

- `types.ts` `BeforeAgentStartEvent.trigger: "prompt" | "extension"`. `runner.ts` `emitBeforeAgentStart` takes an optional `trigger` (default `"prompt"`) and puts it on the event. `agent-session.ts` passes `"extension"` from the `sendCustomMessage(..., { triggerTurn: true })` path; the user-prompt path and the preview keep the default. `docs/extensions.md` documents the field.

### Why

- The user-prompt path and the hidden extension-triggered path emitted the same event shape, so a handler could not tell a user request from an extension's bootstrap text. The todotools first-turn plan opener armed on an omo onboarding turn and then skipped the user's real first request (senpi#2137).

### Why an extension could not handle it

- Only the host knows which path started the turn; the event is the one place handlers see it.

### Expected merge conflict zones

- The `BeforeAgentStartEvent` interface, the `emitBeforeAgentStart` options object, and the `triggerTurn` call site in `agent-session.ts`.

## 2026-09-24 - before_agent_start handlers opt in to the preview pass with `previewSafe` (senpi#2115)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new `BeforeAgentStartHandlerOptions` (`previewSafe?: boolean`), accepted as the optional third argument of the `before_agent_start` overload of `ExtensionAPI.on`; `Extension` gains optional `previewSafeHandlers?: WeakSet<HandlerFn>`. `ExtensionContext.getPromptCachePrefixRequest?(options?)` and `ExtensionContextActions.getPromptCachePrefixRequest?` take `PromptCachePrefixRequestOptions` (`signal`) and resolve a `PromptCachePrefixResult` (`{ status: "ready", request }` or `{ status: "skipped", reason }`) instead of `PromptCachePrefixRequest | undefined`. The `preview` doc on `BeforeAgentStartEvent` says only preview-safe handlers receive it.
- `packages/coding-agent/src/core/extensions/loader.ts`: `on(event, handler, options)` records a `before_agent_start` handler registered with `{ previewSafe: true }` in `extension.previewSafeHandlers`.
- `packages/coding-agent/src/core/extensions/runner.ts`: new `getPreviewUnsafeBeforeAgentStartPaths()` lists extensions with a `before_agent_start` handler that is not preview-safe; `emitBeforeAgentStart`'s fifth argument gains `signal`, a preview invokes only preview-safe handlers, and an aborted signal stops dispatch before the next handler. The bound `getPromptCachePrefixRequest` context action forwards its options and resolves `skipped` when the host binds no builder.
- Fork-only builtins: every builtin `before_agent_start` handler registers `{ previewSafe: true }`. `anthropic-bash`, `anthropic-web-search`, `openai-web-search`, `bash-timeout`, `terminal`, `todotools`, `prompt-preset`, and `imagegen` only compute a system prompt. `compaction` and `hooks` already returned early on a preview. `prompt-url-widget` now returns early on a preview; `rules` composes the same block on a preview without touching `nativeContextPaths` or the static-injection marks; `openai-image-gen` reads the arbitration on a preview without committing `state` or `setNativeBypass`; `mcp` awaits only the session-start attach on a preview and skips the elicitation UI binding and skill-declared server attach.

### Why

Extensions written against the pre-#2096 contract never check `event.preview`, so running them in a preview executed real-turn side effects for a turn that does not exist (an external memory extension lost its drained notices). Only a handler's author can say whether it is side-effect free, so the preview must be opt-in per handler, and a preview that cannot include every handler would compose the wrong prefix, so it is skipped rather than run partially.

### Why an extension could not handle it

Handler registration and dispatch are owned by the loader and runner; an extension cannot mark another extension's handler or keep the host from invoking it.

### Extension impact

- `pi.on("before_agent_start", handler)` is unchanged for real turns. A handler that is side-effect free when `event.preview` is `true` should register with `{ previewSafe: true }`; while any registered handler lacks it, the session-start prompt-cache prewarm is skipped and records a `prompt-cache-prewarm` entry with phase `skipped` and the reason.
- Breaking for callers of `ctx.getPromptCachePrefixRequest()` (introduced by #2096 in 2026.9.24-2): read `result.status` and `result.request`.

### Expected merge conflict zones

- LOW: the `getPromptCachePrefixRequest` doc and signature in `ExtensionContext`, the block after `PromptCachePrefixRequest`, the end of `BeforeAgentStartEvent`, the `before_agent_start` overload of `ExtensionAPI.on`, the `handlers` field of `Extension`, and the end of `ExtensionContextActions` in `types.ts`.
- LOW: the `on` registration method and the `./types.ts` import block in `loader.ts`.
- LOW: the `getPromptCachePrefixRequest` context entry and the `emitBeforeAgentStart` signature and dispatch loop in `runner.ts`.

## 2026-09-24 - before_agent_start preview pass and the prompt-cache prefix request (senpi#2096)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `BeforeAgentStartEvent` gains optional `preview?: boolean`; new `PromptCachePrefixRequest` (`model`, `context`, `options`); `ExtensionContext.getPromptCachePrefixRequest?()` and `ExtensionContextActions.getPromptCachePrefixRequest?`.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBeforeAgentStart` takes an optional fifth `{ preview }` argument and sets `event.preview: true` when it is set; the bound `getPromptCachePrefixRequest` action is exposed on every handler context.
- Fork-only builtins: `builtin/compaction/index.ts` and `builtin/hooks/index.ts` return early from `before_agent_start` on a preview, so it runs no compaction, reminder, or restoration and does not consume a queued UserPromptSubmit context.

### Why

The session-start OpenAI prompt-cache prewarm must send the first turn's exact prefix, and that turn's system prompt is only known after `before_agent_start`. The preview pass runs the same handlers with an empty prompt so the prewarm gets the same system prompt without a turn.

### Why an extension could not handle it

Only the host can run the `before_agent_start` chain, and only the host knows the tools, loop options, and provider preparation the next turn uses.

### Extension impact

- Additive: `preview` is absent on every real turn. Handlers with one-shot side effects should return early when `event.preview` is `true`; handlers that only compute a system prompt need no change.

### Expected merge conflict zones

- LOW: the end of `BeforeAgentStartEvent`, the `prepareProviderRequest` neighbourhood of `ExtensionContext`, `ProviderRequestPreparation`'s neighbourhood, and the end of `ExtensionContextActions` in `types.ts`.
- LOW: the `getSystemPromptOptionsFn` field and its `bindCore` assignment, the `prepareProviderRequest` context entry, and the `emitBeforeAgentStart` signature/event literal in `runner.ts`.

## 2026-09-23 - Entry renderers can replace the card directly before them (senpi#2051)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: new `EntryRendererOptions` with an optional `replaces(previous, next)` predicate; `registerEntryRenderer` takes it as an optional third argument, and `Extension` gains an optional `entryRendererOptions` map.
- `packages/coding-agent/src/core/extensions/loader.ts`: `registerEntryRenderer` stores the options next to the renderer (a re-registration without options clears them).
- `packages/coding-agent/src/core/extensions/runner.ts`: `getEntryRendererOptions(customType)` returns the options of the extension that owns the renderer `getEntryRenderer` resolves.
- `packages/coding-agent/src/core/extensions/index.ts` and `packages/coding-agent/src/index.ts` export `EntryRendererOptions`.

### Why

- A Goal wait appends a `goal-cache-warmup` entry when it is scheduled and another when it wakes; a reload used to append a third. Every entry became its own transcript card, so one wait rendered as a stack. The goal extension needs to say "this entry updates the card before it" without the host hard-coding a goal rule.

### Why an extension could not handle it

- An entry renderer only sees its own entry; the transcript container that decides whether a card is added or replaced is host-owned.

### Extension impact

- Additive and optional: existing `registerEntryRenderer(type, renderer)` calls behave exactly as before.

### Expected merge conflict zones

- The `EntryRenderer` type block and the `registerEntryRenderer` declaration in `types.ts`; `registerEntryRenderer` in `loader.ts`; `getEntryRenderer` in `runner.ts`; the rendering export lists in both `index.ts` files.

## 2026-09-22 - One extension module generation per source version, not per session (senpi#1948)

### What changed

- New `extension-module-cache.ts` owns the process-wide extension module generation: the live importer, the factories compiled under it, and a fingerprint (`mtimeNs:size`) of every source file that generation compiled. `cachedExtensionFactory()` serves a compiled factory while every recorded file is unchanged, `extensionModuleImporter()` hands out the one live importer, and `rememberExtensionFactory()` records a freshly compiled factory. A changed or deleted source drops the whole generation, so the next load compiles a new one.
- `loader.ts` loads through that cache on every path: the per-cwd LRU factory cache (`extensionCacheByCwd`, `MAX_EXTENSION_CACHE_CWD_ENTRIES`, `ExtensionCacheToken`) and the `useCache` opt-in are gone, `loadExtensions` and `loadExtensionsCached` behave identically, and `clearExtensionCache` re-exports the cache module's.
- `bun-extension-importer.ts` exposes `compiledFiles()`, the source files its graph transpiled. An importer without it (the Node jiti path) is never cached, because its graph cannot be checked for staleness.
- Invalidation stops REUSING a generation and never disposes it: a session loaded under it can still lazily `import()` from its graph after its factory returned, and a disposed graph makes that throw `ExtensionGenerationDisposedError`. Its modules stay registered either way.

### Why

- A module registry has no eviction API, so each importer generation's modules stay resident for the life of the process. Loading extensions per session therefore cost a shared RPC host one permanent copy of the whole extension graph per `open_session`: measured +14 to +17 MB of settled resident memory per session on the compiled runtime with a full extension set, and ~90-150 new `ModuleRecord`s per session in a heap snapshot. A host reached multiple GB in a few hours of ordinary use.
- After the change the same measurement (source host, same plugin, five open/close cycles, heap read after a full GC) goes from ~+16 MB per session to ~+0.77 MB, and retained objects from ~125,000 per session to ~271.

### Why an extension could not handle it

- The loader is what evaluates extension modules; an extension cannot decide how many times its own source is compiled.

### Extension impact

- An extension's module scope is now evaluated once per process while its source is unchanged, and its factory still runs once per session, so each session keeps its own instance. Module-scope state was never per session (factories must be pure - `AGENTS.md`), so this changes no documented contract. Editing an extension still takes effect on the next load: the edit changes the fingerprint and the graph is recompiled.

### Expected merge conflict zones

- The cache block near the top of `loader.ts` and its `loadExtensionsInternal` signature, whenever upstream touches loader caching.


## 2026-09-21 - Read es-module-lexer 3 import records in the Bun extension importer (senpi#1895)

### What changed

- `bun-extension-importer.ts` reads the tagged-union records that `es-module-lexer` 3 returns from the asm.js full build: `type === "dynamic"` replaces `d >= 0`, `importStart`/`importEnd` replace `ss`/`se`, `specifier` replaces `n`, `start`/`end` replace `s`/`e`, `dynamicStart` replaces the dynamic `d` index, and `attributesStart` replaces `a`. Static and `export * from` edges are matched by `type`; `import.meta` records are skipped as before.
- `bun-extension-commonjs.ts` is unchanged: the full build still returns `hasModuleSyntax` as the fourth tuple element.

### Why

- `es-module-lexer` 3.0.0 replaced the terse v2 record fields with descriptive tagged unions and turned `es-module-lexer/js` into the asm.js full build; the importer's field reads stopped compiling (seven `TS2339` errors) and eleven extension tests failed until the records were read by their new names.

### Why an extension could not handle it

- The importer runs before any extension code is evaluated and rewrites the extension's own import edges; it is engine-owned.

### Extension impact

- None: rewritten output is byte-identical for the covered cases (static, dynamic, attributes, `export * from`).

### Expected merge conflict zones

- The import-edge rewrite loop in `bun-extension-importer.ts`, whenever upstream touches the importer.

## 2026-09-21 - Retained-session parked/resumed events (#1902)

### What changed

- `types.ts` adds `SessionParkedEvent` and `SessionResumedEvent` to the session event union and `ExtensionAPI.on` overloads; `index.ts` exports both.
- The existing `runner.ts` generic emit union derives from `ExtensionEvent`, so both events use its existing ordered handler dispatch.

### Why

- Optional per-session work needs an explicit attachment lifecycle signal without confusing parking with shutdown or session switching.

### Why an extension could not handle it

- Public event types and host-originated attachment transitions are owned by the engine.

### Expected merge conflict zones

- Session event union, event-subscription overloads and public type exports.

## 2026-09-21 - User-message edits and backward-compatible entry-addressed navigation

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: adds required `ctx.editUserMessage(entryId, text, options?)` beside assistant edits, with identical options and core typed rejections. `navigateTree` accepts either the shipped positional string plus options or `{ entryId, ...options }`, including `expectedLeafId`.
- `packages/coding-agent/src/core/extensions/runner.ts`: binds, resets, and injects the user-edit action with the existing active-context guard. Normalizes object-form navigation once into the positional host action without changing the caller's token.

### Why

- `packages/coding-agent/src/core/extensions/types.ts`: an object alongside the string preserves existing extension calls; replacing the positional signature would break them. The options object makes entry addressing explicit without adding another method.
- `packages/coding-agent/src/core/extensions/runner.ts`: core already implements tree selection and user edits; extensions need those capabilities through their command context. Message entry IDs remain distinct from metadata-advanced leaf tokens.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns the command contract; extensions cannot add required members to their own context.
- `packages/coding-agent/src/core/extensions/runner.ts` owns host action binding and context construction in all modes.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: command context and action declarations beside `navigateTree` and `editAssistantMessage`.
- `packages/coding-agent/src/core/extensions/runner.ts`: handler types, default fields, command binding/reset, and context injection.

## 2026-09-20 - Import attributes survive the CommonJS rewrite (#1864)

### What changed

- `bun-extension-importer.ts`: the CommonJS branch of `load()` carries the text between the specifier and the end of the statement - the `with` or legacy `assert` clause - into `rewriteCommonJsImport`.
- `bun-extension-commonjs.ts`: `rewriteCommonJsImport` takes that clause as an optional fourth argument and appends it to the emitted import, both in the aliased form and in the bare-specifier fallback.
- `test/extensions/bun-extension-regressions.test.ts`: the file-loader regression imports a `.json` asset instead of a `.bin` one.

### Why

- The CommonJS branch added in #1838 replaces the whole import statement (`edge.ss` .. `edge.se`) and rebuilds it from the binding clause and the resolved id, so everything after the specifier was dropped. Import attributes live exactly there, and they pick the loader: measured through the importer, `import value from "./helper.json" with { type: "file" }` returned `{"value":41}`, `.toml` returned the parsed table and `.txt` returned its text, while plain Bun returns the path for all three. A dynamic import was never affected, because that branch replaces only the `import` keyword.
- The shipped regression could not catch it. Its fixture was `asset.bin`, and an unknown extension already resolves to Bun's file loader, so the assertion passed with or without the attribute - measured: the same import with no attribute at all returns the same path. A file Bun parses by default is what makes the assertion able to fail.

### Why an extension could not handle it

- This is the loader that evaluates extension source; it runs before any extension exists.

### Expected merge conflict zones

- LOW: the CommonJS branch of the edit loop in `bun-extension-importer.ts` `load()`, and the `rewriteCommonJsImport` signature in `bun-extension-commonjs.ts`.

## 2026-09-20 - The extension runtime's import is built at runtime (#1862)

### What changed

- `bun-extension-registry.ts`: `metadata().import` now calls a module-level `importModule`, built once with `new Function("specifier", "options", "return import(specifier, options)")`, instead of writing `import(id, { ...options })` inline. The resolved specifier and the caller's `ImportCallOptions` are forwarded unchanged, so an extension's dynamic import and its attributes behave exactly as before.

### Why

- esbuild accepts only a fully static second argument for `import()`: measured on esbuild 0.28.2, `import(x, { ...options })`, `import(x, options)`, `import(x, { with: options?.with })` and `import(x, { with: { type: t } })` each warn `unsupported-dynamic-import`, while `import(x)` and `import(x, { with: { type: "json" } })` do not. The attributes here are whatever an extension wrote, so no static form exists.
- `scripts/build-coding-agent-bundle.mjs` runs esbuild over this module twice (the main entry pass and the lazy/worker pass), so every release build - and every downstream build that vendors this package - printed the same warning twice. esbuild emitted the call verbatim either way, so nothing behaved differently; the cost was that the one place a real bundler warning would appear was already occupied.
- esbuild has no per-call suppression, and the import must stay dynamic because extensions resolve through the Bun plugin at runtime. Building the import function at runtime is the supported way to keep the bundler out of a call it cannot follow.

### Why an extension could not handle it

- This is the loader that evaluates extension source; it runs before any extension exists.

### Expected merge conflict zones

- LOW: the module-level `importModule` declaration and the `import` member of `metadata()` in `bun-extension-registry.ts`.

## 2026-09-19 - CommonJS bodies evaluate sloppy, and package type decides .js (#1841)

### What changed

- `bun-extension-importer.ts`: the CommonJS body is compiled with the `Function` constructor instead of being emitted as a function literal inside the generated ES module. A literal inherits the module's strict mode; `Function` is sloppy by default, matching Node and plain Bun. The per-file metadata object is passed as the first parameter so the transformed body keeps the identifiers the transpiler already bound, a `//# sourceURL=` trailer keeps stack frames on the dependency file, and a thin forwarding wrapper preserves Node's `this === module.exports` receiver plus the existing `graph.commonJs` cycle and eviction lifecycle.
- `bun-extension-importer.ts`: Bun's transpiler strips a leading `"use strict"` directive, so the original source is scanned for its complete directive prologue and strict mode is re-applied to the compiled body. The scan accepts custom directives, comments, and ASI separators, while a non-prologue occurrence - in a comment, a string value, or a nested function - does not opt in.
- `bun-extension-commonjs.ts`: new `isEsmByPackageType()` resolves the nearest `package.json` `"type"` for `.js` only. Its uncached walk stops at `node_modules` (or the filesystem root), so an application `"type": "module"` cannot leak into a manifest-less dependency. `isCommonJsFile()` and the importer's wrapper decision both consult it for `.js`, so a `"type": "module"` `.js` file with only top-level await takes the ESM path. `.cjs` still always wins, and `.mjs`/`.mts`/TypeScript classification is unchanged.

### Why

- Directive detection also preserves inequality expressions, Unicode comment terminators, string literals, and identifier boundaries instead of accidentally changing strict mode at an ASI boundary.
- #1841: a CommonJS dependency evaluated in strict mode because its wrapper lived inside an ES module, so implicit-global assignment threw `ReferenceError` and jsdom 27's `@acemir/cssom`/`cssstyle` raised `Attempted to assign to readonly property` through the loader while the same code parses under plain `bun` and `node`. Separately, a `.js` file in a `"type": "module"` package was classified by syntax alone, so a file whose only module-level syntax is `await` was wrapped as CommonJS and failed to parse with `"await" can only be used inside an "async" function`.

### Why an extension could not handle it

- Both decisions are made while the loader transforms dependency source inside the Bun plugin, before any extension code exists to observe them.

### Expected merge conflict zones

- MEDIUM: the `!hasModuleSyntax` wrapper branch in `bun-extension-importer.ts` `load()`.
- LOW: the extension checks in `detect()` in `bun-extension-commonjs.ts`.

## 2026-09-19 - CommonJS dependencies evaluate with Node's module semantics (#1838)

### What changed

- `bun-extension-importer.ts`: a CommonJS module is wrapped in Node's module function wrapper — `export default <meta>.commonJs(function (exports, module) { ... });` — instead of the previous `const module = { exports: {} }; const exports = module.exports;` prologue. `exports` and `module` are parameters again, so a dependency may reassign either; the body still runs in strict mode because the wrapper lives inside an ES module.
- `bun-extension-importer.ts`: `graph.evaluateCommonJs()` registers the live `module` object of a CommonJS file before its body runs, and `graph.require()` answers from that registry before falling back to Bun's native require. A require issued inside a cycle therefore receives the partially built exports, as in Node, and a repeated require returns the same object. A body that throws is evicted from the registry, so a later require re-throws instead of returning a half-built module.
- `bun-extension-registry.ts`: the per-file `require` handed to extension code is a function object carrying `resolve`, which returns the absolute path of a graph-resolved file (and the id itself for builtins and virtual modules); the metadata gains `commonJs(body)` and `ExtensionGraph` gains `evaluateCommonJs(filename, body)`.
- `bun-extension-importer.ts`: files with a `.mjs` or `.mts` extension stay on the ESM path even when they carry no import or export statement, so top-level `await` in such a file keeps parsing. The shebang strip now runs on the transpiled source before any prologue is prepended; Bun's transpiler already removes a hashbang, so this is a tidy-up rather than a behavior change.

### Why

- `const exports` made every CommonJS file that reassigns `exports` a parse-time failure under Bun: `module.exports = exports = { ... }` is the published shape of `whatwg-url/lib/utils.js` and `jsdom/lib/generated/idl/utils.js`, and Bun rejects the wrapped module with `This assignment will throw because "exports" is a constant`. The rejection is not contained to that module: the whole extension graph fails to load, which is how it surfaced (an extension that pulls in jsdom through its dependency graph could not load at all).
- With that prologue gone the same graph hit the next two gaps. `jsdom/lib/jsdom/living/xhr/XMLHttpRequest-impl.js` calls `require.resolve("./xhr-sync-worker.js")`, and `resolve` only existed as a sibling key of the metadata object, so `require.resolve` was undefined. `@acemir/cssom` requires `CSSStyleDeclaration` and `CSSStyleRule` mutually; a CommonJS module reached through the graph exposed its exports only through `export default module.exports`, which is assigned after the body finishes, so the inner require of a cycle saw `undefined`.
- Node evaluates a CommonJS module inside a function whose `exports` and `module` are parameters, hands out the module object from its cache as soon as evaluation starts, and gives every module a `require.resolve`. Matching those three points is what lets a published CommonJS dependency load here the way it does under `node` and under plain `bun` for the shapes jsdom and whatwg-url use; the jsdom probe extension and pi-webfetch load on the rebuilt engine. One difference stays: the body runs in strict mode, so a dependency that relies on sloppy-mode behavior (assigning an implicit global, writing a read-only property) still throws here.

### Why an extension could not handle it

- This is the loader that evaluates extension source; it runs before any extension exists.

### Expected merge conflict zones

- LOW: the `!hasModuleSyntax` branch and the runtime-prologue template at the end of `graph.load()`, `graph.require()` and the new `graph.evaluateCommonJs()` in `bun-extension-importer.ts`; `metadata()` and the `ExtensionGraph` interface in `bun-extension-registry.ts`.

## 2026-09-18 — The extension runtime shim resolves to a file, not a Bun virtual module (omo#8427)

### What changed

- `bun-extension-registry.ts`: `"runtime"` resolves to `extension-runtime-module.js` on disk instead of a `builder.module()` virtual module; the metadata factory is published through `Symbol.for("senpi.extension.runtime.metadata")` and read back by that file.
- `extension-runtime-module.ts` (new): the shim the namespace resolves to when it exists on disk. Inside a `bun build --compile` binary `import.meta.url` is a `$bunfs` URL with no real file behind it, so the compiled binary keeps the virtual-module route (which never failed there) and only the on-disk case takes the file route.
- Module ids are parsed by one `splitModuleId()` helper that requires a real `<generation>/<encoded filename>` shape and raises `ExtensionModuleIdError` otherwise, replacing two open-coded `indexOf("/")` slices.

### Why

- On `windows-latest` under `bun test --parallel`, a `builder.module()` registration is intermittently invisible to Bun's resolver while the hooks keep working. Measured on the shard (omo run 35329245740): `onResolve` fired for `"runtime"` and returned `{ path: "runtime", namespace }` with the registration still listed (`hasModuleReg: ["runtime"]`), and Bun answered `Cannot find package 'runtime'` anyway — generation 0 on its only resolve, generation 1 on its **41st** after 40 successes in the same worker. An independent plugin's virtual module resolved fine in that worker, so this is not a Bun-wide outage. Every agent-dir extension in the affected worker then failed to load, which is what made omo's two marker tests red on every `windows 2/2` shard across three releases.
- The `indexOf("/")` slices produced `Cannot find package '1'` (the generation number) for an id whose encoded half holds no literal slash — a second defect the first one had been masking.

### Why an extension could not handle it

- This is the loader that runs before any extension exists.

### Expected merge conflict zones

- MEDIUM: the `setup(builder)` body in `bun-extension-registry.ts`.

## 2026-09-18 - The extension reference publishes the session identity and what the config-reload watcher costs (senpi#1782)

### What changed

- `packages/coding-agent/docs/extensions.md` gains "pi.sessionKind / pi.sessionContext / pi.sharedHostEnabled" at the head of the ExtensionAPI section: the property table, a factory-time gating example, the fact that the engine never interprets `sessionContext` (no auth, model or resource decision reads it), the boundary caps an extension therefore receives pre-validated, and a link to the wire side in `docs/rpc.md`.
- `packages/coding-agent/docs/extensions.md` "Config reload" gains a measured cost callout: the watcher is per session and lazily spawns one `node:worker_threads` Worker each, so a shared host carries about one extra OS thread and ~5 MB per session (senpi#1794), and a host with the builtin disabled adds no thread per session.

### Why

- `sessionKind`/`sessionContext` shipped on `ExtensionAPI` and are the mechanism the shared daemon offers instead of per-session extension paths, but an extension author had no documentation for them at all - the only description lived in the RPC protocol reference, which extension authors do not read.
- The config-reload watcher is the dominant per-session cost of a shared daemon and is invisible from the extension docs, where the builtin is described purely as a convenience. An operator sizing a host, and any author writing a similar watcher, needs the number and the cause in the same place as the feature.

### Why an extension could not handle it

- Documentation of the `ExtensionAPI` contract and of a default-on builtin; both are engine surfaces an extension consumes rather than defines.

### Expected merge conflict zones

- LOW: the head of the "ExtensionAPI Methods" section and the first paragraphs of "Config reload" in `docs/extensions.md`.


## 2026-09-18 - Named imports from CommonJS packages link through the extension graph (senpi#1807)

### What changed

- `bun-extension-importer.ts`: `load()` resolves each static import to its real path and, when the target has no module syntax (or is `.cjs`), replaces the whole import statement with a `default` import plus destructuring instead of only rewriting the specifier. `resolve()` now delegates to a `resolveTarget` helper that returns both the graph id and the real path.
- `bun-extension-commonjs.ts` (new): `isCommonJsFile` (cached lexer probe, `.cjs`/`.mjs`/TypeScript short-circuits) and `rewriteCommonJsImport` / `parseImportClause`, which turn `import { A, B as C } from "x"`, `import * as ns`, and `import d` into bindings off `module.exports`.

### Why

- A CommonJS module in the graph is wrapped to expose only `export default module.exports`, so Bun's ESM linker rejected `import { Readability } from "@mozilla/readability"` with `Export named 'Readability' not found in module 'senpi-extension:...'`, while the same import works in plain Bun and Node (they synthesize named exports with cjs-module-lexer). CommonJS has no live bindings, so `default` plus destructuring is exactly Node's interop semantics, with no new dependency.

### Why an extension could not handle it

- The failure happens while the loader links the extension's own module graph, before any extension code runs.

### Expected merge conflict zones

- MEDIUM: the import-edge loop inside `load()` and the `resolve` member of `graph` in `bun-extension-importer.ts`. `bun-extension-commonjs.ts` is fork-only.

## 2026-09-17 - ExtensionAPI publishes the session's kind and opaque context (senpi#1782)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds the session-identity vocabulary next to the extension API: `SessionKind` (`"interactive" | "worker"`), `SessionContext` (`Readonly<Record<string,string>>`), the shared frozen `EMPTY_SESSION_CONTEXT`, the `ExtensionSessionProfile` value object (shared-host flag + kind + context) and its `DEFAULT_EXTENSION_SESSION_PROFILE`. `ExtensionAPI` gains the read-only `sessionKind` and `sessionContext` beside `sharedHostEnabled`; both are `interactive`/`{}` for classic launches and for every open that omits them.
- `packages/coding-agent/src/core/extensions/loader.ts` carries ONE `ExtensionSessionProfile` where it previously carried a bare `sharedHostEnabled` boolean (`createExtensionAPI`, `initializeExtension`, `loadExtension`, `loadExtensionFromFactory`), so the parameter count is unchanged while three per-session facts travel. The public `loadExtensions` options bag gains `sessionKind`/`sessionContext` beside `sharedHostEnabled` (all optional, `ExtensionSessionOptions`), and `sessionProfile()` applies the defaults once.
- `packages/coding-agent/src/core/extensions/index.ts` re-exports `SessionKind`, `SessionContext` and `EMPTY_SESSION_CONTEXT`.

### Why

- A shared RPC host loads ONE extension set and serves every session of the machine, including machine-driven worker sessions. `pi.sessionContext` is how a single extension instance recognizes the session it was loaded for (senpi#1782: the omo plugin gates itself per session by `role`) without the host accepting per-session extension paths or CLI flags on the wire.
- The values are inert by construction: they are read-only on the API, frozen by the RPC registry, and never consulted by auth, model or resource resolution.

### Why an extension could not handle it

- `types.ts` owns the published `ExtensionAPI` contract and `loader.ts` is the only place that constructs it; an extension cannot add a field that other extensions receive, nor learn a per-session identity the host never gave it.

### Expected merge conflict zones

- LOW: the `ExtensionAPI` header block after `sharedHostEnabled` in `types.ts`, and the `sharedHostEnabled` parameter of the four loader functions in `loader.ts`.

## 2026-09-17 - Native Bun extension imports on every bun runtime (senpi#1781)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts` selects `createBunExtensionImporter(VIRTUAL_MODULES)` when `isBunBinary || isBunRuntime` (the module-local `usesNativeBunImports`) instead of only inside a compiled binary, and the same predicate gates the live-runtime factory retention in `initializeExtension` so a plain bun runtime keeps its generation graph reachable exactly as the compiled binary does.
- Node runtimes (Node SEA, the esbuild-bundled Node distribution, unbundled dist installs) keep the lazily imported jiti path with their existing `virtualModules` / `alias` / `tsconfigPaths` options and `moduleCache: false`.

### Why

- The Bun APIs the native importer needs (`Bun.Transpiler`, `Bun.resolveSync`, `Bun.plugin`) exist on any bun process, not only in `$bunfs`. Gating on the binary alone made every bun-global install re-run jiti + Babel over the bundled codemode extension (136 TypeScript files) and every user `.ts` extension on each boot: about 467ms of Babel plus 118ms of jiti cache writes per start.

### Why an extension could not handle it

- The loader resolves and evaluates extension modules before any extension code exists; an extension cannot choose the transformer that loads it.

### Expected merge conflict zones

- MEDIUM: the runtime-detection block and `createExtensionModuleImporter()` in `loader.ts`, plus the retention branch in `initializeExtension`.

## 2026-09-16 - Type kernelTools as the shipped invoke-scope surface (senpi#1731)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` types `ExtensionContext.kernelTools` as `ExtensionKernelTools` instead of a hand-written `invoke(request, signal?: AbortSignal)` copy.
- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts` owns `ExtensionKernelTools`, `KernelToolInvokeOptions`, and `KernelToolInvokeScope`: `invoke` accepts `{ signal?, scope? }` (bare `AbortSignal` still typed) and `capabilities.invokeScope` is present.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` is the public `ExtensionContext` contract; coding-agent is the lower layer and must declare the shipped kernel-tools surface rather than import it from senpi-codemode.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns `ExtensionContext`; an extension cannot replace the host's published type.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts` after `steeringSignal`; `packages/coding-agent/src/core/extensions/kernel-tools-context.ts` `ExtensionKernelTools` declaration.

## 2026-09-16 - Host budget for session_shutdown handlers (senpi#1732)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts` bounds each `session_shutdown` handler inside `emit`: the budget (warn 2s, hard cap 10s) is read once per shutdown emission from `SettingsManager`, every handler receives its own `AbortController` signal, a single warning names the extension and the elapsed ms at the warn threshold, and at the cap the runner aborts that signal, emits an extension error (`handler timed out after <N>ms`) and continues with the next handler instead of awaiting the hung one. All other events keep the uncapped sequential await.
- `packages/coding-agent/src/core/extensions/types.ts` adds the additive optional `SessionShutdownEvent.signal` so a handler can observe the host cap; handlers that ignore it behave exactly as before.

### Why

- `packages/coding-agent/src/core/extensions/runner.ts` is the only place that awaits extension shutdown handlers, so it is the only place that can stop one hung extension from holding quit/reload/new/resume hostage.
- `packages/coding-agent/src/core/extensions/types.ts` owns the event contract every extension consumes; the cancellation signal has to travel on the event.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/runner.ts` runs the handler loop; an extension can only budget itself, and the failure mode is precisely an extension that does not.
- `packages/coding-agent/src/core/extensions/types.ts` is host-owned; an extension cannot add a field other extensions receive.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: the `emit` handler loop and the new private `resolveSessionShutdownBudget` / `runSessionShutdownHandler` methods placed directly above it; the `SettingsManager` import. Upstream's own shutdown cap (`SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS`) would land in the same loop - keep the settings-driven warn/cap pair.
- `packages/coding-agent/src/core/extensions/types.ts`: the `SessionShutdownEvent` body after `targetSessionFile`.

## 2026-09-16 - Transient kernelTools capability (#1647)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds optional `ExtensionContext.kernelTools`.
- `packages/coding-agent/src/core/extensions/kernel-tools-context.ts` holds the AsyncLocalStorage binder.
- `packages/coding-agent/src/core/extensions/runner.ts` createContext reads that store.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` is the exported host-tool execution context; task/workpool must see the originating eval's capability.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns ExtensionContext; an extension cannot add a field for other tools.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts` after `steeringSignal`; `runner.ts` createContext getters.

## 2026-09-14 - Declarative eval-only tool exposure (#1678)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds `"eval"` to ToolExposure, documents registry availability with model-facing withholding, and preserves that value in normalizeToolExposure with the same lazy-activation default as direct tools.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` must preserve a tool's declared eval exposure so session policy can hide it from direct calls without removing it from the executable catalog.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns the public ToolDefinition contract and shared normalizer; an extension cannot extend their accepted values for other consumers.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: ToolExposure, ToolDefinition.exposure and normalizeToolExposure. Preserve the eval value and the existing search metadata behavior.

## 2026-09-14 - Register herdr with host-owned loaded extension paths (senpi#1645)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds optional read-only `ExtensionContext.loadedExtensionPaths`, including event-only extensions and synthetic factory identifiers.
- `packages/coding-agent/src/core/extensions/runner.ts` supplies a guarded lazy getter from the resolved paths it already tracks, so relative discovery paths remain usable outside the process cwd.
- `packages/coding-agent/src/core/extensions/builtin/index.ts` registers `herdr` immediately after `ask-user`. The builtin reads the host list at session start, inspects only the first 400 bytes of matching reporter files, and defers only to user-authored reporters. `docs/extensions.md` documents the handoff and coexistence policy.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` exposes the discovery result without making older hand-built contexts incompatible.
- `packages/coding-agent/src/core/extensions/runner.ts` includes loaded event-only extensions that would be invisible to tool/command enumeration; otherwise a user reporter and the builtin could compete for pane state.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` defines the host-owned contract; extension factories cannot inspect co-loaded extensions themselves.
- `packages/coding-agent/src/core/extensions/runner.ts` owns discovery identities and context lifetime guards. The lifecycle reporter itself remains an extension, not a new host service.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.agentDir` neighbors; keep the field optional and read-only.
- `packages/coding-agent/src/core/extensions/runner.ts`: `createContext()` getter list; preserve `assertActive()` and resolved paths.
- `packages/coding-agent/src/core/extensions/builtin/index.ts`: imports and the registration after `ask-user`; retain other builtin ordering.


## 2026-09-13 - Optional authoritative session goal-store path (senpi#1663)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds optional read-only `ExtensionContext.goalStoreFile`, preserving source compatibility for hand-built contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` implements the guarded lazy getter in `createContext()` using `goalFilePath(goalStoreRef(runner.sessionManager, runner.cwd))`. Reading it does not create a file. Persisted sessions honor session-directory overrides; in-memory sessions use the cwd-hashed no-session bucket.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` gives shell tools and eval kernels a shared authoritative path to expose as `PI_GOAL_STORE_FILE`, alongside `ctx.cwd` as `PI_SESSION_CWD`.
- `packages/coding-agent/src/core/extensions/runner.ts` resolves that path from the actual session manager and cwd rather than letting consumers guess from a session JSONL filename, which is insufficient for overridden directories and in-memory sessions.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` owns the public host-context contract; an extension cannot add a getter available to every other extension and core tool.
- `packages/coding-agent/src/core/extensions/runner.ts` owns context creation and lifecycle guards. Resolving the path there avoids duplicate consumer-specific storage logic and rejects stale contexts consistently.

### Expected merge conflict zones

- LOW: the `ExtensionContext.sessionManager` neighborhood in `packages/coding-agent/src/core/extensions/types.ts`.
- LOW: the goal persistence imports and `createContext()` getter list in `packages/coding-agent/src/core/extensions/runner.ts`. Preserve the optional public field and `assertActive()` guard.

### Tests

- `packages/coding-agent/test/suite/session-goal-store-context.test.ts`: persisted, `SessionManager.open(path, otherSessionDir)`, and in-memory paths; getter reads do not create files.
- `packages/coding-agent/test/sdk-session-manager.test.ts`: SDK-created session paths reach the registered bash tool.
- `packages/senpi-codemode/test/extension-session-env.test.ts`: runtime creation forwards cwd and the optional goal-store path from the extension context.



## 2026-09-13 - Pending-question arrival and blocked bus contracts (senpi#1645)

### What changed

- `packages/coding-agent/docs/extensions.md` documents `ask-user:asked` and `herdr:blocked` on the existing extension bus: fresh registration, per-ID active/inactive pairs, both wait modes, and transport replay suppression. No public lifecycle-event union or transport frame changes are required.

### Why

- Status and Notification integrations must distinguish a fresh question from UI hydration and retain blocked state while any request remains pending.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/builtin/ask-user/tool.ts` owns registration and authoritative settlement; `packages/coding-agent/src/modes/interactive/interactive-mode.ts` owns host dialog lifetimes. A consuming extension cannot infer these boundaries reliably from tool-return text.

### Expected merge conflict zones

- `packages/coding-agent/docs/extensions.md`: lifecycle events section. Implementation details are tracked in `builtin/changes.md` and `modes/interactive/changes.md`.


## 2026-09-13 - `resources_discover` advertises scoped-entry support (senpi#1655)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ResourcesDiscoverEvent` gains `scopedEntries: true`, the capability signal that the host accepts `{ path, scope }` entries (senpi#1640) in the result.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitResourcesDiscover` constructs the event with `scopedEntries: true`.
- Docs: `docs/extensions.md` shows a handler that returns the object form only when the field is present.

### Why

- A host that predates scoped entries treats an object entry as a path string and aborts session start (`input.trim is not a function` from `resolvePath`), so a distribution extension that must load on both old and new engines had no safe way to use the scoped form. The event field is the feature-detect: absent on old hosts, `true` here.

### Why an extension could not handle it

- Only the host knows which entry forms its runner accepts; an extension cannot probe the runner without crashing an old host, and engine version strings do not identify dev builds that already carry the feature.

### Expected merge conflict zones

- LOW: the `ResourcesDiscoverEvent` interface in `types.ts` and the event literal inside `emitResourcesDiscover` in `runner.ts`; both sit beside the senpi#1640 changes.

## 2026-09-13 - Native compiled-Bun extension importer

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts` creates an asynchronous batch importer only on cache misses: compiled Bun lazily loads its native transformer, while Node lazily imports `jiti/static` through a variable specifier. Node SEA, bundled Node, source TypeScript and unbundled Node retain their existing options and `moduleCache: false`. Live runtimes retain factory wrappers until invalidation, independently of the existing per-cwd factory cache.
- `packages/coding-agent/src/core/extensions/bun-extension-importer.ts` uses synchronous Bun transpilation plus parsed import-expression rewriting so static imports, computed imports and computed requires resolve from each real file directory into one generation. Native data and addon paths remain in the file namespace. Real-file import metadata is preserved.
- `packages/coding-agent/src/core/extensions/bun-extension-registry.ts` owns one shared runtime hook set with weak generation references, explicit disposal and finalization. Permanent module callbacks never capture a graph; reachable factory wrappers keep old dynamic imports usable.
- `packages/coding-agent/src/core/extensions/bun-extension-error.ts` retains Bun parser diagnostics with real-file attribution and source positions instead of reducing them to an aggregate message.

### Why

- `packages/coding-agent/src/core/extensions/loader.ts` previously put jiti's transformer in the standalone compiled graph. Fresh root imports alone would leave helpers stale and duplicate host modules would break reference identity. Per-generation permanent plugin closures leak graph state; computed edges must not escape to the native global module cache.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/loader.ts` chooses the importer before extension code can run. Generation isolation and host namespace registration belong to that host-owned boundary.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/loader.ts`: importer type, lazy runtime branch, runtime invalidation, asynchronous batch cache and import call. The Node option branches and per-cwd factory cache policy must remain intact. The Bun importer, registry and diagnostic modules are fork-owned.

## 2026-09-13 - Optional steering-specific tool signal (senpi#1637)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds optional read-only `ExtensionContext.steeringSignal`, separate from cancellation.
- `packages/coding-agent/src/core/extensions/wrapper.ts` accepts an optional invocation-context factory and disposes its scope in `finally`, including thrown and detached results. Callers without the factory retain their prior context behavior.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` lets foreground tools observe steering without polling or cancelling work.
- `packages/coding-agent/src/core/extensions/wrapper.ts` is the shared invocation boundary for built-in and extension tools, so it can remove session-owned subscriptions at settlement.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` defines the host-owned context contract.
- `packages/coding-agent/src/core/extensions/wrapper.ts` adapts every registered tool before execution, outside an individual extension's lifecycle.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.signal` neighbours.
- `packages/coding-agent/src/core/extensions/wrapper.ts`: wrapper signatures and the execute call; tool-result metadata handling remains unchanged.

## 2026-09-13 - `system` scope for builtin extensions and scoped `resources_discover` entries (senpi#1640)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts`: `createExtension` passes `scope: source === "builtin" ? "system" : "temporary"` to `createSyntheticSourceInfo`, so a `<builtin:*>` extension starts out as `system` instead of `temporary`.
- `packages/coding-agent/src/core/extensions/types.ts`: new `ResourceDiscoverEntry = string | { path: string; scope?: SourceScope }`; `ResourcesDiscoverResult.skillPaths` / `promptPaths` / `themePaths` / `hookPaths` are `ResourceDiscoverEntry[]` instead of `string[]`. A bare string inherits its scope from the contributor; the object form pins it.
- `packages/coding-agent/src/core/extensions/runner.ts`: `emitResourcesDiscover` returns `DiscoveredResourceEntry[]` (`{ path, extensionPath, scope? }`, from the fork-only `packages/coding-agent/src/core/discovered-resource-scope.ts`) and normalises each handler entry through a local `toEntry`, keeping `scope` only when the handler set one. `agent-session.ts` resolves the final scope with `resolveDiscoveredResourcePaths`.

### Why

- Builtin extensions are part of the harness and should carry the new `system` scope from creation, and a system extension that surfaces user-owned data (for example a skills directory under the home folder) needs a way to say those paths are `user`, not `system`.

### Why an extension could not handle it

- The loader owns the synthetic source info of builtins, and the runner owns the shape of `resources_discover` results before `agent-session.ts` sees them. An extension can only fill in the entries; it cannot widen the result type or re-scope its own registration.

### Expected merge conflict zones

- MEDIUM: `emitResourcesDiscover` in `packages/coding-agent/src/core/extensions/runner.ts` (return type, the four accumulator arrays, `toEntry` and the four `push` lines).
- LOW: `ResourceDiscoverEntry` / `ResourcesDiscoverResult` and the `SourceScope` import in `packages/coding-agent/src/core/extensions/types.ts`; the `createSyntheticSourceInfo` call in `createExtension` in `packages/coding-agent/src/core/extensions/loader.ts`.

## 2026-09-10 - ctx.editAssistantMessage

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionCommandContext.editAssistantMessage(entryId, text, options?)` and the matching required member on `ExtensionCommandContextActions`.
- `packages/coding-agent/src/core/extensions/runner.ts`: `EditAssistantMessageHandler`, the `editAssistantMessageHandler` field bound from `actions.editAssistantMessage`, and its context injection beside `navigateTree`.

### Why

- Extensions could navigate the tree but not replace an assistant response; the desktop and scripted clients need the same operation the TUI has.

### Why an extension could not handle it

- Extensions cannot add members to their own context; the runner owns the binding.

### Expected merge conflict zones

- LOW: the `navigateTree` neighbours in `types.ts` (two declaration sites) and `runner.ts` (field, bind, inject).

## 2026-09-10 - Optional ExtensionUIContext.question prompt kind

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: exports canonical `QuestionRequest` / `QuestionResponse`, adds optional `ExtensionUIContext.question()`, and extends `UIPromptKind` with `"question"`.
- `packages/coding-agent/src/core/extensions/runner.ts`: `wrapUIPromptContext` wraps `question` with `withUIPrompt("question", request.questions[0]?.header, ...)` only when the underlying UI provides it.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` is the public extension UI contract; later ask-user modes need a typed optional prompt without breaking hand-built `Pick<ExtensionUIContext, ...>` contexts.
- `packages/coding-agent/src/core/extensions/runner.ts` already emits `ui_prompt_start` / `ui_prompt_end` around select/confirm/input/editor/custom; question prompts must use the same wrapping so the runner can pause on a blocking user-facing question.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` defines the host-owned UI surface; extensions cannot add methods to that public contract themselves.
- `packages/coding-agent/src/core/extensions/runner.ts` owns prompt wrapping and event emission before any extension sees `ctx.ui`.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIContext` dialog methods (~select/confirm/input) and the `UIPromptKind` union.
- `packages/coding-agent/src/core/extensions/runner.ts`: `wrapUIPromptContext`.

## 2026-09-10 - Expose getAskUserSettings on ExtensionContext

### What changed

- `types.ts`: optional `ExtensionContext.getAskUserSettings()` / `ExtensionContextActions.getAskUserSettings` return `{ enabled, timeoutMinutes }` (optional so hand-built contexts and test stubs stay valid).
- `runner.ts`: default `{ enabled: true, timeoutMinutes: 30 }`, bindCore plumbing next to `getLookAtSettings`, and the live context accessor.

### Why

- Built-in question tooling (todo 7) must read the resolved ask-user enable/timeout from the same context surface as look-at settings.

### Why an extension could not handle it

- `types.ts` and `runner.ts` define and bind the host-owned context; extensions cannot add accessors to that contract.

### Expected merge conflict zones

- MEDIUM: `types.ts` accessor declarations next to `getLookAtSettings` (todo 3 edits the UI-context region of the same file).
- MEDIUM: `runner.ts` bindCore/createContext plumbing next to `getLookAtSettings` (todo 3 edits `wrapUIPromptContext`).

## 2026-09-09 - Expose shared-host policy during extension registration

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` adds the read-only `ExtensionAPI.sharedHostEnabled` capability.
- `packages/coding-agent/src/core/extensions/loader.ts` forwards the loading policy into extension factories.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` lets RPC-dependent tools distinguish enabled and disabled hosts before registering.
- `packages/coding-agent/src/core/extensions/loader.ts` makes the decision available before a factory registers searchable tools.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` defines the host-owned registration API.
- `packages/coding-agent/src/core/extensions/loader.ts` constructs that API before session events or bound runtime actions are available.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/types.ts`: registration-time context fields.
- `packages/coding-agent/src/core/extensions/loader.ts`: factory initialization and loading options.

## 2026-09-09 - Register compact read classifiers through the extension API

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: adds `ExtensionAPI.registerReadClassifier(classifier): () => void`, using the shared `ReadClassifier` type.
- `packages/coding-agent/src/core/extensions/loader.ts`: registers classifiers in the shared read registry and returns a tracked unregister function. Failed factory loads and runtime invalidation remove their registrations; stale APIs cannot register new classifiers.

### Why

- `packages/coding-agent/src/core/extensions/types.ts` gives extensions a typed way to classify memory paths without replacing the built-in read tool.
- `packages/coding-agent/src/core/extensions/loader.ts` connects that API to the renderer's registry while preserving the existing failed-load and reload cleanup lifecycle.

### Why an extension could not handle it

- `packages/coding-agent/src/core/extensions/types.ts` defines the host-provided API; extensions cannot add methods to that public contract themselves.
- `packages/coding-agent/src/core/extensions/loader.ts` owns API construction and runtime cleanup, so it must wire registrations into the shared registry and remove them when their owner becomes inactive.

### Expected merge conflict zones

- LOW: the `ReadClassifier` import and the rendering-registration methods next to `registerEntryRenderer` in `packages/coding-agent/src/core/extensions/types.ts`.
- LOW: the registry import and `createExtensionAPI` registration block in `packages/coding-agent/src/core/extensions/loader.ts`.

## 2026-09-08 - Runner fallback for the goal backstop setting follows the 270s default

### What changed

- `runner.ts`: the `getPromptCacheGoalBackstopMaxSecondsFn` placeholder (used until the session wires `SettingsManager.getPromptCacheGoalBackstopMaxSeconds`) returns 270 instead of 3570, matching the new `promptCache.goalBackstopMaxSeconds` default.

### Why

- The goal monitor re-checks a parked goal every backstop interval so a wake source that never delivers cannot strand it for an hour; a host that has not wired the settings getter must arm the same 270s floor. See `builtin/goal/changes.md` (2026-09-08).

### Why an extension could not handle it

- The placeholder is the runner's own default for the extension context action; extensions only read the resolved value.

### Expected merge conflict zones

- LOW: the single `getPromptCacheGoalBackstopMaxSecondsFn` initializer in `runner.ts`.

## 2026-09-08 - Expose the effective service tier and let core carry it (code-yeongyu/oh-my-openagent#6795)

### What changed

- `types.ts`: `ExtensionContext.effectiveServiceTier` (optional) reports the tier the session's requests carry right now - `serviceTier` promoted to `"priority"` while session fast mode is on. `ExtensionContextActions.getEffectiveServiceTier` (optional) feeds it; `runner.ts` falls back to `getServiceTier` when a host omits it.
- `builtin/service-tier.ts`: exports `supportsServiceTier(api)`. On `model_select`, a remembered `"auto"` for a Codex model whose catalog says priority now also clears the SESSION's cached tier (`setSessionFastMode(false)`, which only touches a catalog-inherited Codex priority), instead of suppressing the tier in the payload hook alone.

### Why

- The session itself now puts `effectiveServiceTier` on the request (`core/sdk.ts`), so the extension's memory decision has to reach session state or the two writers would disagree after a mid-session switch. Hosts that delegate work (oh-my-openagent tasks) need the effective tier, not the catalog tier, to inherit a parent's `/fast`.

### Why an extension could not handle it

- Both are context surface: what the runner exposes to extensions, and how the builtin keeps the session's request-side tier honest.

### Expected merge conflict zones

- LOW: `ExtensionContext`/`ExtensionContextActions` in `types.ts`, the context getters in `runner.ts`, the `model_select` handler in `builtin/service-tier.ts`.


## 2026-09-04 - UI prompt lifecycle events

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: the extension UI context's blocking prompts (select, confirm, input, editor, custom) are wrapped with depth tracking; the outermost prompt emits `ui_prompt_start` and, when it settles, `ui_prompt_end`, queued via microtask so handlers cannot delay the prompt itself (upstream ccfe79ed2, #8355).
- `packages/coding-agent/src/core/extensions/types.ts`: adds `UIPromptKind`, `UIPromptStartEvent`, and `UIPromptEndEvent` to the event union and `on` overloads, and clarifies that `setModel` and `setThinkingLevel` change the current session without changing the configured default for new sessions (upstream 8d1b1178c, #9009).
- `packages/coding-agent/src/core/extensions/index.ts`: re-exports the new event types.

### Why

- RPC and UI hosts need to know when the agent is blocked on an extension-driven prompt to render a waiting state and to distinguish prompt-waits from model-waits; the runner is the only component that sees every nesting level of those prompts.

### Why an extension could not handle it

- The events describe the runner's own UI context; an extension cannot observe prompts issued by other extensions, and the emitting path must not let handlers delay the prompt they describe.

### Expected merge conflict zones

- MEDIUM: `packages/coding-agent/src/core/extensions/runner.ts` UI-context wrapping and depth tracking; LOW: `packages/coding-agent/src/core/extensions/types.ts` event union and `packages/coding-agent/src/core/extensions/index.ts` export list.


## Expose the extension event bus for session activity signals (2026-08-31)

### What changed

- `runner.ts`: `ExtensionRunner.onBusEvent(channel, handler)` subscribes to a raw bus channel and returns an unsubscribe, mirroring the existing `onRpcEvent` helper.

### Why

- The session must observe `wake_source_state` publications (background terminal jobs, terminal monitors, loop-guard holds) to know whether work outlives the current turn; the shared RPC host's idle eviction consults that through `AgentSession.isSessionBusy`. The bus was private to the runner, so the session had no way to read activity extensions already publish.

### Why an extension could not handle it

- The subscription is made by the session that owns the runner, beneath every extension surface; an extension cannot grant the host visibility into another extension's activity.

### Expected merge conflict zones

- LOW: the accessor block next to `onRpcEvent` in `runner.ts`.


## Builtin /account command (2026-08-27)

### What changed

- `packages/coding-agent/src/core/extensions/builtin/account/index.ts` (new) registered as builtin `account`: `/account <provider> [list | pin <name> | unpin | remove <name>]` over `core/credential-accounts.ts`, for every provider. Output carries account names and health only. Existing lane commands (`/claude-account`, cursor accounts) are untouched.

### Why

- Pool management needs one first-class TUI entry point that is not tied to a single provider lane.

### Why an extension could not handle it

- It IS an extension; it ships builtin so every install has the command without configuration.

### Expected merge conflict zones

- LOW: one import + one registration line in `builtin/index.ts`.


## Extension contracts re-diverge from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/core/extensions/index.ts` keeps fork exports: MCP server declarations,
  tool-hook lifecycle types, execute-tool contracts, filesystem policy, and extension RPC handlers.
- `packages/coding-agent/src/core/extensions/loader.ts` keeps the `@code-yeongyu/senpi` bundled
  alias, extension RPC event-bus channels, MCP declaration validation, and the cwd-scoped cache.
- `packages/coding-agent/src/core/extensions/types.ts` keeps service tiers, compaction
  reasons/rejection causes, warm-anchor snapshots, and initial-model provenance on the extension API.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- Export lists of `packages/coding-agent/src/core/extensions/index.ts` and the type unions in
  `packages/coding-agent/src/core/extensions/types.ts`.

## 2026-08-25 - Expose provider watchdog abort ownership

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: adds `"provider"` to `AgentEndEvent.abortSource`.

### Why

- Extensions must distinguish provider watchdog cancellation from user and system aborts when handling terminal turns.

### Why an extension could not handle it

- This is the extension event contract itself and must be typed by the host before handlers run.

### Expected merge conflict zones

- LOW: `AgentEndEvent.abortSource` in `types.ts`.

## 2026-08-19 - ProviderConfig.fallbackEligible: deterministic gate for implicit fallback expansion

### What changed

- `types.ts` (`ProviderConfig`) and `core/provider-composer.ts` (`ProviderConfigInput`) gained optional
  `fallbackEligible?(): boolean`. A provider registration may declare its lane deterministically unusable
  (for example an unacknowledged approval gate); bare-family fallback expansion then skips it while the
  provider stays registered, explicitly selectable, and visible to `/login`.
- `core/model-runtime.ts` exposes `isFallbackEligible(providerId)` (hookless providers and throwing hooks
  stay eligible), `core/model-registry.ts` forwards it per model, and `core/retry-fallback/`
  (`expansion.ts`, `chains.ts`, `controller.ts`) filters bare expansion on a definitive `false` only.
- `builtin/cursor-cli-oauth` declares ineligibility while the kill switch is set or the unacknowledged
  `--force` gate guarantees a refusal (`cursorCliForceRefusalPending`, shared with the execution policy).
  `builtin/claude-sdk-oauth` declares ineligibility under its verbatim `enabled: false` kill switch.

### Why

- Bare expansion ranked OAuth-credential providers first but never asked whether the lane could execute.
  A credentialed cursor-cli-oauth lane whose `noApprovalAcknowledgedAt` was never set ranked tier 0,
  entered shipped default chains (`claude-opus-5:xhigh`), and every fallback hop into it hard-errored
  with the acknowledgement message - a guaranteed-refusal lane consumed a slot it could never serve.

### Why an extension could not handle it

- Expansion runs inside `core/retry-fallback/` against the model registry; no extension hook observes or
  filters chain canonicalization. The eligibility signal itself, however, stays extension-owned via the
  new registration field.

### Expected merge conflict zones

- `types.ts` end of `ProviderConfig`; `provider-composer.ts` end of `ProviderConfigInput`;
  `model-runtime.ts` near `hasConfiguredAuth`; `retry-fallback/expansion.ts` `FallbackAuthTiers` and the
  `rankFamilyModels` filter loop; `retry-fallback/chains.ts` `FallbackModelLookup`/`authTiers`.

## Extension-system overlays retained over upstream 59a71b23 (2026-08-19)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts` keeps the fork extension contract on top of upstream pin
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`: the `app-server` `ExtensionMode`, the filesystem-policy types
  (`FilesystemOperation`, `FilesystemPolicyRequest`, `FilesystemPolicyDecision`, `FilesystemPolicy`,
  `FilesystemPolicyChecker`), `ServiceTier` and the `-fast` tier surface, the compaction contract
  (`CompactionReason`, `CompactionRejectionCause`, `ApplyCompactionOptions` with `expectedWarmAnchor`,
  begin/update/end options), `ExtensionSessionSettings` for retry fallback, `executeTool` with
  `ExecuteToolError`/`ExecuteToolErrorCode`, lazy tool activation and removed-tool hints, MCP server
  declarations, the `rpc` emit/handle surface, hook-source and tool-hook-status accessors, and
  `prepareProviderRequest`.
- `packages/coding-agent/src/core/extensions/loader.ts` keeps the fork loader: per-cwd LRU factory cache
  (`extensionCacheByCwd`, `MAX_EXTENSION_CACHE_CWD_ENTRIES`) instead of upstream's single global cwd cache, the
  `@code-yeongyu/senpi` virtual module and alias, bundled-then-workspace-then-source entry resolution
  (`resolveWorkspaceOrBundled`) with a `require.resolve` fallback where `import.meta.resolve` is unavailable,
  `alias: getAliases()` also applied on the TypeScript source runtime, one shared jiti importer per batch, the
  injectable `ExtensionFactoryResolver`, `drainPendingProviderRegistrations()` order-stamped provider queues, the
  reserved `tool_search` tool name, and the registration surfaces for lazy activators, removed-tool hints,
  filesystem policies, MCP servers, `executeTool`, session model/thinking/fast-mode setters, and RPC
  emit/handle. Upstream's Node SEA extension-loading branch (`isNodeSeaBinary` → virtual modules,
  `tryNative: false`) arrived with this sync and is preserved.
- `packages/coding-agent/src/core/extensions/index.ts` keeps re-exporting those fork-only members
  (`McpServerDeclaration`, tool-hook lifecycle types, `ExecuteTool*`, filesystem-policy types,
  `ExtensionRpcRequestHandler`, `InputDispositionEvent`, `ModelSelectEventResult`, `SystemPromptChangeEvent`,
  `ExecuteToolError`, `RUNTIME_EXTENSION_PATH`).

### Why

- The fork owns extension lifecycle and its public API: multi-session hosts need per-cwd factory caching, the
  senpi package name must resolve for extensions written against it, and fork features (filesystem policy, MCP
  declarations, tool hooks, service tiers, compaction admission, extension RPC) have no upstream contract. The pin
  advance restored upstream's narrower loader and types around them, so these overlays remain divergent.

### Why an extension could not handle it

- This is the loader and the type contract extensions are written against; both must exist before any extension
  code runs.

### Expected merge conflict zones

- MEDIUM: `loader.ts` `getAliases()`/`createExtensionModuleImporter()` (upstream changes runtime detection here,
  as this sync's SEA branch did) and `createExtensionAPI()` registration list; `types.ts` `ExtensionContext` and
  `ExtensionAPI` member lists.
- LOW: `index.ts` alphabetized re-export blocks.

## Repository audit baseline for the extensions tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`). The audited production paths whose exact nearest tracker is this file:
  `packages/coding-agent/src/core/extensions/index.ts`, `packages/coding-agent/src/core/extensions/loader.ts`,
  `packages/coding-agent/src/core/extensions/runner.ts`, and `packages/coding-agent/src/core/extensions/types.ts`.
- Per-file divergence history for the public API surface (events, context getters, RPC, lazy activation, compaction
  admission) is preserved in the dated entries below; fork-only additions in this directory (`AGENTS.md`, `wrapper.ts`,
  `notice/`) are absent from the pinned upstream tree and therefore exempt from the audit.

### Why

- The audit requires every upstream-owned production divergence to be covered by one entry with all four canonical
  sections in its exact nearest tracker. Most entries below predate the gate and are not parseable in canonical form,
  so this inventory anchors the four modified files without rewriting accurate history.

### Why an extension could not handle it

- Tracker coverage is repository and release policy, not runtime behavior; it is enforced by repository scripts before
  any extension loader exists.

### Expected merge conflict zones

- NONE: this tracker is fork-only (upstream has no counterpart file); the inventory names pin-relative paths so it
  stays valid as entries below change.

## Extension loader per-CWD LRU factory cache and Senpi alias (2026-08-17)

### What changed

- `loader.ts`: the extension factory cache is scoped per working directory. Upstream kept one global `extensionCache`
  plus a single `extensionCacheCwd`; any different cwd cleared the entire cache and bumped one global generation. The
  fork replaces that with `extensionCacheByCwd`, a map of per-cwd `ExtensionCacheEntry` (`cwd`, `generation`,
  `factories`) bounded by `MAX_EXTENSION_CACHE_CWD_ENTRIES = 16`: a cache hit re-inserts the entry to mark it most
  recently used, a miss evicts the least recently used cwd, and each new entry is stamped from the monotonic
  `nextExtensionCacheGeneration` so `isCurrentCacheToken()` still rejects factories held by an evicted or cleared
  entry. `clearExtensionCache()` drops all entries; `loadExtensionsCached()` remains the cached entry point and
  `loadExtensions()` keeps fresh-source semantics (`moduleCache: false`, one shared jiti importer per batch).
- `loader.ts`: `@code-yeongyu/senpi` is a first-class alias for the coding-agent package — mapped to the bundled
  module in `VIRTUAL_MODULES` and to the resolved dist-or-source entry in `getAliases()` — alongside the existing
  `@earendil-works/pi-coding-agent` and `@mariozechner/pi-coding-agent` spellings.

### Why

- The module-level cache is process state shared by every session a host runs; with upstream's clear-on-switch
  behavior, a host alternating sessions across project roots re-paid jiti's per-extension TypeScript resolution cost
  on every cwd change. A bounded per-cwd LRU keeps recently used roots warm without unbounded growth.
- Extensions published under the fork's package name import `@code-yeongyu/senpi`; without the alias jiti resolves
  that specifier from the extension's own `node_modules`, pulling a duplicate runtime and breaking identity
  expectations — the same failure mode the `@mariozechner/pi-*` alias exists to prevent.

### Why an extension could not handle it

- The cache and alias table live inside the loader that resolves extension factories themselves; no extension can
  observe or replace its own import-path resolution.

### Expected merge conflict zones

- MEDIUM: `loader.ts` cache block (`MAX_EXTENSION_CACHE_CWD_ENTRIES`, `ExtensionCacheEntry`, `useExtensionCacheCwd()`,
  `loadExtensionModule()`) — upstream still maintains the single-slot cache there.
- LOW: the two `@code-yeongyu/senpi` lines in `VIRTUAL_MODULES` and `getAliases()`; additive keys beside upstream's.

## Runner tool-hook lifecycle and status reporting (2026-08-17)

### What changed

- `runner.ts`: every `tool_call` (`PreToolUse`) and `tool_result` (`PostToolUse`) handler invocation is wrapped in a
  lifecycle run. `beginToolHookRun()` assigns `hookRunId` (`<toolCallId>:<hookName>:<run index>`), emits a `start`
  event, and hands the handler a context whose `ctx.updateToolHookStatus(update)` emits `update` events with a
  sanitized message; the run closes with an `end` event carrying terminal status `completed`, `blocked` (a
  `ToolCallEventResult.block` veto won), or `failed` (handler threw) plus the error message.
- `runner.ts`: hosts observe the stream through `setToolHookLifecycleObserver()` receiving
  `ExtensionToolHookLifecycleEvent`. Default status text comes from `getToolHookStatusMessage()` — `running <extension
  name>`, or the compaction/tool-result-size checks the builtin hooks extension performs — and
  `sanitizedToolHookStatusMessage()` bounds every message to 79 characters after stripping ANSI, control characters,
  and collapsed whitespace.

### Why

- Interactive hosts had no per-hook progress signal while PreToolUse/PostToolUse handlers ran, so a slow permission or
  compaction hook was indistinguishable from a hung tool call. Lifecycle phases plus a bounded, sanitized status line
  let the host surface which extension hook is running and how the run ended.

### Why an extension could not handle it

- The stream must be emitted by the runner that dispatches the hooks; an extension cannot observe another extension's
  hook dispatch or reach the host's status surface for it.

### Expected merge conflict zones

- MEDIUM: `runner.ts` `emitToolCall()` / `emitToolResult()` handler loops and the `beginToolHookRun()` block —
  upstream owns the dispatch loops and rewrites them when event-result shapes change.
- LOW: `ExtensionToolHookLifecycleEvent` / `ExtensionToolHookLifecycleObserver` / `setToolHookLifecycleObserver()`;
  fork-owned additive surface.

## Extension RPC event forwarding onto the shared session bus (2026-08-17)

### What changed

- `loader.ts`: `pi.rpc.emit(name, data)` (absent from the pinned upstream loader) validates a non-empty trimmed name
  and publishes an `ExtensionRpcEvent` (`{ name, data }`) on the session's shared event bus under the reserved
  `EXTENSION_RPC_EVENT_CHANNEL` exported from `core/event-bus.ts`, so extension-originated events reach RPC hosts
  through one named channel instead of each extension writing to a transport. `pi.rpc.handle()` /
  `ExtensionRunner.requestRpc()` form the request/response counterpart (2026-08-12 entries below).
- `pi.events.emit/on` keep forwarding extension-local pub/sub onto the same shared bus with generation-tracked
  subscriptions that `runtime.invalidate()` tears down (upstream-owned contract, unchanged).

### Why

- Extensions needed a first-class way to raise events that RPC/TUI consumers observe without the extension holding a
  transport, and hosts needed one channel contract to subscribe to rather than per-extension delivery paths.

### Why an extension could not handle it

- The event bus is constructed by core before extensions load and handed into `loadExtensions()`; only the loader can
  wire each extension's `rpc` surface onto it.

### Expected merge conflict zones

- LOW: `loader.ts` `createExtensionAPI()` `rpc` arm and the `EXTENSION_RPC_EVENT_CHANNEL` import; the channel constant
  itself is fork-owned in `core/event-bus.ts` (core tracker, 2026-08-17).

## 2026-08-17 - getSystemPromptOptions exposed on the base ExtensionContext

### What changed

- `ExtensionContext` gains OPTIONAL `getSystemPromptOptions?(): BuildSystemPromptOptions`, so event handlers (not just command handlers) can read the base system-prompt construction options. It stays REQUIRED on `ExtensionCommandContext` (now a redeclaration that narrows the optional base member), so existing command-handler callers are unaffected and hand-built test contexts keep compiling.
- `runner.ts` binds the getter in `createContext()` (it always exists at runtime under the senpi runner); the duplicate binding in `createCommandContext()` is removed because the descriptor copy carries it.
- The returned options now include the user-override fields already present on `BuildSystemPromptOptions`: `customPrompt` (from `--system-prompt` / SDK loader) and `appendSystemPrompt` (pre-joined `--append-system-prompt` texts), populated by `agent-session.ts` `_rebuildSystemPrompt()`.

### Why

- The prompt-preset builtin must know at `session_start` (header) and in prompt events whether the user supplied an explicit system prompt, so presets yield instead of clobbering it. Per convention, new core data lands as a typed `ExtensionContext` getter; optional-on-base keeps the ~30 hand-built `ExtensionContext` fakes across coding-agent and senpi-codemode tests source-compatible.

### Expected merge-conflict zones

- `types.ts` `ExtensionContext` / `ExtensionCommandContext` member lists; `runner.ts` `createContext()` tail. Resolution: keep the optional base getter plus the required command-context redeclaration.

## 2026-08-13 - Content-anchored compaction admission

### What changed

- `ApplyCompactionOptions` gains optional `expectedWarmAnchor` (`WarmAnchorSnapshot` from
  `core/compaction/warm-anchor.ts`): the anchor entry id, the prefix entry ids it covers, and the
  latest compaction entry id observed when the summary was generated. The host accepts it as an
  alternative to `expectedRevision` when admitting a precomputed compaction.

### Why

`expectedRevision` conflates appended messages with rewritten history, so every warm
speculative summary went stale after any idle-time append. The anchor lets the host admit a
warm summary whose summarized prefix is still intact, while still rejecting one whose history
was rewritten.

### Expected merge-conflict zones

- `types.ts` `ApplyCompactionOptions`.

## 2026-08-12 - Expose session cwd during extension registration

### What changed

- `ExtensionAPI.cwd` exposes the absolute cwd of the session that loaded the extension instance.

### Why

- Extension factories may need to initialize per-project state at registration time, before any event
  supplies an `ExtensionContext`.
- In multi-session hosts, `process.cwd()` is the shared process launch directory rather than the
  project root for each extension instance.

### Expected merge conflict zones

- LOW: `types.ts` ExtensionAPI interface, `loader.ts` createExtensionAPI return literal.

## 2026-08-12 - Reject stale in-flight RPC request results

### What changed

- `ExtensionRunner.requestRpc()` re-checks generation liveness after an asynchronous handler
  completes, so a result cannot escape after reload or replacement invalidates its owner.
- Focused tests cover both explicit mid-flight invalidation and a real session reload.

### Why

- Entry-time liveness alone allowed a slow handler from generation N to return successfully after
  generation N+1 became active.

### Expected merge conflict zones

- LOW: `runner.ts` request dispatch and its RPC request suite.

## 2026-08-12 - Extension-owned RPC request handlers

### What changed

- `pi.rpc.handle(name, handler)` registers structured client-to-extension request handlers on the
  loaded extension generation.
- `ExtensionRunner.requestRpc()` requires exactly one active handler and rejects unknown,
  duplicate, empty, and stale-generation requests without invoking the model.
- `pi.rpc.emit()` now also checks generation liveness before publishing.

### Why

- RPC clients need a direct, typed control path for extension-owned runtime state; encoding controls
  as slash-command prompts would involve the model and lose request/response semantics.
- Per-generation ownership prevents captured handlers from surviving extension replacement or
  reload.

### Expected merge conflict zones

- LOW: `types.ts`, `loader.ts`, and `runner.ts` RPC extension surfaces.

## 2026-08-11 - Native-deferred catalog tools activate at call time

### What changed

- The shared tool-search builtin injects inactive searchable extension schemas into Anthropic Messages payloads with native `defer_loading` metadata.
- AgentSession resolves a model call for an inactive catalog member through the existing shared lazy-promotion path, then returns the newly active tool to agent-core for normal execution.
- Non-catalog names and lazy-activation-gated definitions retain the existing unknown-tool result.

### Why

- Native provider search may return a tool call for a schema that was intentionally absent from the agent context snapshot; activation must happen between tool-name lookup and argument preparation.
- Reusing catalog promotion keeps call-time activation aligned with local `tool_search` and eval/code-mode behavior.

### Why this cannot be expressed externally

- The model call reaches agent-core before extension tool hooks run, while registry activation and winning-definition resolution are session-owned operations.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` agent tool-hook installation.
- MEDIUM: tool-search provider-request wiring.

## 2026-08-11 - Deferred tool-search registration and MCP catalog activation

### What changed

- The tool-search builtin owns the single reserved `tool_search` definition but defers registering it until the shared catalog first contains a searchable document; sessions whose catalog stays empty never register or activate it.
- Once registered, `tool_search` is active only while searchable documents exist. If the catalog later empties, the definition remains registered because the extension API has no unregister operation, but it is removed from the active set.
- The session-scoped service accepts MCP documents and activation hooks, lazily activates either catalog source, and rehydrates v2 plus legacy MCP markers once per catalog generation.
- Generic searches no longer default to the MCP source; only the legacy `server` argument maps to `source: "mcp"` plus the equivalent group filter.

### Why

- Atomic ownership and feeder activation avoid duplicate builtin precedence while preserving model-visible MCP behavior and enabling extension tools through the same search surface.
- Deferred first registration gives sessions that never gain a searchable catalog zero registry and prompt cost, including `noTools: "all"` sessions, while active-set removal preserves zero prompt cost if a populated catalog later empties.

### Why this cannot be expressed externally

- The service coordinates inactive registered tools, active-set replacement, session history, and MCP-owned stub swapping across builtin boundaries.

### Expected merge conflict zones

- HIGH: tool-search `index.ts`/`service.ts` registration and MCP feeder integration.
- MEDIUM: shared search tool tests and MCP lifecycle fixtures.

## 2026-08-11 - Lazy activation honors per-tool hard stops

### What changed

- `executeTool(..., { activateInactiveTool: true })` now checks the winning definition before invoking lazy activators.
- Definitions with `allowLazyActivation: false` return the existing `inactive_tool` error without calling any activator.
- Default-enabled lazy activation and explicit `setActiveTools()` activation retain their existing behavior.

### Why

- The declarative hard stop must apply before extension or shared-search activators can produce side effects.
- Already-active tools remain executable because the flag governs lazy promotion, not active-set permissions.

### Why this cannot be expressed externally

- Core owns winning-definition resolution and the ordered lazy-activator dispatch used by every execution caller.

### Expected merge conflict zones

- LOW: `agent-session.ts` `_activateLazyTool` as shared tool-search activation wiring lands.

## 2026-08-11 - Dormant shared tool-search builtin wiring

### What changed

- The builtin list now loads a shared tool-search service before MCP while keeping MCP last.
- The service catalogs search-exposed extension tools, promotes them additively through lazy activation, and replays ownership-aware activation history once per catalog generation.
- The generalized `tool_search` definition is authored but intentionally not registered in this increment.

### Why

- Shared extension catalog behavior must be available before MCP becomes a feeder, but registering a second builtin with the same tool name before removing MCP's registration would violate atomic winner precedence.

### Why this cannot be expressed externally

- Live registry metadata, inactive-tool activation, and session-history lifecycle hooks are core extension-runtime surfaces.

### Expected merge conflict zones

- LOW: builtin ordering immediately before the MCP-last sentinel.
- MEDIUM: tool-search registration and MCP feeder wiring in the planned atomic follow-up.

## 2026-08-11 - Reload continuity follows tool ownership

### What changed

- Session reload now preserves active membership only when a tool name still belongs to the same registration identity.
- A search-exposed same-name replacement from a different extension is treated as a fresh inactive registration.
- Tools no longer registered by a still-loaded extension continue to fall out through the rebuilt registry filter.

### Why

- Name-only continuity could transfer a prior promotion to an unrelated extension that took over the same tool name.
- Binding continuity to the host-derived source path keeps remembered activation scoped to the owning registration.

### Why this cannot be expressed externally

- Reload replaces the extension runner and registry atomically, so only core can compare the previous and winning owners.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` reload and `_refreshToolRegistry` option threading.

## 2026-08-11 - Search-exposed tools start inactive

### What changed

- Factory-loaded and post-bind extension tools now auto-activate only when their effective exposure is `direct`.
- Explicit initial active names and host allowlists remain authoritative, including for search-exposed tools.
- Re-registering an existing tool preserves its current active or inactive membership instead of reapplying exposure defaults.

### Why

- Search-exposed tools must remain registered and discoverable without adding their schemas to every model request.
- Exposure is an initial-state policy, not a permission boundary or a reason to demote an already-promoted tool.

### Why this cannot be expressed externally

- Initial activation is computed while the core session rebuilds its winning definition and executable registries.

### Expected merge conflict zones

- MEDIUM: `agent-session.ts` active-set computation in `_refreshToolRegistry` as shared tool search lands.

## 2026-08-11 - Declarative tool search-exposure metadata

### What changed

- `ToolDefinition` now declares an initial `direct` or `search` exposure policy plus supplemental search text,
  keywords, grouping, and lazy-activation control.
- `getAllTools()` projects the human-readable label and normalized effective metadata, preserving `direct`, an empty
  keyword list, and lazy activation as the defaults for existing definitions.
- Non-builtin extensions cannot register the reserved `tool_search` name.
- MCP harness factories that stand in for the production builtin now use host-assigned `<builtin:...>` paths, so the
  reserved-name guard exercises the same source identity in tests without exempting inline or end-user extensions.
- Definition metadata coverage now pins that `searchText` is omitted from the normalized projection for direct tools.

### Why

- A shared searchable catalog needs complete, normalized metadata without a second extension lookup, while existing
  extensions must retain their current direct-exposure behavior when they omit the new fields.
- Reserving the catalog tool name prevents extension registration order from shadowing the builtin search surface.
- Keeping the guard strict and correcting builtin test identity avoids a harness-only regression without opening a
  registration path that a real end-user extension could use.

### Why this cannot be expressed externally

- Default exposure, registry projection, and registration-name ownership are core extension-runtime concerns shared by
  every host and extension source.

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ToolDefinition` and `ToolInfo` as the shared search catalog lands.
- LOW: `loader.ts` registration validation and `agent-session.ts` `getAllTools()` projection.

## 2026-08-09 - Extension-registered filesystem access policies

### What changed

- `ExtensionAPI` gained factory-time `registerFilesystemPolicy(policy)` with typed read, enumerate, and write requests,
  explicit allow/deny decisions, and optional denied-root metadata for future process sandbox integration.
- Loaded extensions retain policies in registration order. `ExtensionRunner` exposes the declared denied roots without
  assigning them runtime semantics.
- Multiple policies compose deterministically with the first denial winning; an absent policy set compiles to no
  checker.

### Why

- `tool_call` hooks run before canonical path resolution and belong to the permission/approval pipeline, so they cannot
  provide a non-bypassable filesystem boundary for unrestricted modes or symlink-resolved targets.
- Policy decisions belong to extensions, while registration, lifetime, and composition require a typed core surface.

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ExtensionAPI` registration methods and the `Extension` runtime record.
- LOW: `loader.ts` registration storage, `runner.ts` denied-root metadata aggregation, and public type exports.

## 2026-08-05 - Extension abort provenance

### What changed

- `ExtensionContext.abort(source?)` and its host action now accept `"user" | "system"`.
- The default remains `"user"` for compatibility. A system-owned abort bypasses
  the interactive user-abort handler and reaches the agent as
  `agent_end.abortSource === "system"`.

### Why

- Builtin stream remediation previously called the same user-abort path as Escape,
  so the Goal extension persisted `blocked("user interrupted the turn")` even
  though TTSR, not the user, stopped the generation.
- Abort provenance belongs at the initiating extension boundary. Consumers such
  as Goal can retain their existing source-based policy without detector coupling.

### Expected merge conflict zones

- LOW in `types.ts` around `ExtensionContext.abort` and
  `ExtensionContextActions.abort`.
- LOW in `runner.ts` and `agent-session.ts` around extension context forwarding
  and binding.

## 2026-08-03 - ExtensionContext exposes the resolved agent dir

### What changed and why

- `ExtensionContext` gains `agentDir: string` and `ExtensionContextActions` gains optional `getAgentDir`.
  `AgentSession.bindCore` supplies its resolved agent dir (`config.agentDir ?? getAgentDir()`); the runner
  falls back to `getAgentDir()` when unbound.
- The builtin compaction extension previously read `ctx.agentDir` through a local cast that core never
  populated, so its "always-on" `logs/compaction.log` was a permanent noop on every install. Extensions that
  need the agent state directory now have a typed context getter instead of a global lookup.

### Expected merge conflict zones

- LOW: `types.ts` `ExtensionContext`/`ExtensionContextActions` member lists.
- LOW: `runner.ts` context getter block and `bindCore` context-action wiring.
- LOW: `core/agent-session.ts` bindCore context-action object.

## 2026-08-02 - Completed apply_patch details have fixed retention bounds

### What changed and why

- The builtin `apply_patch` tool stores the same bounded diff used by the TUI in its top-level preview and retains complete unified patches only up to 16 KiB per file.
- Oversized unified patches are omitted rather than persisting old/new file bodies or exposing malformed truncated diffs; app-server file-change projection remains complete for patches within budget.
- Nested applied-operation previews and fail-fast error recovery results retain paths, move destinations, operation types, line counts, operation indexes, fuzz, and failure/recovery metadata without full patch bodies.
- Projection and persistence receive the same completed result object, with no extension-owned post-projection persistence hook, so the explicit byte budget is the narrowest boundary that also removes source-size scaling.

### Expected merge conflict zones

- LOW: `builtin/gpt-apply-patch/apply.ts` and `tool.ts` result construction.

## 2026-08-01 - Anthropic pair guards share the provider-final sanitizer

### What changed and why

- The `tool-pair-guard` request hook and direct compaction summarization now use the browser-safe
  `sanitizeAnthropicToolPairs` export from `@earendil-works/pi-ai`.
- The duplicate coding-agent sanitizer was removed so normal turns, extension hooks, and direct summarization
  cannot drift across separate Anthropic repair implementations.
- The coding-agent hook remains an early defensive repair, while the pi-ai Anthropic adapter owns the final
  pre-SDK invariant after all payload mutations.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` and `builtin/compaction/speculative.ts` if upstream changes direct
  provider-request hooks.
- LOW: `test/tool-pair-guard/sanitize-anthropic-payload.test.ts` if upstream relocates wire sanitizer coverage.

## Backfill: extension context and reload stability (2026-08-01)

### What changed

- Session replacement no longer leaves extensions holding stale `ExtensionContext` instances.
- Config reload watches stay scoped to the intended config source instead of widening across unrelated paths.
- Global/default compatibility shims no longer bounce state back and forth during reloads.

### Why

- These fixes keep long-lived extension processes aligned with the current session and configuration.

### Why this cannot be expressed externally

- The behavior lives inside extension runner lifecycle, SDK context replacement, and config-watch ownership.

### Expected merge conflict zones

- `runner.ts`, `sdk.ts`, extension config reload/watch wiring, and global/default shim normalization.

## 2026-08-01 - recommended-models respects an explicitly saved system default

### What changed and why

- The `recommended-models` builtin no longer auto-switches when the startup model comes from the user's own `settings` provenance. It now auto-switches only on implicit fallback paths (`provider-default` and `first-available`), so an explicitly configured `defaultProvider`/`defaultModel` is never silently overridden by a recommendation.
- Previously a user who had set a non-recommended system default still got switched to the recommended model on every start (with the notice `Switched to recommended model '...'.`), in TUI persisting the recommendation back over their chosen default.
- Explicit CLI and scoped selections were already excluded; `settings` (an explicitly configured system default) is now excluded too, aligning the extension with the original intent of preserving explicit user choice.

### Files modified

- `builtin/recommended-models/index.ts` (`AUTO_SWITCH_PROVENANCE`)

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/recommended-models/index.ts` if upstream re-introduces `settings` as an auto-switch path; keep it out of `AUTO_SWITCH_PROVENANCE`.


## 2026-07-31 - Correlated input dispositions

### What changed and why

- `InputEvent` now carries a session-local `inputId`; the new `input_disposition` event repeats that ID with `handled`, `queued`, `started`, or `rejected` after interception and final admission resolve.
- Goal lifecycle state can therefore wait for accepted input instead of mutating persistence from raw input, while concurrent prompts retain independent ownership.

### Expected merge conflict zones

- MEDIUM: additive input event types/exports and `AgentSession.prompt()` admission exits.
- LOW: `ExtensionRunner.emitInput()` event assembly.

## 2026-07-31 - Anthropic tool-pair guard repairs missing immediate results

### What changed

- The tool-pair guard sanitizer pairs client `tool_use` blocks only with
  `tool_result` blocks in the immediately following user message, removes misplaced or duplicate results,
  and synthesizes error results for calls whose outputs were interrupted or pruned.
- Repaired result blocks are placed before ordinary user content, including when the following user message
  originally used string content.
- `test/tool-pair-guard/sanitize-anthropic-payload.test.ts` covers the observed Kimi-to-Opus `bash_14`
  replay failure plus payload-end, partial-result, duplicate, misplaced, and string-content cases.

### Why

- Anthropic rejects a request when any client `tool_use` lacks a matching `tool_result` in the next user
  message. A persisted session can be valid before context hooks run but lose one result during pruning or
  payload transformation, so switching from a larger-context non-Anthropic model to Claude could wedge every
  follow-up request with HTTP 400.
- The provider-request hook repairs after context reduction and wire conversion without changing the durable
  transcript. The 2026-08-01 provider-final guard supersedes the earlier assumption that no later payload
  mutation could invalidate the pair.

### Expected merge conflict zones

- LOW: `@earendil-works/pi-ai` `sanitizeAnthropicToolPairs` if upstream adds equivalent Anthropic tool-pair
  normalization.
- LOW: `test/tool-pair-guard/sanitize-anthropic-payload.test.ts` if upstream expands the same sanitizer cases.

## 2026-07-31 - `pi.setSessionFastMode()` for the fast-mode indicator

### What changed and why

- `ExtensionAPI` gains `setSessionFastMode(enabled: boolean)` (with the matching
  `SetSessionFastModeHandler` type and `ExtensionActions.setSessionFastMode`). It flips a
  session-scoped, never-persisted flag on `AgentSession` that hosts can surface; the TUI footer
  stamps a lightning bolt on the model label while it is set.
- The flag is display-only and deliberately separate from `serviceTier`. `serviceTier` feeds
  request composition (`service-tier.ts` for non-Codex apis, `compaction/openai-remote.ts`), so
  folding a provider-scoped fast toggle into it would inject `service_tier: "priority"` into
  API-key-billed `openai-responses` traffic. `AgentSession.isFastModeActive()` ORs the flag with
  `serviceTier === "priority"`, so a configured `-fast` catalog variant lights the indicator too.
- The `service-tier` builtin mirrors its Codex session toggle through the new API and clears it on
  `session_start`.

### Expected merge conflict zones

- MEDIUM: `types.ts` around the `setSession*` block in `ExtensionAPI` and `ExtensionActions`.
- LOW: `loader.ts` stub table and `pi` implementation, `runner.ts` `bindCore` assignment.

## 2026-07-30 - Linux recursive config watches leave the interactive main thread

### What changed and why

- `builtin/config-reload/watch-event-source.ts` now routes Linux recursive `fs.watch` subscriptions through one
  session-local worker thread, while non-recursive config file/directory subscriptions keep the existing direct
  watcher path. The worker owns setup, reconciliation, and event delivery for every recursive target registered by
  that config-reload instance.
- This preserves recursive config/resource reload behavior and avoids one worker per target, but keeps Node's
  expensive recursive directory enumeration off the TUI event loop. Issue #477 captured 350,387 inotify watches and
  a V8 profile dominated by `node:internal/fs/recursive_watch`, `readdir`, and path normalization while terminal input
  was frozen.
- `test/suite/regressions/477-recursive-watch-main-thread-stall.test.ts` asserts the backend choice directly: Linux
  recursive targets share the worker, and non-recursive targets still call `fs.watch` with `recursive: false`.

### Expected merge conflict zones

- LOW: `builtin/config-reload/watch-engine.ts` now re-exports the production event source from its dedicated module.
- NONE: the new worker-backed event source is fork-owned and does not change the public `config-watch:*` protocol.

## 2026-07-29 - Reload veto probe on ExtensionContext + quiet config-reload deferral

### What changed and why

- Added `ExtensionContext.checkReloadVeto(): Promise<ReloadVetoDecision>` (optional) and the matching optional `ExtensionContextActions.checkReloadVeto`. It probes the cancellable `session_before_reload` gate WITHOUT starting a reload; `AgentSession` supplies it from its existing `checkReloadVeto()`, so every host mode (TUI, RPC, print) exposes it automatically.
- The `config-reload` builtin now probes this gate in `flushPending` before announcing a reload. A vetoed hot-reload (e.g. an extension guarding running subagents) keeps its pending changes, logs `reload_deferred`, shows at most ONE `Hot-reload deferred: <reason>` notice per distinct reason, and retries on later idle edges plus a 1s veto recheck clock. Previously every idle edge re-emitted the `Hot-reloading:` notice plus the host's veto warning, spamming the TUI for as long as the veto held. The `Hot-reloading:`/`Hot-reloaded:` notices now appear only when the reload actually proceeds. New module `builtin/config-reload/reload-deferral.ts` owns the once-per-reason notice state; `builtin/config-reload/log.ts` gained the `reload_deferred` event.

### Why the extension system couldn't handle this alone

Only the session core can consult `session_before_reload` without side effects; the host `requestReload` action both warns and reloads. Watching extensions need the quiet probe as a typed context accessor to distinguish "defer silently" from "reload now".

### Files modified

- `types.ts` (`ExtensionContext.checkReloadVeto`, `ExtensionContextActions.checkReloadVeto`, `ReloadVetoDecision`)
- `runner.ts` (probe promotion into event contexts)
- `../agent-session.ts` (`_bindExtensionCore` supplies the probe)
- `builtin/config-reload/index.ts`, `builtin/config-reload/reload-deferral.ts` (new), `builtin/config-reload/log.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `types.ts` around `ExtensionContext.isCompacting`/`requestReload` and `ExtensionContextActions`; retain the optional `checkReloadVeto` members and `ReloadVetoDecision`.
- LOW: `runner.ts` `bindCore` context-action copies and the `createContext` getters; keep the `checkReloadVeto` getter beside `requestReload`.
- LOW: `builtin/config-reload/index.ts` `flushPending`; the veto probe must stay before the `Hot-reloading:` notify and `requestReload` call.



## 2026-07-29 - Session-scoped model APIs; headless recommended-model switch no longer persists

### What changed and why

- `ExtensionAPI` gains `setSessionModel(model)` and `setSessionThinkingLevel(level)`: session-scoped counterparts of `setModel`/`setThinkingLevel`. They change the active session model/thinking level (still recorded in session history) without rewriting the user's persisted `defaultProvider`/`defaultModel`/`defaultThinkingLevel`.
- The `recommended-models` builtin persists its automatic startup switch only in interactive (`tui`) mode. Headless modes (`print`, `rpc`, `json`) switch session-scoped, so background/child sessions no longer rewrite the user's real `~/.senpi/agent/settings.json` defaults on every start. Observed in the field: concurrent headless sessions with differing provider auth repeatedly overwrote the user's saved defaults minutes after the user restored them.

### Why the extension system couldn't handle this alone

`AgentSession.setSessionModel`/`setSessionThinkingLevel` already existed but were not exposed through the extension runtime, so extensions could only make persisting switches.

### Files modified

- `types.ts` (`ExtensionAPI`, `ExtensionActions`)
- `loader.ts`, `runner.ts` (runtime stubs, facade, action binding)
- `../agent-session.ts` (action wiring to the existing session-scoped setters)
- `builtin/recommended-models/index.ts` (mode-scoped persistence)

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` around the Model/Thinking Level API block; retain both session-scoped methods.
- LOW: `runner.ts` action copy block and `loader.ts` runtime stub/facade lists; keep the session-scoped entries.



## 2026-07-29 - Initial model provenance on session_start

### What changed and why

- `SessionStartEvent` now carries optional `initialModelProvenance`, identifying the branch that selected a freshly resolved startup model: `cli`, `scoped`, `settings`, `provider-default`, or `first-available`.
- `findInitialModel()` produces this provenance and the SDK forwards it when it resolves the startup model. CLI and scoped selections supplied by `main.ts` carry their explicit provenance too.
- The new `recommended-models` builtin uses this field to limit automatic default-model selection to settings/provider-default/first-available startup paths, preserving explicit CLI and scoped selections.

### Why the extension system couldn't handle this alone

The extension runs after the core resolver has selected the startup model. Without the resolver branch crossing the existing `session_start` boundary, it cannot distinguish a saved default from an explicit CLI or scoped selection.

### Files modified

- `types.ts` (`SessionStartEvent`)
- `../model-resolver.ts`, `../sdk.ts`, `../../main.ts` (provenance production and forwarding)
- `builtin/recommended-models/index.ts` (consumer)

### Expected merge conflict zones on next upstream sync

- LOW: `types.ts` around `SessionStartEvent`; retain the optional `initialModelProvenance` field.
- MEDIUM: `../sdk.ts` startup-model resolution and session-start event assembly; preserve provenance when the SDK resolves the initial model.



## 2026-07-28 - Prompt-cache safe-wait budget on ExtensionContext

### What changed and why

- Added `ExtensionContext.getPromptCacheSafeWaitSeconds(): number | undefined`, the longest an extension-owned tool may block in the foreground before the active model's prompt cache expires. It is the model's cache TTL (resolved by `pi-ai`'s `resolvePromptCacheTtlSeconds`) minus a configurable safety buffer (`promptCache.safetyBufferSeconds`, default 30), and `undefined` whenever no cache-derived budget applies — unknown TTL, caching off, feature disabled, or the buffer swallowing the whole TTL.
- Consumers: the builtin `bash-timeout` extension caps its recommended maximum at this budget, and the builtin `terminal` extension uses it as the foreground auto-detach deadline. Both fall back to byte-identical legacy behavior when the getter returns `undefined`.
- The getter reads the LIVE current model on every call, so a `/model` switch takes effect immediately; callers must not snapshot it.

### Why the extension system couldn't handle this alone

Prompt-cache TTL is decided per provider inside `pi-ai`, and the resolved model plus the `promptCache` settings block live in the session core. Extensions have no access to either, so the budget must cross the boundary as a typed context getter.

### Files modified

- `types.ts` (`ExtensionContext`, `ExtensionContextActions`)
- `runner.ts` (default stub, `bindCore` assignment, context exposure)
- `../agent-session.ts` (binding + `resolvePromptCacheSafeWaitSeconds()` / `syncPromptCacheSafeWaitEnv()`)
- `../../modes/interactive/interactive-mode.ts` (binding)
- `../prompt-cache-budget.ts` (new), `../settings-manager.ts` (`PromptCacheSettings`)

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` around the `ExtensionContext` getter block and the `ExtensionContextActions` mirror — the new member sits beside `getCompactionSettings` / `getLookAtSettings`. Resolution: keep the additive getter in both places.
- MEDIUM: `runner.ts` context-action plumbing (three sites) and the `agent-session.ts` / `interactive-mode.ts` `contextActions` object literals.

### Migration notes

Hosts that construct `ExtensionContextActions` themselves must supply `getPromptCacheSafeWaitSeconds`; returning `() => undefined` preserves pre-existing behavior exactly.


## 2026-07-28 - session_before_reload (cancellable reload veto)

### What changed

- `types.ts` adds `SessionBeforeReloadEvent` (`{ type: "session_before_reload" }`) to the `SessionEvent` union,
  `SessionBeforeReloadResult` (`{ cancel?: boolean; reason?: string }`), and the matching `pi.on` overload.
- `runner.ts` routes the event through the existing session-before machinery: `SessionBeforeEvent` /
  `SessionBeforeEventResult` unions, the `RunnerEmitResult` mapping, and `isSessionBeforeEvent`, so the first
  handler returning `cancel: true` short-circuits exactly like `session_before_switch`.
- `agent-session.ts` `reload()` now returns `{ cancelled: boolean; reason?: string }` and consults the new
  `checkReloadVeto()` before `emitSessionShutdownEvent`: a cancelling extension prevents the entire reload
  (no shutdown, no settings/models/resources reload, no runtime rebuild) on every path — `/reload`,
  `ctx.reload()`, the builtin config-reload hot path, and direct SDK/rpc/print callers.
- Interactive mode pre-checks the veto in `handleReloadCommand` and shows the `reason` as a warning without
  flashing the reload box; it also honors a cancelled result from `reload()` itself (race window).

### Why extension system couldn't handle this alone

- Only the session owns the reload teardown ordering; an extension cannot intercept `session_shutdown`
  emission or refuse it. Extensions that own long-lived work (e.g. running background subagents in
  omo-senpi's task runtime) were killed mid-flight by any reload. The veto gives the owning extension a
  cancellable checkpoint, mirroring the established `session_before_switch`/`fork`/`compact` family.

### Expected merge conflict zones

- LOW: additive event/result/overload entries in `types.ts` and the union/mapping lines in `runner.ts`.
- MEDIUM: the head of `reload()` in `agent-session.ts` (return-type change plus early return); upstream
  edits to the reload sequence will conflict there and must keep the veto check first.

## 2026-07-27 - registerLazyToolActivator (on-demand activation of inactive tools)

### What changed

- `types.ts` exports `LazyToolActivator = (toolName: string) => boolean` and adds
  `registerLazyToolActivator(activator)` to `ExtensionAPI`, `ExtensionActions`, and the runtime handler bag.
- `agent-session.ts` `executeTool()`: when a name resolves to a registered-but-inactive tool, registered
  activators run before the `inactive_tool` throw. An activator returning `true` means it has actually
  activated the tool, and execution proceeds; `unknown_tool` is unaffected.
- `loader.ts`/`runner.ts` stash activators on the extension and replay them after `bindCore()`, mirroring
  `registerRemovedToolHint` — extension factories run before core is bound.
- `builtin/mcp` registers an activator whose eligibility is the tier-B searchable catalog only, routed through
  the existing tier-B `activate()` so stub-swap and name filtering keep their semantics.

### Why extension system couldn't handle this alone

- Only the session owns the active set and the `inactive_tool` decision; an extension cannot intercept it.
  Eligibility, however, must stay with the registering extension: `_toolDefinitions` also contains
  permission-denied tools, MCP `list_changed` additions held inactive as rug-pull defense, removed-tool
  tombstones, and capability-gated tools (`look_at`, `read_video`). Core deliberately does not decide.

### Expected merge conflict zones

- LOW: additive handler entries in `types.ts`, `loader.ts`, `runner.ts`.
- MEDIUM: the tool-resolution block at the top of `executeTool()` in `agent-session.ts`.

## 2026-07-27 - RUNTIME_EXTENSION_PATH sentinel constant

### What changed

- `types.ts` exports `RUNTIME_EXTENSION_PATH = "<runtime>"`, the sentinel `extensionPath` used when the session
  runtime itself (not a loaded extension) emits an error through the extension-error channel — e.g. failed
  background session-title generation. `index.ts` re-exports it.
- `agent-session.ts` and interactive mode consume the constant instead of repeating the string literal, so the
  rendering contract ("runtime errors are not extension failures") has one owner.

### Why extension system couldn't handle this alone

- The sentinel is produced by core runtime paths and consumed by the TUI renderer; extensions never emit it.

### Expected merge conflict zones

- LOW: additive export above the `ExtensionError` interface in `types.ts`, and the value-export block in `index.ts`.

## 2026-07-26 - AgentEndEvent abort payload + goal resume at before_agent_start

### What changed
- `AgentEndEvent` gained optional `aborted?: boolean` and `abortSource?: "user" | "system"` (public API addition; goal builtin uses it to block active goals on user abort).
- `builtin/goal` resumes a blocked goal inside `before_agent_start` (real-user-prompt-only event) instead of a sticky flag consumed at `agent_start`, removing the stale-flag race when final provider admission rejects a run.

### Expected merge conflict zones
- LOW: `types.ts` around the AgentEndEvent interface; `builtin/goal/index.ts` event handlers.


## 2026-07-25 - Config-reload skips routine cross-process settings changes

### What changed

- `builtin/config-reload/routine-settings.ts` (new): content-diff classification for watched `settings.json` paths. When a change's top-level key diff is limited to routine, live-applied keys (`defaultModel`, `defaultProvider`, `defaultThinkingLevel`, `lastChangelogVersion`), the change is suppressed before validation and never reaches the notify/reload flow. The extension keeps a per-path content snapshot as the diff base, refreshed on watcher rebuild and advanced on every observed settings change (including self-write-suppressed ones), so each event is classified against the previous event's content. Missing or unparseable content is never suppressed and falls through to the existing validator.
- `builtin/config-reload/index.ts`: `processChange` now resolves the self-write and routine-change exclusions once over the change's unique paths before `groupChangedPaths`, then groups the surviving paths for per-registration validation. Suppression state is per path, so classifying inside the registration loop double-processed a path watched by several registrations (external registrations may watch the agent dir; only `auth.json`, `sessions` and `logs` are restricted): the later group saw a consumed self-write marker and an already-advanced diff base and still notified and reloaded. `isSettingsPath`/`joinConfigDir` moved into the new module.
- `test/suite/config-reload-extension.test.ts`: coverage for idle and busy-deferred routine-only suppression, non-routine/mixed reload preservation with diff-base freshness, consecutive routine writes, unparseable fall-through, and overlapping-registration suppression for both routine external writes and `SettingsManager` self-writes.

### Why

The self-write tracker is process-local, so /model or a thinking-level change in one session (or a background CLI run writing the shared global `settings.json`) surfaced in every other session as "Config changed; reloading when idle" followed by a full hot reload. These keys are applied live by the owning session (or never read back), so reloading other sessions buys nothing; structural changes (packages, extensions, retry, …) keep the existing reload behavior.

## 2026-07-23 - Compaction feedback operation handles

### What changed

- `ExtensionContext` compaction feedback actions now return and accept an optional operation `AbortSignal`, allowing
  progress and terminal feedback from superseded generations to be ignored without breaking existing extensions.
  Each handler invocation receives an isolated context that remembers its own `beginCompaction()` signal and supplies
  it to legacy `updateCompaction()`, `endCompaction()`, and `applyCompaction()` calls that omit the signal, so another
  handler in the same event emission cannot rebind an old completion or durable apply to a newer operation.
- `stale-revision` is a structured compaction rejection cause for a source that changed before durable append.
- The builtin compaction extension threads that signal through local and remote summary generation and application.
- `model_select` sources now distinguish fallback apply and fallback revert transitions, allowing model-scoped
  extensions to update prompts and active tools before the retry request.
- Builtin PreCompact diagnostics carry the active compaction request ID so their own feedback does not falsely trip the
  source-revision guard; unrelated session or tool mutations remain stale-rejected.
- `ExtensionRunner.prepareProviderRequest()` provides a request-local canonical path for compaction generation:
  ordered `context` hooks, provider-body transforms, and header transforms run without mutating persisted messages.
  The originating compaction handler is excluded to avoid recursive re-entry while later redaction hooks still run.

### Why

Asynchronous summary feedback can arrive after a newer compaction begins; operation identity prevents stale progress
or completion from mutating the current session lifecycle.

## 2026-07-22 - Config-reload rejection loop breaker

### What changed

- `builtin/config-reload/index.ts`: rejected watch registrations are now fingerprinted (`id`, `displayName`, `targets`, `hasValidate`) and remembered per registration id. A synchronous re-registration with an identical payload after a rejection is ignored without re-emitting `CONFIG_WATCH_REJECTED`, breaking the reject → re-register synchronous recursion that crashed startup with `RangeError: Maximum call stack size exceeded`. Acceptance and unregistration clear the recorded fingerprint, so a repaired registration with a changed payload is processed normally. Suppressions are logged once at debug level as `registration_rejection_suppressed`.
- `test/suite/config-reload-extension.test.ts`: regression coverage for the single-rejection loop break and for post-rejection repair with a changed target.

### Why

External plugins that re-register synchronously from a `CONFIG_WATCH_REJECTED` listener (sticky-rejection recovery) recursed unboundedly against restricted-target rejections; the existing identity guard only covered accepted registrations re-emitted on ready, and rejected registrations were never recorded.

## 2026-07-21 - Look-at and image settings context APIs

### What changed

- `ExtensionContext` now exposes `getLookAtSettings()` and `getImageSettings()`, with matching context actions wired through the runner, agent session, and interactive shortcut contexts.

### Why

Builtin look-at extensions need resolved look-at and image settings without accessing the core `SettingsManager` directly.


## 2026-07-21 - Config-reload builtin registration

### What changed

- Registered the default-on `config-reload` builtin after settings-dependent builtins and before final `mcp` registration. It hash-gates configuration filesystem changes, validates parseable built-in surfaces before requesting the existing session reload flow, and publishes the `config-watch:*` in-process protocol for external registrations.

### Why

The reload-request context seam below lets the builtin reuse the host reload path without making reload a model tool. Keeping MCP last preserves its provider-payload observation ordering.


## 2026-07-21 - Extension reload request seam

### What changed

- `ExtensionContext` now exposes optional `requestReload()` and `isCompacting()` accessors. The runner promotes a host-provided command reload action into event and tool contexts, coalescing concurrent requests; hosts without that action expose no reload method.
- `AgentSession` binds `isCompacting()` to its unified auto/manual/branch-summary controller state. Interactive shortcut contexts expose the same pair.

### Why

Config-reload extensions need to request the existing host reload flow only when available and defer while compaction is active. A resolved interactive request is not proof of reload because the host deliberately warn-drops reloads while streaming or compacting.


## 2026-07-20 - recovery model config is public to provider extensions

### What changed

- `types.ts`: `ProviderModelConfig` now exposes optional `recoverTextToolCalls`, matching the composed provider model field. Extensions can register recovery-enabled, disabled, or inherited models without excess-property type errors.

### Expected merge conflict zones

- LOW: `types.ts` `ProviderModelConfig` model metadata fields.


## 2026-07-20 - Model fallback command builtin

- Added the `model-fallback` builtin and `/fallback` command for viewing, creating, removing, enabling, and setting the revert policy for global retry fallback chains.
- Quick-set form validates selectors before persisting; headless runs support quick-set and report that the menu requires interactive UI.
- Registered `--no-model-fallback` and `SENPI_NO_FALLBACK=1` as the per-run fallback escape-hatch inputs.
- `ExtensionContext.sessionSettings` delegates command writes to the active session's `SettingsManager`, so quick-set changes are immediately visible to the retry controller. Its read-only fallback status accessor powers the menu's live-state view.
- `--no-model-fallback` and `SENPI_NO_FALLBACK=1` apply a non-persistent `retry.modelFallback=false` override at session bootstrap.


## 2026-07-20 - session_compact `accepted: false` and structured cancel result

### What changed

- `types.ts`: `SessionBeforeCompactResult` gained optional `rejectionCause?: CompactionRejectionCause`
  and `reason?: string` fields so extensions can attach a structured cause and a
  human-readable detail when returning `{ cancel: true }`. `SessionCompactEvent.compactionEntry`
  is now optional and only populated on `accepted: true` events, and the JSDoc
  spells out that rejection events fire too.
- `agent-session.ts`: `_rejectCompaction` populates `compaction_end.errorMessage`
  with a message derived from `rejectionCause` (or the extension-provided
  `reason` when present) and also emits a `session_compact` event with
  `accepted: false`. Manual `/compact` used to swallow `would-overflow` and
  extension cancels silently; this closes plan §1.
- `builtin/nested-agents-md/index.ts`, `builtin/rules/index.ts`: `session_compact`
  handlers now guard on `event.accepted` before mutating session state, since
  the event fires on rejection too and there is no compaction entry to react to.

### Why

- `_rejectCompaction` emitted `compaction_end` with no `errorMessage` and the
  interactive-mode handler had no branch for `aborted:false && !result && !errorMessage`,
  so `/compact` rejected by `_wouldCompactionOverflow` was invisible. The
  builtin compaction extension's `session_compact` `!accepted` branch was also
  dead because core never emitted the rejection.

### Why extension system couldn't handle this alone

- The event union and the emit sites live in the core extension surface.
  Extensions cannot add typed fields to `SessionCompactEvent` or make the core
  emit rejections from outside.

### Expected merge conflict zones

- HIGH: `types.ts` around `SessionBeforeCompactResult` and `SessionCompactEvent`.
- MEDIUM: `agent-session.ts` `_rejectCompaction` and `_executeCompaction` cancel branch.
- LOW: builtin `session_compact` handlers guarding on `event.accepted`.

## 2026-07-19 - Port phased op-based todo tool

### What changed

- Rewrote `builtin/todotools/` around one `todo` tool with `init`,
  `start`, `done`, `drop`, `rm`, `append`, and `view`
  operations.
- Added phased state, content-keyed task resolution, automatic promotion,
  atomic failure behavior, compaction compatibility, and a static phase-aware
  renderer while preserving the `todowrite` builtin id and
  `todo-sidebar` widget key.

### Why

- The old pair required sending a complete flat snapshot on every mutation.
  The op-based port makes incremental updates retry-safe and gives the model a
  smaller, phase-aware contract.

### Attribution

- Ported and adapted from oh-my-pi commit
  `9fd6e97113f5ed3a847e66d346970efdf8afcad9` (v17.0.5); see
  `builtin/todotools/changes.md` and the repository `NOTICE.md`.

### Expected merge conflict zones

- HIGH: `builtin/todotools/`, `builtin/compaction/todo-bridge.ts`, and
  todo-specific tests if upstream changes its todo or compaction contracts.

## 2026-07-17 - video-in builtin extension and "video" input modality

### What changed

- `types.ts`: `ProviderModelConfig.input` widened to `("text" | "image" | "video")[]`, tracking the pi-ai
  `Model.input` union (kimi-coding `k3` declares video input).
- New builtin `builtin/video-in/`: registers a `read_video` tool that attaches a local video file
  (mp4/mpeg/mov/webm/mkv/avi/flv/3gp, ≤100MB) as a base64 `video/*` ImageContent block. The tool is
  activated/deactivated on `session_start` and `model_select` based on `model.input.includes("video")`,
  so it is only exposed to video-capable models. Registered in `builtin/index.ts` after `webfetch`.

### Expected merge conflict zones

- LOW: `types.ts` `ProviderModelConfig.input`.
- LOW: `builtin/index.ts` import block and `builtinExtensions` array tail.

## 2026-07-19 - model_select handlers observe live systemPromptOptions

### What changed
- `src/core/extensions/runner.ts`: `emitModelSelect` spreads a fresh
  `systemPromptOptions` from `getSystemPromptOptionsFn()` into each handler's event, so
  toolset-swapping handlers (gpt-apply-patch) and prompt-rebuilding handlers
  (prompt-preset) stay consistent within one model switch.

## 2026-07-17 - Factory-time `pi.registerMcpServer()` API

### What changed
- `src/core/extensions/builtin/mcp/config-schema.ts`: added `"extension"` to
  `McpServerSource`; exported a public raw `McpServerDeclaration` type and a
  single-server `validateMcpServerDeclaration(name, raw)` validator.
- `src/core/extensions/types.ts`: added `ExtensionAPI.registerMcpServer(name,
  config)`, `RegisteredMcpServerDeclaration`, and `Extension.mcpServers` +
  `registrationCwd` storage; added optional
  `ExtensionContext.getRegisteredMcpServers()`.
- `src/core/extensions/loader.ts`: `createExtension` stores `registrationCwd`;
  `createExtensionAPI` implements `registerMcpServer` with synchronous
  ServerSchema + endpoint validation that throws only for the declaring
  extension.
- `src/core/extensions/runner.ts`: added
  `ExtensionRunner.getRegisteredMcpServers()` with first-wins aggregation and a
  conflict warning naming both extension paths; exposed it on
  `ExtensionContext`.
- `src/core/extensions/index.ts` + `src/index.ts`: re-export `McpServerDeclaration`.
- `docs/extensions.md`: documented the factory-time-only contract, validation,
  precedence, cwd defaulting, reload, and child-session behavior.

### Why
- Extensions need a first-class way to declare MCP servers that are available on
  turn 1. Factory-time registration is the only seam that runs before
  `session_start`, so servers can be connected and their tools registered before
  the first model request.

### Why extension system couldn't handle this alone
- This is a public extension API addition: the declaration type, validator,
  per-extension storage, runner aggregation, and context accessor all live in
  the extension system.

### Expected merge conflict zones
- HIGH: `types.ts` around `ExtensionAPI` and `Extension` definitions.
- MEDIUM: `loader.ts` `createExtension` / `createExtensionAPI`.
- MEDIUM: `runner.ts` around `createContext()` and the aggregation helpers.
- LOW: `src/index.ts` extension type re-exports.

## 2026-07-17 - Tool renderer hasResult context

### What changed

- Added optional `ToolRenderContext.hasResult`, true once a partial or final result exists for a tool call.
- Lets a call renderer that draws self-contained framing (e.g. codemode `eval`) yield to the result renderer instead
  of stacking a duplicate block, since `ToolExecutionRenderer.update()` renders call-then-result into one container.

### Why

- `renderCall` previously had no way to detect that a result had arrived: `isPartial` is true both for "no result yet"
  and "partial result", so a self-framing call renderer kept drawing its own box on top of the result box.

### Why extension system couldn't handle this alone

- `ToolRenderContext` is a public host-to-extension contract, and result presence for a tool row is owned by the
  interactive renderer (`modes/interactive/components/tool-execution-renderer.ts`).

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ToolRenderContext` as upstream adds renderer context fields.
- LOW: `modes/interactive/components/tool-execution-renderer.ts` around `getRenderContext()`.

## 2026-07-16 - anthropic-web-search gated to endpoints that support server-side web search

### What changed

- `builtin/anthropic-web-search/index.ts`: the extension now gates on the model instead of the API type,
  mirroring `builtin/openai-web-search`. `supportsNativeAnthropicWebSearch(target)` is true for the first-party
  `api.anthropic.com` endpoint or an explicit `compat.supportsWebSearch` opt-in. For unsupported
  `anthropic-messages` endpoints the extension no longer
  injects `web_search_20250305`, no longer strips a function-tool `web_search` (pi-websearch keeps working as the
  fallback), strips any hook-injected native `web_search_*` variant plus an orphaned `tool_choice`, and skips the
  web-search system prompt section.
- `test/suite/anthropic-web-search-extension.test.ts`: added kimi-coding-shaped regression coverage for
  non-injection, native-variant stripping, compat opt-in, and prompt-section gating.

### Why

- Anthropic-compatible endpoints such as kimi-coding accept the injected native tool and execute the server-side
  search, but reject the replayed `server_tool_use` / `web_search_tool_result` blocks on the next request
  (kimi-coding 400s with `tool_call_id is not found`), wedging the session mid-turn.

### Why extension system couldn't handle this alone

- It can (this is the extension-side half); `pi-ai` additionally strips unsupported `web_search_*` tools after all
  hooks run (see `packages/ai/src/changes.md` 2026-07-16) so payloads from other extensions are covered too.

### Expected merge conflict zones

- MEDIUM: `builtin/anthropic-web-search/index.ts` if upstream reshapes native web tool payload handling.
- LOW: `test/suite/anthropic-web-search-extension.test.ts` fixtures.

## 2026-07-10 - Tool renderer image protocol context

### What changed

- Added optional `ToolRenderContext.imageProtocol`, exposing `"kitty"`, `"iterm2"`, or `null` to tool call and result renderers.
- The interactive host owns native image rendering and Kitty conversion fallbacks, allowing custom renderers to suppress duplicate image indicators when a terminal image protocol is active.
- Documented the field in the exhaustive tool renderer context list in `docs/extensions.md`.

### Why

- Custom renderers need the active terminal image capability to coordinate their text output with host-owned image rendering without leaving image-only results blank or rendering duplicate fallbacks.

### Why extension system couldn't handle this alone

- `ToolRenderContext` is a public host-to-extension contract, and the active image protocol plus native/fallback image lifecycle are owned by the interactive renderer.

### Expected merge conflict zones

- MEDIUM: `types.ts` around `ToolRenderContext` as upstream adds renderer context fields.
- LOW: `modes/interactive/components/tool-execution.ts` around host-owned image composition.

## 2026-07-07 - Persistent-terminal builtin extension

### What changed

- Added builtin extension id `terminal` in `builtin/index.ts`, registered AFTER `bash-timeout` and
  `anthropic-bash`. It swaps the core `bash` for a PTY-backed `bash` (adds `run_in_background`, `cols`,
  `rows`, mode-aware `timeout`) and registers four snake_case companion tools — `bash_output`
  (`wait_for`/`filter`/`view:screen`), `bash_input` (stdin + named keys), `bash_resize`, `kill_bash` —
  backed by the new `@earendil-works/pi-pty` package (native ConPTY/portable-pty + `@xterm/headless`
  screen, with a child_process pipe fallback).
- The extension is MUTUALLY EXCLUSIVE with `anthropic-bash`: on `session_start` AND `model_select` it
  re-evaluates `isAnthropicBashEnabled() && model.api === "anthropic-messages"` and deactivates the
  companions (one-line notice) so none dangle when native Anthropic bash strips/replaces `bash`; when
  the condition clears it re-activates the PTY `bash` + companions. It injects a prompt section on
  `before_agent_start` (skipped while stepped aside) and tears the manager down on `session_shutdown`.
- `builtin/permission-system/parsers.ts`: registered a `bash_input` parser that classifies it in the
  `bash` permission class (via its `input` field), because writing stdin to a live shell is arbitrary
  command execution and must not be bypassable under `read-only`/`ask` presets.

### Why

- senpi lacked Claude-Code-shaped persistent/background terminal sessions (stdin steering, resize, live
  screen snapshot, `wait_for` subscription, clean tree-kill). Shipping it as a builtin extension keeps
  the PTY runtime, tool surface, and provider-exclusion logic out of the high-conflict core session
  runtime, reusing the gpt-apply-patch tool-swap and bash-timeout injection precedents.

### Why extension system couldn't handle this alone

- The mutual-exclusion swap must restore the ORIGINAL core `bash` definition (extension tools override
  base tools by name in `_refreshToolRegistry`), and `bash_input` permission gating must live in the
  builtin permission parser registry — both are builtin/registration surfaces, not user-extension
  surface. Shell-kind resolution for non-bash shells lives in core `utils/shell.ts` (see
  `utils/changes.md`).

### Expected merge conflict zones

- MEDIUM: `builtin/index.ts` registration array near `bash-timeout` / `anthropic-bash` (other trains
  insert builtins here). Resolution: keep `terminal` after both.
- LOW: `builtin/permission-system/parsers.ts` `registry.register` block (see its own `changes.md`).
- LOW: `builtin/terminal/**` self-contained sources.

## 2026-07-06 - Bundled codemode extension

### What changed

- `@code-yeongyu/senpi-codemode` is loaded as a default-on builtin-adjacent extension from its package manifest.
- `disabledBuiltinExtensions: ["codemode"]` disables the bundled extension, while `--no-extensions` only disables user extension discovery.
- Interactive permission prompts raised by tools called inside codemode bridge cells suspend the cell until the prompt resolves; denial returns an error reply to the kernel instead of hanging.

### Why

- Codemode must be available by default while still using the normal extension loader, active-tool filtering, hook pipeline, and permission system.

### Expected merge conflict zones

- MEDIUM: `resource-loader.ts` around builtin-adjacent extension ordering and package shadowing.

## 2026-07-06 - Extension executeTool API

### What changed

- Added `pi.executeTool(toolName, params, options?)` plus exported option, result, update-callback, and typed error aliases.
- `executeTool` resolves only from the active session tool set, runs the same argument preflight as the agent loop, emits `tool_call` and `tool_result` hooks, and executes the wrapped registered tool with extension context intact.
- Bridge subcalls intentionally do not emit `tool_execution_start`, `tool_execution_update`, or `tool_execution_end` UI events. Callers should stream their parent tool UI through the supplied `onUpdate` callback.

### Why

- Codemode kernels need to call built-in and extension-registered tools without bypassing permissions, hook mutation/blocking, result rewriting, or extension-scoped execution context.

### Expected merge conflict zones

- HIGH: `types.ts` around `ExtensionAPI` and action handler types.
- MEDIUM: `loader.ts` and `runner.ts` around `bindCore` action wiring.
- MEDIUM: `agent-session.ts` around tool hook installation and active tool dispatch.

## 2026-07-07 - MCP W1 builtin implementation

### What changed

- The `mcp` builtin skeleton is now the full W1 implementation: TypeBox-validated config discovery/merge (global,
  project, imported Claude configs), stdio + StreamableHTTP transports, a per-server connection state machine, a
  process-owned service lifecycle (`lazy` / `eager` / `keep-alive`), end-to-end tool registration with spec-correct
  call semantics, the `/mcp` command suite, tool exposure policy (`auto` / `direct` / `search` / `proxy`), server
  instructions injection, and secret-redacting per-server logging. Per-module details: `builtin/mcp/changes.md`.

### Why

- W1 turns the registered no-op skeleton into working MCP support while keeping every moving part inside the builtin
  extension boundary.

### Why extension system couldn't handle this alone

- It did: W1 uses only the public `pi.*` API (`registerTool`, `registerCommand`, `session_start`,
  `before_agent_start`, `session_shutdown`). No `types.ts` or `runner.ts` change was needed.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration order near the final builtin entries.
- NONE: `types.ts` (untouched by MCP W1); `builtin/mcp/` does not exist upstream.

## 2026-07-06 - MCP builtin extension skeleton

### What changed

- Added builtin extension id `mcp` at the end of the builtin registration list, with a no-op lifecycle skeleton and
  official MCP SDK wrap point.

### Why

- MCP support needs to ship as a builtin extension so future server lifecycle, tool exposure, and provider-payload
  handling stay out of the high-conflict core session runtime.

### Why extension system couldn't handle this alone

- This is the builtin extension registration itself. The skeleton uses existing extension lifecycle hooks and does not
  add new public extension API surface.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration order near the final builtin entries.
- LOW: `builtin/mcp/` as later MCP implementation phases fill in the skeleton.

## 2026-07-04 - Tool hook status `update` phase and `ctx.updateToolHookStatus()`

### What changed

- `types.ts`: tool hook lifecycle events gained an `update` phase, and tool-hook-capable event contexts gained an
  optional `updateToolHookStatus(statusMessage)` method so `tool_call` / `tool_result` handlers can publish live
  status text while a hook runs.
- `runner.ts`: dispatches the update-phase status events to the host.
- `builtin/hooks/`: the dispatcher forwards configured command-hook `statusMessage` values (previously parsed and
  trust-hashed but never rendered) through the new update phase, so the TUI hook row shows the live hook identity
  instead of a static per-extension guess.
- `docs/extensions.md` documents the new API; rendering side is in `modes/interactive/changes.md`.

### Why

- Users could not tell which hook was running or what it was doing during `Running PreToolUse/PostToolUse hook` rows.

### Why extension system couldn't handle this alone

- This is a public extension API addition: the event union, context method, and runner emit helper all live in the
  extension system itself.

### Expected merge conflict zones

- MEDIUM: `types.ts` around the tool hook lifecycle event union and context method declarations.
- LOW: `runner.ts` emit helpers; `builtin/hooks/dispatcher.ts` status forwarding.

## 2026-07-02 - Extension entry renderer sync

### What changed

- `types.ts`, `runner.ts`, `loader.ts`, and `index.ts`: accepted upstream extension entry-renderer support for persisted
  display-only session entries.
- `agent-session.ts` and interactive rendering now use those renderers so custom entries can render in persisted order
  without being sent back to the model context.

### Why

- Extensions need a typed way to render custom session entries that are display-only, survive persistence, and do not
  mutate the model transcript.

### Why extension system couldn't handle this alone

- This is an extension-system API addition: the runner, loader, exported types, session dispatch, and interactive renderer
  all need matching core support before an extension can provide an entry renderer.

### Expected merge conflict zones

- MEDIUM: `types.ts` around extension API and entry renderer type definitions.
- MEDIUM: `runner.ts` and `loader.ts` around renderer registration/loading.
- LOW: `index.ts` exports if upstream changes extension type re-exports.

## 2026-06-29 - Builtin hooks extension runtime resource plumbing

### What changed

- Added builtin extension id `hooks` before `permission-system` so builtin command hooks can inspect tool calls before permission prompts.
- Added `ResourcesDiscoverResult.hookPaths`, `ResourceExtensionPaths.hookPaths`, `DefaultResourceLoader.getLoadedHookSources()`, and `ExtensionContext.getLoadedHookSources()` for hook config source injection.
- `ExtensionRunner.emitResourcesDiscover()` now collects hook paths, and `AgentSession.extendResourcesFromExtensions()` passes them to the resource loader as runtime hook sources.
- `builtin/hooks/index.ts` now loads settings/default files, pre-session hook paths, and runtime hook paths lazily; malformed hook sources become diagnostics instead of startup failures.
- Registered `/hooks` for command-output diagnostics and basic loaded-hook status.

### Semantics

- Initial `SessionStart` only sees pre-session sources: settings/default hook files and `DefaultResourceLoaderOptions.additionalHookPaths`.
- Runtime `hookPaths` returned from `resources_discover` are late sources. They are visible to later hook events in the current runtime and to reload/next-session `SessionStart`, where `SessionStart` hooks from runtime sources emit the existing caveat diagnostic.
- Malformed user/runtime hook JSON is nonfatal. Managed or builtin hook safety invariant failures remain hard failures at the dispatch layer rather than being trusted silently.

### Expected merge conflict zones

- MEDIUM: `types.ts` public API additions around `ExtensionContext`, `ResourcesDiscoverResult`, and `ExtensionContextActions`.
- MEDIUM: `runner.ts` resource discovery aggregation and context construction.
- MEDIUM: `resource-loader.ts` extension resource plumbing.
- LOW: `agent-session.ts` `extendResourcesFromExtensions()` resource handoff.
- LOW: `builtin/index.ts` registration order near `permission-system`.

## 2026-06-15 - Remove legacy Kimi-specific web-search builtin; fold Kimi search into pi-websearch

### What changed

- Removed the legacy Kimi-specific web-search builtin and its registration in `builtin/index.ts`. Its search/fetch tools no longer exist.
- Kimi search is now a `pi-websearch` provider (`kimi`, vendored at 0.2.0). On a `kimi-coding` model the native auto-route prepends a `kimi` entry (api.kimi.com/coding/v1/search) using the model API key, so `web_search` works zero-config and falls back to the configured chain. URL fetching is handled by the `webfetch` builtin.
- `test/suite/regressions/3592-...test.ts`: dropped `kimi_search_web` / `kimi_fetch_url` from the tool-list expectations.

### Why

- One web-search surface instead of two. Kimi's coding search fits pi-websearch's provider + native-route architecture, so the standalone builtin was redundant.

### Expected merge conflict zones

- LOW: `builtin/index.ts` registration array; `builtin/websearch/` vendored sources (re-vendor from `../pi-extensions/pi-websearch`).

## 2026-05-15 - OpenAI native web search endpoint compatibility

### What changed

- `builtin/openai-web-search/index.ts`: The extension now passes the full selected model into OpenAI native web search handling and only injects `web_search_preview` for Azure Responses, official `api.openai.com` OpenAI Responses, or custom Responses models with `compat.supportsWebSearchPreview: true`.
- Custom OpenAI Responses endpoints now strip OpenAI native `web_search_preview` / `web_search_preview_*`, matching `tool_choice`, and `web_search_call.action.sources` includes by default while preserving ordinary function tools such as a configurable `web_search`.
- `model-registry.ts`: Added `compat.supportsWebSearchPreview` to the models.json schema so users can opt custom OpenAI-compatible providers into native web search support.
- `test/suite/openai-web-search-extension.test.ts`: Added regression coverage for default custom-endpoint stripping and explicit opt-in preservation.

### Why

- The failing GPT-5.5 session used an `openai-responses` model pointed at a custom proxy endpoint. The old extension keyed only on `api`, injected OpenAI-native `web_search_preview`, and the downstream endpoint rejected the tool schema. Matching the `../ai` and `../opencode` pattern means provider-native tools are only sent when the endpoint explicitly supports that provider's native tool dialect.

### Why extension system couldn't handle this alone

- The extension can prevent its own automatic injection, but the selected model's endpoint capability is the real decision point. The companion `pi-ai` provider guard still handles later hook mutations after this extension runs.

### Expected merge conflict zones

- LOW: `builtin/openai-web-search/index.ts` around `addOpenAiWebSearchToPayload()` and `before_agent_start`.
- LOW: `model-registry.ts` provider compat schema if upstream adds more Responses compatibility fields.

## 2026-05-15 - OpenAI native web_search_preview strip for non-OpenAI-Responses payloads

### What changed

- `builtin/openai-web-search/index.ts`: When `ctx.model.api` is not an OpenAI Responses variant, the extension now also scans `payload.tools` for OpenAI native `web_search_preview` / `web_search_preview_*` entries and strips them before the request leaves senpi. The OpenAI Responses path (inject + Anthropic-tool sanitize) is unchanged.
- `test/suite/openai-web-search-extension.test.ts`: Added regression coverage for stripping `web_search_preview`, the versioned `web_search_preview_2025_03_11` variant, the `openai-completions` case, the disabled-via-env case, and a no-op assertion guaranteeing Anthropic-native `web_search_*` / `web_fetch_*` entries are left intact on anthropic-messages payloads.

### Why

- Anthropic rejects requests whose `tools[]` contains `type: "web_search_preview"` with `tools.N: Input tag 'web_search_preview' found using 'type' does not match any of the expected tags`. The leak shows up for users whose `openai` provider is wired to a proxy that translates `openai-responses` → `anthropic-messages` (e.g., ccapi / quotio when routing claude-* models) and forwards `web_search_preview` verbatim. Defense-in-depth stripping ensures senpi never lets the OpenAI-only tool reach Anthropic-format backends regardless of how it ended up in the payload.

### Why extension system couldn't handle this alone

- The fix is entirely inside the existing `openai-web-search` builtin extension via `before_provider_request`. No core or pi-ai change required.

### Expected merge conflict zones

- LOW: `builtin/openai-web-search/index.ts` early-return branch in `addOpenAiWebSearchToPayload` if upstream restructures the non-OpenAI-Responses fall-through path.

## 2026-05-15 - OpenAI Chat Completions Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the provider request guard to run an OpenAI Chat Completions payload sanitizer after the Anthropic and OpenAI Responses sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts`: Added Chat Completions request message repair that drops orphan or duplicate `role: "tool"` messages and inserts synthetic `role: "tool"` results for interrupted assistant `tool_calls`.
- `test/tool-pair-guard/sanitize-openai-chat-completions-payload.test.ts`: Added regression coverage for valid-pair no-op behavior, orphan output removal, duplicate output removal, and missing output synthesis before transcript advance or payload end.

### Why

- OpenAI-compatible Chat Completions providers reject `role: "tool"` messages whose `tool_call_id` has no preceding assistant `tool_calls` entry. Persisted or compacted sessions with stale tool outputs can otherwise keep replaying the same invalid payload and fail with HTTP 400.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-chat-completions-payload.ts` if upstream adds an equivalent Chat Completions pairing normalizer.

## 2026-05-15 - OpenAI Responses Tool Pair Guard

### What changed

- `builtin/tool-pair-guard/index.ts`: Extended the existing provider request guard to run both Anthropic and OpenAI Responses payload sanitizers.
- `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts`: Added OpenAI Responses request input repair that drops orphan `function_call_output` / `custom_tool_call_output` items and inserts synthetic outputs for interrupted calls that have no result.
- `test/tool-pair-guard/sanitize-openai-responses-payload.test.ts`: Added regression coverage for orphan output removal, missing output synthesis, valid-pair no-op behavior, and `previous_response_id` delta preservation.

### Why

- OpenAI Responses rejects requests with `No tool call found for function call output with call_id ...` when a stale tool output survives without its matching call. Once such history is persisted, follow-up prompts can repeatedly send the same invalid output and leave the session stuck.

### Why extension system couldn't handle this alone

- The fix does use the extension system: `tool-pair-guard` is a builtin extension that repairs provider payloads through `before_provider_request`. No core provider or agent loop change was required.

### Expected merge conflict zones

- LOW: `builtin/tool-pair-guard/index.ts` if upstream changes provider-request hook wiring.
- LOW: `builtin/tool-pair-guard/sanitize-openai-responses-payload.ts` if upstream adds an equivalent OpenAI Responses pairing normalizer.

## 2026-05-15 - Normalize remaining senpi internal names

### What changed

- `builtin/system-messages.ts`: Renamed the exported conversation constants, event type names, and helper function names to the `SENPI_*` / `Senpi*` spelling, and changed the emitted conversation event name to `senpi:conversation`.
- `builtin/todotools/system-messages.ts`: Applied the same event-name and constant-name cleanup to the vendored todotools helper.
- `builtin/todotools/state.ts`: Changed the todo state custom entry type to `senpi.todo-state`.
- `test/suite/senpi-conversation.test.ts`: Renamed the regression test file and assertions to match the senpi runtime naming.

### Why

- The fork identity is `senpi`, and the remaining internal directive/event/state/env names should carry the same identity instead of preserving an earlier spelling.

### Why extension system couldn't handle this alone

- These names are builtin extension wire constants and session custom-entry identifiers. They must be emitted correctly by the bundled implementation before user or external extensions can observe them.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts`, `builtin/todotools/system-messages.ts`, and `builtin/todotools/state.ts` if upstream or vendored builtins rename these helper surfaces.

## 2026-05-14 - Native Web Tool UI Cleanup Hooks

### What changed

- `builtin/anthropic-web-search/index.ts`: Added session/model UI cleanup for Anthropic native `web_search` so older startup widgets are cleared.
- `builtin/openai-web-search/index.ts`: Added session/model UI cleanup for OpenAI Responses native `web_search_preview` so older startup widgets are cleared.
- `test/suite/anthropic-web-search-extension.test.ts` and `test/suite/openai-web-search-extension.test.ts`: Added regression coverage that native web tool extensions do not leave startup/footer widgets behind.

### Why

- Native provider web search is injected below the function-tool layer, but always-on footer widgets for that availability are too noisy. The UI should stay quiet until an actual tool execution or provider response needs rendering.

### Why extension system couldn't handle this alone

- These are already builtin extensions responsible for native provider payload mutation; the useful UI state belongs beside that injection logic.

### Expected merge conflict zones

- LOW: `builtin/anthropic-web-search/index.ts` and `builtin/openai-web-search/index.ts` if native web tool payload handling changes upstream.

## 2026-05-13 - Rename injected system prefix to senpi

### What changed

- `builtin/system-messages.ts`: Changed the injected builtin system-message prefix to `[system:senpi]`.
- `builtin/todotools/system-messages.ts`: Applied the same prefix change to the vendored todotools helper.
- `test/suite/senpi-conversation.test.ts`: Added regression coverage that both helpers emit the `senpi` marker.

### Why

- The runtime identity is `senpi`, so internally injected reminder/follow-up messages should use the matching `[system:senpi]` marker.

### Why extension system couldn't handle this alone

- The marker is emitted by bundled helper modules used by builtin extensions before handing messages to the agent runtime.

### Expected merge conflict zones

- LOW: `builtin/system-messages.ts` and `builtin/todotools/system-messages.ts` if the helper modules are renamed or consolidated.

## 2026-05-12 - Externalize todotools vendored builtin source

### What changed

- Added `pi-todotools` to the vendored builtin sync manifest and `sync-builtin-extensions.mjs` mapping.
- Refreshed `builtin/todotools/` from the standalone `../pi-extensions/pi-todotools` source while preserving the `todowrite` builtin id and tool names.
- Added local `todotools/settings.ts` and `todotools/system-messages.ts` helpers so the extracted extension uses only public package APIs externally.
- Updated sync coverage to pin the `pi-todotools` package version.

### Why

- Todo tools are now maintained as a public sibling extension like other vendored builtins, while senpi continues shipping the feature in the binary.

### Why extension system couldn't handle this alone

- senpi's builtin list is assembled by core resource loading; shipping a sibling extension as a builtin still requires vendored source and the builtin sync manifest.

### Expected merge conflict zones

- `builtin/todotools/` if upstream adds its own todo tooling.
- `builtin/external-versions.json` and `scripts/sync-builtin-extensions.mjs` if more vendored packages are added.

## 2026-05-11 - GPT apply_patch Realtime Progress Rendering

### What changed

- `builtin/gpt-apply-patch/types.ts`: Added progress metadata for partial apply_patch updates.
- `builtin/gpt-apply-patch/apply.ts`: Added an optional progress callback emitted after each patch operation.
- `builtin/gpt-apply-patch/preview.ts` and `tool.ts`: Render pending updates as `Applying patch (done/total)` while preserving rich diff previews.
- `test/suite/gpt-apply-patch-extension.test.ts` and `gpt-apply-patch-rich-render.test.ts`: Added regression coverage for realtime progress updates and pending widget titles.

### Why

- Multi-file apply_patch calls previously showed a single pending diff preview and did not update the TUI as individual operations completed.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; progress has to be emitted from its apply loop and rendered by its tool result renderer.

### Files modified

- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `builtin/gpt-apply-patch/tool.ts`
- `builtin/gpt-apply-patch/index.ts`
- `../../test/suite/gpt-apply-patch-extension.test.ts`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/apply.ts` apply loop callback wiring.
- LOW: `builtin/gpt-apply-patch/tool.ts` pending update render title.

## 2026-05-11 - GPT apply_patch OpenCode-style Diff Rendering

### What changed

- `builtin/gpt-apply-patch/preview-format.ts`: Reworked expanded patch previews to render OpenCode-like diff rows with colored signs, muted line numbers, added/removed row backgrounds, syntax highlighting when a TUI theme is available, and inverse inline word highlights for paired edits.
- `builtin/gpt-apply-patch/types.ts`: Added `toolErrorBg` to the local theme background type used by apply_patch row rendering.
- `test/suite/gpt-apply-patch-rich-render.test.ts`: Added regression coverage for row background colors and inline added/removed highlights.
- `builtin/external-versions.json`: Bumped the vendored `pi-apply-patch` snapshot metadata to `0.1.1`.

### Why

- The previous rich preview only colored whole `+` / `-` lines and did not match OpenCode's edit/apply_patch diff visual hierarchy closely enough.

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is already the builtin extension; the change is inside its own TUI render path.

### Files modified

- `builtin/gpt-apply-patch/preview-format.ts`
- `builtin/gpt-apply-patch/types.ts`
- `builtin/gpt-apply-patch/index.ts`
- `builtin/external-versions.json`
- `../../test/suite/gpt-apply-patch-rich-render.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/preview-format.ts` render helpers.
- LOW: `builtin/gpt-apply-patch/types.ts` local theme background union.

## 2026-05-11 - GPT apply_patch External Path Support

### What changed

- `builtin/gpt-apply-patch/workspace.ts`: Removed workspace-boundary and realpath validation from path resolution.
- `builtin/gpt-apply-patch/apply.ts` and `preview.ts`: Resolve patch paths with Node `path.resolve(cwd, filePath)` and allow absolute, parent-escaping, and symlink-escaping targets.
- `test/suite/gpt-apply-patch-backport.test.ts`: Added regression coverage for absolute paths outside the current workspace and symlink paths resolving outside it.

### Why

- Codex-style patch payloads can legitimately target files outside the session cwd, for example adjacent worktrees or debug journals. The previous guard rejected those paths with `File references must stay within the current workspace.`

### Why extension system couldn't handle this alone

- `gpt-apply-patch` is a builtin extension and the path policy lives inside its vendored implementation.

### Files modified

- `builtin/gpt-apply-patch/workspace.ts`
- `builtin/gpt-apply-patch/apply.ts`
- `builtin/gpt-apply-patch/preview.ts`
- `../../test/suite/gpt-apply-patch-backport.test.ts`

### Expected merge conflict zones on next upstream sync

- LOW: `builtin/gpt-apply-patch/workspace.ts` path resolution helpers.
- LOW: `builtin/gpt-apply-patch/apply.ts` and `preview.ts` imports/call sites for the path resolver.

## 2026-05-08 - Generated Default Extension Factory Resolver

### What changed

- `loader.ts`: `loadExtensions()` now accepts an optional factory resolver and creates the jiti importer lazily only when an extension path is not resolved to a known factory.
- `builtin/index.ts`: Exposes a keyed map for the four global default extension factories used by generated shims.

### Why

- The default global extension shim files are deterministic. Letting core resolve those shims to known factories avoids the jiti import path without changing extension order, source paths, or behavior for custom extension files.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot intercept the module importer before their factories have been loaded.

### Files modified

- `loader.ts`
- `builtin/index.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtension()` and `loadExtensions()` signatures/importer construction.
- LOW: `builtin/index.ts` around global default extension registration.

## 2026-05-08 - Shared Jiti Extension Importer

### What changed

- `loader.ts`: Reuses one `jiti` importer across each `loadExtensions()` batch while keeping `moduleCache: false` for reload freshness.
- `loader.ts`: Aliases upstream `@mariozechner/pi-*` peer imports to the already-loaded senpi workspace packages.

### Why

- Startup was spending several seconds creating a fresh `jiti` instance for every configured extension, causing repeated TypeScript/dependency resolution work before the first TUI frame.
- Installed pi extensions still import upstream `@mariozechner/pi-coding-agent`, `pi-ai`, and `pi-tui` peer names. Without aliases, jiti can fall through to each extension's own `node_modules` and load a duplicate pi runtime.

### Why extension system couldn't handle this alone

- Extension loading is core infrastructure; extensions cannot change how the core loader imports extension modules.

### Files modified

- `loader.ts`

### Expected merge conflict zones on next upstream sync

- MEDIUM: `loader.ts` around `loadExtensionModule()`, `loadExtension()`, and `loadExtensions()` importer construction.

## 2026-04-30 - Model Switch System Prompt Change Event

### What changed

- `types.ts`: Added `ModelSelectEventResult` and `SystemPromptChangeEvent`, plus `pi.on("system_prompt_change", ...)` typing.
- `runner.ts`: Added `emitModelSelect()` so `model_select` handlers can request an active system prompt replacement.
- `builtin/prompt-preset/index.ts`: Returns the resolved prompt preset during `model_select`, including fallback reset when no preset applies.

### Why

- Prompt presets previously updated the system prompt only at `before_agent_start`, so a mid-session model switch did not immediately update the active prompt or expose a typed event for observers.

### Why extension system couldn't handle this alone

- Extensions could listen to `model_select`, but the runner ignored handler return values and there was no typed `pi.on` event for the resulting system prompt change.

### Files modified

- `types.ts`
- `runner.ts`
- `builtin/prompt-preset/index.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` around model/agent event unions and `ExtensionAPI.on` overloads.
- HIGH: `runner.ts` around event emission helpers.

### Migration notes

- Preserve the invariant that `system_prompt_change` fires only after the active prompt string actually changes.

## 2026-04-28 - Compaction Settings Context API

### What changed

- `types.ts`: Added `ExtensionContext.getCompactionSettings()` and matching `ExtensionContextActions.getCompactionSettings`.
- `runner.ts`: Wired the new context action through `bindCore()` and `createContext()`.
- `agent-session.ts`: Bound the context action to `settingsManager.getCompactionSettings()`.
- `interactive-mode.ts`: Added the same method to inline shortcut `ExtensionContext` construction.

### Why

- The builtin compaction extension previously used `DEFAULT_COMPACTION_SETTINGS`, which bypassed user/project settings such as `compaction.enabled: false`.
- Plugsuit-style threshold realignment needs resolved settings for speculative toggles, cooldowns, keep-recent caps, and restoration budgets.

### Why extension system couldn't handle this alone

- Extensions receive `ExtensionContext`, not the core `SettingsManager`; without a typed context method, builtin extensions cannot read the already-merged global/project/user compaction settings.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

- If upstream adds settings access to `ExtensionContext`, keep this method or map the builtin compaction extension to the upstream equivalent. The required invariant is that compaction policy uses resolved settings, never hardcoded defaults.

## 2026-04-27 - Seam 3: Compaction Apply Context API

### What changed

- `types.ts`: Added `ApplyCompactionOptions`, `ApplyCompactionResult`, `ExtensionContext.getMessageRevision()`, and `ExtensionContext.applyCompaction()`.
- `runner.ts`: Wired the new context actions through `bindCore()` and `createContext()` so extensions can read the current message revision and apply a precomputed compaction result.
- `interactive-mode.ts`: Added the same methods to the inline shortcut `ExtensionContext` literal.

### Why

- Speculative/v2 compaction needs a stable compare-and-apply seam: extensions can prepare a compaction summary against revision N and only apply it if no context-affecting message mutation has happened since.
- `getMessageRevision()` is intentionally monotonic and in-memory only; it is a staleness guard, not persisted session data.
- `applyCompaction()` returns explicit `ok`, `stale`, or `rejected` outcomes so extensions can avoid racing the live session.

### Why extension system couldn't handle this alone

Extensions can observe hooks and return summaries during a core-driven compaction, but they cannot append a compaction entry, rebuild agent context, emit core compaction events, or atomically guard against stale session context without a typed core API.

### Files modified

- `types.ts`
- `runner.ts`
- `interactive-mode.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `interactive-mode.ts` shortcut context literals must retain parity with `ExtensionRunner.createContext()`.

### Migration notes

If upstream adds new `ExtensionContext` methods or changes `AgentSession` message mutation logic, preserve the monotonic revision counter and the `applyCompaction()` compare-and-apply semantics. The revision guard must remain in-memory and advance on every context-affecting mutation. Do not let upstream's `ExtensionContext` additions shadow the new methods.

## 2026-05-15 - Compaction Feedback Context API

### What changed

- `types.ts`: Added optional `ExtensionContext.beginCompaction()` and `ExtensionContext.endCompaction()` methods.
- `runner.ts`: Wired the new optional context actions through `bindCore()` and `createContext()`.
- `agent-session.ts`: Supplies the context actions with the same abort controller and canonical compaction events used by core compaction routes.

### Why

- Builtin speculative compaction can generate or await a summary before it calls `applyCompaction()`.
- That wait must still surface as a normal compaction to TUI/RPC consumers so loaders, cancellation, and input queueing work while the summary is in flight.

### Why extension system couldn't handle this alone

UI notifications alone cannot update `AgentSession.isCompacting`, participate in `abortCompaction()`, or emit the canonical compaction event pair.

### Files modified

- `types.ts`
- `runner.ts`
- `agent-session.ts`
- `builtin/compaction/index.ts`
- `modes/interactive/interactive-mode.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` and `runner.ts` around `ExtensionContext`/`ExtensionContextActions` definitions and context construction.
- HIGH: `agent-session.ts` around compaction abort-controller ownership and `applyCompaction()` event emission.

### Migration notes

Keep `beginCompaction()`/`endCompaction()` optional for third-party context mocks, but preserve runner support so builtin extensions receive the real core-backed implementation.

## 2026-04-27 - Seam 1: Compaction Event Metadata

### What changed

- `types.ts` line ~85: Added `CompactionReason` and `CompactionRejectionCause` exported literal-union aliases.
- `types.ts` lines ~541-554: Added `reason`, `willRetry`, and `requestId` metadata to `SessionBeforeCompactEvent`.
- `types.ts` lines ~549-554: Added `reason`, `requestId`, `accepted`, and optional `rejectionCause` metadata to `SessionCompactEvent`.
- `agent-session.ts` lines ~1651, ~1713, ~1910, and ~1986: Populated the 4 existing compaction event construction sites with the new required metadata fields. T15 will refactor these construction sites into the unified `_executeCompaction()` pipeline. T13 only populates the new required fields with minimal correct values to keep tsgo passing.

### Why

- Extensions cannot safely apply route-specific policies such as cooldown scope or circuit-breaker counters without knowing the compaction source.
- The user explicitly required consistency across the 6 compaction routes; this metadata is the prerequisite.
- `reason` always preserves the route source, while `rejectionCause` explains why a compaction was rejected when `accepted` is false.

### Why extension system couldn't handle this alone

Event payloads are core-defined types. Extensions can consume compaction events, but they cannot add typed fields to those events from outside the core extension API.

### Files modified

- `types.ts`
- `agent-session.ts`

### Expected merge conflict zones on next upstream sync

- HIGH: `types.ts` is high-churn upstream, especially around extension event definitions. Resolution: preserve additive compaction metadata and keep `reason` semantically separate from `rejectionCause`.

### Migration notes

If upstream modifies compaction event definitions in `types.ts`, preserve the additive metadata fields (`reason`, `willRetry`, `requestId`, `accepted`, `rejectionCause`) and keep them semantically separate from upstream's existing fields. Update the 4 event construction sites in `agent-session.ts` to populate the new fields with the correct route-specific values.

## 2026-04-13 - GPT apply_patch builtin support

### What changed and why

- Added builtin `gpt-apply-patch` extension support so OpenAI GPT sessions can swap `write`/`edit` for a Codex-style `apply_patch` tool and react to mid-session model changes.
- Extended extension/tool plumbing to carry OpenAI Responses freeform grammar metadata. This core change was necessary because the existing extension API only modeled JSON-schema function tools, which made exact Codex GPT `apply_patch` parity impossible from an extension alone.

### Files modified

- `types.ts`
- `builtin/index.ts`
- `builtin/gpt-apply-patch/index.ts` (vendored from `pi-apply-patch`)

### Why the extension system couldn't handle this alone

- `ToolDefinition` had no way to express freeform grammar tools, only JSON-schema parameters.
- Wrapper plumbing dropped any provider-specific tool metadata before requests reached `pi-ai`.

### Expected merge conflict zones

- `types.ts` around `ToolDefinition`
- `builtin/index.ts` builtin registration ordering

## Extensions can emit capability-gated RPC events (2026-08-11)

Extension APIs now expose `pi.rpc.emit(name, data)`. It validates a non-empty name and publishes an
opaque payload on the generation-owned extension bus; it does not write to a transport directly.
Keep ordinary `pi.events` extension-local, and keep RPC delivery opt-in at the connection boundary.

## 2026-09-12 - Upstream sync (upstream/main@71dca871) integration repairs

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts`: fork loader (per-cwd LRU module cache capped at `MAX_EXTENSION_CACHE_CWD_ENTRIES`, `@code-yeongyu/senpi` alias table, pending provider registration queue, read-classifier and MCP declaration registration, RPC event channel) with `registerTool` running the fork `runtime.assertActive()` and `tool_search` reservation first and then upstream's object-schema parameter check with its exact error text (D-O).

### Why

- Extension registration has to keep the fork's isolation and reserved-name rules while rejecting non-object tool schemas the same way upstream does.

### Why an extension could not handle it

- The loader is what instantiates extensions; its validation order is not visible to them.

### Expected merge conflict zones

- MEDIUM: `registerTool` in `createExtension`; the alias table and importer factory.

## Adopted upstream v1.0.0 extension loader (2026-10-02)

### What changed

- `packages/coding-agent/src/core/extensions/loader.ts` — upstream extension loading changes are kept while the fork's eval-only policy stays.

### Why

The fork's eval-only extension policy is preserved and tested; upstream's loader improvements are adopted underneath.

### Why an extension could not handle it

Extension loading is the core loader itself, not expressible as an extension.

### Expected merge conflict zones

Upstream edits to the extension loader at the next sync.

## ExtensionContext.browserEngine (2026-10-03)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.browserEngine?: BrowserEngine` and the optional `ExtensionContextActions.getBrowserEngine`.
- `packages/coding-agent/src/core/extensions/runner.ts`: the context getter and its bound action (default `undefined`).
- `packages/coding-agent/src/core/extensions/builtin/terminal/tools/bash.ts`: the PTY bash tool exports `OMO_BROWSER_ENGINE` from the session context and marks it for removal when the session chose none.

### Why

A shared RPC host serves many sessions, so the browser engine an opener chose (`open_session.browserEngine`) must travel with the session, not the process. Extensions and the tool subprocesses they spawn read it from the session context like the other per-session values.

### Why an extension could not handle it

The value lives in the session's launch profile and the bash tool environment is assembled in core.

### Expected merge conflict zones

The context getter block in `runner.ts` (next to `goalStoreFile`) and the `SessionEnvSource` / `sessionEnvOverrides` pair in the terminal bash tool.

## 2026-10-04 — `ExtensionUIDialogOptions` names the tool call a dialog is about (#2710)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIDialogOptions` gains optional `toolCallId` and `parentToolCallId`. UI contexts that do not use them (TUI, print) ignore them.

### Why

The engine runs a message's `tool_call` hooks (where the permission system asks) for every call before any of them runs, so with several calls of one tool in flight a client could not tell which call a prompt approved (#2710). The desktop had to show "the code can't be shown" for every prompt after the first.

### Why an extension could not handle it

The dialog options type is the public extension API that every UI context receives; the field has to exist there for the permission extension to hand the id to the RPC context.

### Expected merge conflict zones

The `ExtensionUIDialogOptions` interface in `types.ts`.

## 2026-10-11 - Share usable compaction model selection (senpi#3131)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: optional `getCompactionModel` resolves the session's usable summary model.
- `packages/coding-agent/src/core/extensions/runner.ts`: forwards that callback with the existing active-runner lease checks.

### Why

Builtin summarization must obey the same spent-account state and held-switch target as core compaction.

### Why an extension could not handle it

Only the session owns account suppression and pending model selection.

### Expected merge conflict zones

The compaction context/action declarations in `types.ts` and callback storage, binding, and context construction in `runner.ts`.
## 2026-10-16 - Observe preview prompt contributions (senpi#3483)

### What changed

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBeforeAgentStart` accepts a preview-only observer receiving each handler's extension path and exact before/after prompt strings. The real-turn behavior is unchanged.
- `packages/coding-agent/src/core/extensions/types.ts`: prefix requests optionally expose a content-free `sizeReport`; `sizesOnly` requests composition without credential preparation or refresh.
- `packages/coding-agent/src/core/extensions/types.ts`: optional `SessionStartEvent.sizesOnly` signals diagnostic startup to built-ins; `BeforeAgentStartEventResult.systemPromptParts` carries the exact parts of a replacement to the preview observer. These parts stay internal; only sizes enter the JSON report.
- `packages/coding-agent/src/core/extensions/runner.ts`: forward replacement parts to the preview observer and enumerate third-party `session_start` registrations for the network caveat.

### Why

Extension append/prepend contributions and whole-prompt replacements must be accounted for at their actual composition boundary.

### Why an extension could not handle it

Only the runner can observe each handler in order without running a separate composition.

### Expected merge conflict zones

- `packages/coding-agent/src/core/extensions/runner.ts`: `emitBeforeAgentStart` options and handler result handling.
- `packages/coding-agent/src/core/extensions/types.ts`: prefix request and option interfaces.
- `packages/coding-agent/src/core/extensions/types.ts`: `SessionStartEvent` and `BeforeAgentStartEventResult`.

## 2026-10-20 - Subagent tree cost reported through ctx.ui (senpi#2471)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionUIContext` gains optional `setSubagentCost?(costUsd: number | undefined): void`.
- `packages/coding-agent/src/core/extensions/runner.ts`: the no-op UI context implements it as a no-op.

### Why

- A session that fans out to subagents showed only its own spend in the footer, so it looked far cheaper than it was. The extension that runs the subagents (omo's task engine) knows the tree's spend; the footer needs a typed way to receive it and show it as `$0.380 (+1.270)` (oh-my-pi parity).

### Why an extension could not handle it

- The built-in footer's cost segment and the `ExtensionUIContext` contract are core; `setStatus` can only add a separate status line, not place a figure inside the cost segment.

### Expected merge conflict zones

- MEDIUM: `types.ts` `ExtensionUIContext` next to `setStatus` when upstream adds UI methods.
- LOW: `runner.ts` `noOpUIContext` member list.

## 2026-10-21 - Extensions can ask whether a person's input is queued (senpi#3863)

### What changed

- `packages/coding-agent/src/core/extensions/types.ts`: `ExtensionContext.hasQueuedPersonInput?()` and the matching optional context action; `InputOrigin` (`person | extension | engine`); `sendUserMessage` options take `inputOrigin`, where `"person"` marks an extension send as a person's input (an answered question).
- `packages/coding-agent/src/core/extensions/runner.ts`: binds `hasQueuedPersonInput` from the session's context actions (false when the host does not provide it).

### Why

The goal extension's turn-end liveness verdict releases a hold only for a person's queued input. That has to come from the session's per-entry tags, not from a count the extension keeps.

### Why an extension could not handle it

This is the extension contract itself. The queue state lives in `AgentSession`.

### Expected merge conflict zones

- `types.ts`: beside `hasPendingMessages` in `ExtensionContext` and `ExtensionContextActions`, and both `sendUserMessage` option types.
- `runner.ts`: the context-action fields and the `hasPendingMessages` binding.
