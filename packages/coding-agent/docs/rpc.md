# RPC Mode

### Recovery after shared output overflow

The unattached shared output lane is bounded to 4096 records / 64 MiB. Overflow
seals the routing handle; its retained runtime may still be open, but its lost
output cannot be replayed. Reattaching with `open_session` is refused with
`error: "session_output_overflow"`, `errorCode: "session_output_overflow"` and
`errorData: { sessionId, sessionPath, action: "unload_and_reopen" }`. Session
commands on that still-open handle return the same error code and action rather
than silently dropping their replies.

Recover using `unload_session { sessionId }`, then `open_session { sessionPath }`
to obtain a fresh handle. Unload keeps its ordinary active-work, child-task and
other-client protections: inspect a refused unload's reason/action rather than
automatically forcing it. The overflow seal and capacity limits remain in force
until the old runtime is disposed.

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@code-yeongyu/senpi` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Unattended opens and Resume

`open_session` accepts optional `"attended": false` (other supplied values are
rejected with `invalid_launch_profile`). A host handover reopen always sets it;
CLI commands reopening parked paths, including `host session state`, `read`,
and `wait`, also set it. Engine-originated wakes make zero provider calls while
held. Attaching a client does not release the hold.

Real prompt, steer, follow-up, or question input releases it. The user's message
starts one turn with the latest coalesced non-goal context before that message;
the goal revalidates and may continue afterwards.

#### resume_session

An explicit Resume (the user's Resume action) instead is:

```json
{"id":"resume","type":"resume_session","sessionId":"rpc-1"}
```

```json
{"id":"resume","type":"response","command":"resume_session","success":true}
```

It runs at most one turn per held source, sequentially through `agent_end`,
regardless of follow-up queue mode, with the current goal last. Held counts and
latest payloads survive another restart. Each wake has a persisted `session-notice`
entry (`noticeId`, `producer`, `pauseSeq`, `at`, source payload, `heldCount`,
`text`, and `action: "resume_session"`). Delivery coalesces
by source; it never drains a backlog. `session-notices-consumed` atomically records
the held-to-released transition by notice ID at final provider admission.
Repeated releases and restart replay cannot deliver an already released ID.
`session-hold` entries record hold additions and releases. Refused admission
retains notice custody; an admitted turn is never replayed, even if later aborted.
Acknowledgements list only the notice IDs present in the delivered snapshot.
Wakes arriving during unattended Resume delivery remain in custody for the next
release. Human input establishes attendance immediately, including during a
release turn; subsequent wakes keep normal attended delivery and never re-hold.
A refused released wake stays solely in notice custody, not also in the native
steering or follow-up queue.

The command response acknowledges release admission, not completion of all turns.
Observe session events for progress and `agent_idle` for settlement. Hosts advertise
`resume_session` and `attended` in `get_protocol_info.capabilities`; classic RPC
advertises `resume_session` only because it does not accept `open_session`.

After a user Stop (senpi#3811) Resume runs one turn instead: held human input first, then the held notices, then a
hidden note that the interrupted tool calls were not re-run. The response still acknowledges release admission; the
turn runs after it. Every field below is optional, so the bare form keeps working:

```json
{"type":"resume_session","expectedSeq":3,"mode":"continue","message":"Use staging","effectId":"resume-7"}
```

`expectedSeq` is the `pauseSeq` the client rendered; a different current seq answers `resumed: false, reason:
"stale"` and changes nothing. `mode: "release"` releases the Stop and an `unattended` hold without starting a turn
(the notices ride the next human message). `message` is delivered first in the resumed turn. The answer comes once the
resumed turn has started, or with `turnStarted: false` once it is clear no turn starts (for example a newer Stop landed
while the turn was admitted); held input and notices stay held until a turn that no newer Stop aborted delivers them.
A repeated `effectId` answers the recorded outcome with `replayed: true` and resumes nothing again, also after a
reopen. A session with nothing held answers
`not_paused`; a task child held only for its parent's run answers `resume_through_parent` with `parentSessionId`.

```json
{"type":"response","command":"resume_session","success":true,"data":{"resumed":true,"pauseSeq":3,"turnStarted":true,"deliveredNotices":2,"deliveredHeldInputs":1}}
```

`get_state` and `open_session.state` include:

```typescript
paused: boolean;
pausedNoticeCount: number;
holds: { kind: HoldKind; key: string; since: string; data?: unknown; sourceCounts: Record<string, number> }[];
// HoldKind = "unattended" | "session_hold" | "run_fence" | "inherited_hold" (senpi#3811)
```

`since` is an ISO timestamp. This is the shared engine hold ledger; this release
keys each record by `key` (defaulting to its kind) and preserves opaque `data`
through a restart. Persisted additions carry `key`/`data`, and release entries list `keys`. It
implements only `unattended`. Consumers must distinguish kinds rather than infer
them from the notification text. The first hold that pauses the session emits `session_paused` with `kind`,
`pauseSeq`, `at`, `noticeCount`, and `persisted`. The release that ends the pause emits
`session_resumed { cause: "input" | "resume_session", pauseSeq, at }` once; a run fence alone pauses nothing and
emits neither.
The ordinary extension UI `notify` event shows the paused count and Resume
instruction too. Attachment lifecycle extension events remain distinct from
these engine pause events: attachment never releases any ledger hold.
Notices name the held sources and are suppressed after human input releases them.
Pause and resume wire events go only to connections attached to that session.

`open_session.context.task_status`, updated through `set_session_context`, is the task owner's lifecycle label.
Handover parks with `completed`, `cancelled`, `error`, `failed`, `lost`, or
`interrupted` are removed with a stderr diagnostic instead of being reopened.
Other context keys remain opaque.

Automatic turn admission is also bounded independently of the hold. On unattended resume,
`engineTurns.maxPerResumeWindow` defaults to 8, counting engine starts in loaded
history since the last real input. A real input ends that resume window. The
normal `engineTurns.maxPerUserInput` defaults to 0 (off). Only admitted new engine
turns count, not wakes steered into running work or pending compaction; a limit emits the existing engine-paused
notice and record. Setting either cap to 0 disables that particular cap.

When the last client disconnects from a retained in-process session, extensions receive
`session_parked`; the first reattachment to that still-open session emits
`session_resumed`. File-monitor polling and prompt-cache keepalive pause between these
events. Active turns and idle eviction keep their existing behavior. These extension
hooks are not the `session_parked` wire record emitted when eviction or handoff releases
a runtime. Worker-runtime sessions currently do not dispatch the extension hooks.

The shared Unix socket host keeps its ownership state in a PER-SOCKET daemon directory, `<agentDir>/rpc-host-daemon/<sha256(canonical socket)[:16]>/` (see [Daemon state directory](#daemon-state-directory-layout-2)). Clients attach to a compatible existing host regardless of which client surface started it; only incompatible unmanaged owners are refused.

## Session lifecycle

The `session_lifecycle` capability advertises one engine-owned root-work state.
`get_state.lifecycle` returns it; `{ type: "session_lifecycle", sessionId, lifecycle }`
publishes changes on the ordered session stream. Shared hosts broadcast the event
to observers and replay only the latest lifecycle snapshot on attachment.

The shared `SessionLifecycle` type is exported by `@code-yeongyu/senpi`:

- `state`: `running`, `waiting_children`, `waiting_background`, `waiting_human`,
  `paused`, `held`, `done`, `failed`, or `cancelled`.
- `seq`, `epoch`, `epochOrigin` (`human` or `automatic`), `humanInputRevision`,
  `selfSettleEligible`, `restoring`, `persisted`, `runPaused`, and `since` (ISO time).
- `role` (`root` or `child`), `rootSessionId`, and optional `parentSessionId` and `taskId`.
- Optional `waitingOn`: `{ children, background, human, childSources?, childReports?, childReportsOmitted? }`.
  `children` and each source's `activeCount` are the authoritative counts; every named list below is
  supplemental and may be incomplete, so never derive a count from a list's length. `children` is the
  larger of the nonterminal child reports and the summed `childSources` counts.
  Background entries carry `source`, `activeCount`, optional `items`, optional `omittedItems`, and
  optional `retryAtMs`. `childSources` entries carry `source`, `activeCount`, optional `items`, and
  optional `omittedItems`. Each item is `{ id, label?, startedAt? }` (`startedAt` is ISO time), taken
  from the producer's `wake_source_state` snapshot: its `items`, or the legacy `monitors` list when
  `items` is missing or null. Terminal monitors are named by their stable `mon_` id. Each list is a
  snapshot: entries whose `id` is not a non-blank string are dropped, duplicates collapse to one entry
  per `id`, the list is sorted by `id`, and at most 32 entries are kept. `omittedItems` is the
  producer's own omitted count plus any valid items cut at 32; it is not `activeCount` minus the list
  length. Invalid detail drops only the detail, never the count.
  `childReports` lists nonterminal reports from `reportChild` as
  `{ taskId, childSessionId, runEpoch, state, label?, since? }`, excluding reports about the session
  itself, sorted by `taskId` and capped at 32; `childReportsOmitted` counts the reports cut by that cap.
  Human entries carry `kind`,
  `originSessionId`, `requestId`, `revision`, `since`, and optional child identity/label.
  Human kinds are `question`, `approval`, `goal_blocked`, `goal_paused`, `stalled`,
  and `interrupted_run`; attention remains visible even when a hold wins precedence.
- Optional `holds`: `{ kind, since }[]` from the shared hold ledger, where `kind` is
  `session_hold`, `inherited_hold`, `run_fence`, or `unattended`.
- On a sealed epoch, `completionId` is `<sessionId>:<epoch>`, the session's own id (for a root
  this equals `rootSessionId`), so a child's terminal never shares its root's id. A `done` also carries
  `completion: { kind: "goal" | "run" | "agent" | "reply", at, goalId?, runId? }`.
  A `failed` carries `failure: { reason, message?, retryAtMs?, taskId?, runEpoch? }`,
  with reason `provider_error`, `tool_error`, `task_error`, `lost`, or `interrupted`.
- A standing agent self-settle intent adds `settleDecision: { decisionId }` to the
  persisted `done` seal, independently of the completion label.
- Optional `lastStop: { cause, runId, at, epoch, deadline?, guard?, todo?, abortSource?, persisted? }`
  says why the run `runId` stopped. `cause` is `deadline`, `goal_guard`, `todo_guard`, `aborted`,
  or `no_wake`; `deadline` is `inactivity` or `max_runtime`, `guard` is the goal guard reason as
  recorded, `todo` is `cap`, and `abortSource` is `user`, `system`, or `provider`. `persisted: false`
  appears only when the deadline-stop entry could not be written and is independent of the
  snapshot's `persisted`. `lastStop` describes the last run's historical stop, so a `no_wake`
  stop remains even if a wake source later appears. It is cleared when the next run starts
  and never names a later run. A fact refresh with no bound turn end never sets `lastStop`;
  between runs, a refresh while the last end is still bound may set or update that run's stop.
  Goal guards are captured during their bound end's own processing, never inherited from
  another run. Provider errors and policy rejections carry no `lastStop`, even if a deadline fired.

Clients must not notify or settle while `restoring` is true or `persisted` is false.
Use `completionId` to deduplicate root completion/failure, not `agent_settled` or
`agent_idle`: a queued result or background source can still own unfinished work.
An ordinary reply completing is not itself a request to mark a thread Done.

#### request_self_settle

Records an agent intent for the current root epoch:

```json
{"id":"settle","type":"request_self_settle"}
```

The successful response's `data` is `{ recorded, epoch, humanInputRevision, reason? }`.
Refusal reasons are `not_eligible`, `held`, and `no_epoch`. Subsequent human input,
a hold/fence, or a failed seal invalidates the intent. Unsealed intents fail closed
on restart; sealed decisions retain their identity. Human revisions count only
the shared human-admission hook, including connections that declared
`interactive_user` in their first `set_client_info`, never automatic extension input.

`open_session.spawnedBy` is `{ parentSessionId, rootSessionId, taskId }`, with three
nonempty strings, persisted in the new session header. It identifies execution
children; `parentSession` remains fork/transcript ancestry and does not make a child.
A malformed `spawnedBy` is refused with the error `invalid_spawned_by`.

## Eval cell control

`eval_cells.list`, `eval_cells.peek`, and `eval_cells.stop` are session-scoped
control commands, not model tools. On a shared host include the same `sessionId`
routing handle used for other session commands. They use the session's current
codemode detached-cell manager, the same one used by the eval tool's
`list`/`peek`/`stop` actions. They do not execute a tool, add model context, or
append session history. Stopping a detached cell still delivers the ordinary
`senpi-codemode:notification` completion message to the agent, exactly once.

Both classic and shared hosts advertise the host capability `eval_cells` in
the `data.capabilities` array of a `get_protocol_info` response. It indicates
protocol support, not that codemode is loaded in every session. A session without
the extension returns `errorCode: "eval_cells_unavailable"`.

On shared hosts, the three named commands bypass the foreign-session-holder
guard as explicit reads/cancellation controls. They only touch this host's
manager for the routed session, never the foreign process's cells. List and
peek are observations and do not renew an otherwise idle detached session;
stop counts as activity. Cancelling an already-admitted detached cell may
persist its ordinary completion notification, like the existing abort control.

### eval_cells.list

```json
{"id":"cells","type":"eval_cells.list"}
```

```json
{"id":"cells","type":"response","command":"eval_cells.list","success":true,"data":[{"cellId":"cell_1","language":"js","state":"detached","startedAtMs":1720000000000,"summary":"Read the input files"}]}
```

The array contains live and recently settled cells, in the eval tool's existing
list order. `language` is `js`, `py`, `rb`, or `jl`; `state` is `queued`,
`running`, `detached`, `completed`, `failed`, or `cancelled`. `summary` is
optional, and a queued cell can include `queuedBehind: string[]`. A detached
queued cell has state `detached` and its predecessors in `queuedBehind`.
An empty or not-yet-started manager returns `[]`. Recent snapshots have the
manager's existing retention limits; a removed snapshot is no longer addressable.

### eval_cells.peek

```json
{"id":"tail","type":"eval_cells.peek","cellId":"cell_1","tailBytes":8192}
```

```json
{"id":"tail","type":"response","command":"eval_cells.peek","success":true,"data":{"cellId":"cell_1","language":"js","state":"detached","startedAtMs":1720000000000,"summary":"Read the input files","outputTail":"Read 12 files\n"}}
```

The text-only snapshot includes the list metadata and `outputTail`, taken from
the manager's buffered output. `tailBytes` defaults to 8192, is capped at 65536,
and must be a non-negative safe integer. Zero returns an empty tail. A partial
leading UTF-8 character is dropped, so the returned text never exceeds the byte
budget. Full result bodies, source code, and inline images are not duplicated
in this control response. Available snapshots also include `stateRetained`,
`interruptNote`, `hardLimitSeconds`, and `runBudgetSeconds` when defined.

### eval_cells.stop

```json
{"id":"stop","type":"eval_cells.stop","cellId":"cell_1"}
```

```json
{"id":"stop","type":"response","command":"eval_cells.stop","success":true,"data":{"cellId":"cell_1","language":"js","state":"cancelled","startedAtMs":1720000000000,"summary":"Read the input files","outputTail":"Read 12 files\n","stateRetained":true}}
```

The response waits for interrupt completion and confirms the terminal state,
including whether kernel state was retained. Its output tail uses the default
8192-byte budget. If the cell ended between list and stop, the response succeeds
with its existing `completed`, `failed`, or `cancelled` snapshot: no second
interrupt or completion notification is sent.

Unknown IDs, including IDs owned only by another session, fail with
`errorCode: "eval_cell_not_found"`. A malformed `cellId` or `tailBytes` fails with
`errorCode: "invalid_eval_cell_request"`. Clients must inspect the code or the
returned `state`, not match error text.

The extension handlers are also reachable through
`extension_request {name: "eval_cells.peek", data: {cellId, tailBytes?}}`
(likewise list/stop). Those aliases preserve the same eval error codes.
Use the named commands for shared-host observation/control admission:
generic `extension_request` remains conservatively session-writing.

`RpcClient` exposes `listEvalCells()`, `peekEvalCell(cellId, tailBytes?)`, and
`stopEvalCell(cellId)` with exported `RpcEvalCell` / `RpcEvalCellSnapshot` types.
Failed commands reject with `RpcCommandError.errorCode`.

### Eval liveness event

The existing `wake_source_state` snapshot already reaches RPC clients that
advertise the `extension_events` capability. Codemode publishes it on session
start and each detached-cell transition, including a zero-count snapshot on
settlement. It travels in the normal extension-event envelope, tagged with the
owning routing `sessionId` on a shared host:

```json
{"type":"extension_event","name":"wake_source_state","sessionId":"session_1","data":{"source":"senpi-codemode","activeCount":1,"items":[{"id":"cell_1","description":"Read the input files","startedAtMs":1720000000000}]}}
```

Each event is a full per-source snapshot, not a delta. Filter
`data.source === "senpi-codemode"` and replace the previous detached-cell
liveness set. `items` carry `id`, `description`, and epoch `startedAtMs`.
Use `eval_cells.list` to load initial state after attaching and peek on demand
for output; transitions need no polling. The liveness event itself adds no
model context or history.

## Account display names

`get_provider_accounts` returns secret-free descriptors containing `name`, `source`, `blocked`, `pinned`, and optional `displayName`. Render a named account as `displayName (name)`; keep using the immutable `name` for `account_pin`, `account_remove`, and comparisons. Legacy accounts omit `displayName`.

Use `/account <provider> rename <id> <display name...>` or the corresponding `/gpt-account` and `/claude-account` commands to name saved accounts; `clear-name <id>` removes only the label. `/gpt-account add` offers optional naming after login is saved, and only when Senpi generated the account ID itself; the Claude lane names accounts through its own login prompt and never asks twice. Blank input or cancellation keeps that login usable. Environment accounts cannot be renamed.

A label is stored NFC-normalized with internal whitespace collapsed, must contain at least one visible character, and may not exceed 32 terminal columns (measured in grapheme clusters, so CJK and emoji count two columns each). Uniqueness within a provider folds case, Unicode compatibility forms, invisible code points, and Cyrillic lookalikes, so two labels that render identically are refused.

## Account order

By default a provider's accounts are picked per session by rendezvous hashing, and a failed account fails over in that hash order. A user order replaces that ranking: requests try the pinned account first, then the first unblocked account in the order, then the accounts the order does not name, in hash order. On the Claude subscription lane, a session keeps the account its conversation already lives on while that account can serve, ahead of the order, so setting an order does not move running conversations.

`get_provider_accounts` lists the accounts the order names first, in that order, then the rest in stored order (the hash ranking is per session, so a listing cannot show it). It reports `ordered: true` while a stored order names at least one listed account. A pinned account serves first wherever it is listed; read its `pinned` flag. Every lane that picks an account honors the order: the generic credential pool, the Claude subscription lane and the Cursor CLI lane.

#### account_order

Set the order, or clear it with `names: null`:

```json
{"id": "o1", "type": "account_order", "provider": "openai", "names": ["work", "default"]}
```

```json
{"id": "o1", "type": "response", "command": "account_order", "success": true}
```

`names` may name a subset; accounts it leaves out come after it. The command fails without changing anything when a name is not one of the provider's accounts, appears twice, or the list is empty, and when the provider has no stored credential (the order is kept beside the pin in `auth.json`). Removing an account drops it from the order. Success emits `auth_accounts_changed`. Only account names cross RPC, never credential material.

## Starting RPC Mode

### RPC client lifecycle

`RpcClient` accepts an `onDisconnect` callback for an established socket and rejects subsequent transport operations with the typed `RpcTransportGoneError` (also detectable with `isTransportGoneError`). Callers should use the callback to begin recovery and keep the error text out of user-facing output.

Prompt acceptance can require compaction before the host emits its response. After observing
`compaction_start` for its session, `RpcClient` gives pending and subsequent prompts a bounded
45-minute-and-30-second acknowledgement budget: up to 15 minutes of remote compaction, a
30-minute maximum local-summary override, and the ordinary response allowance. A matching
`compaction_end` restores the 30-second response deadline. Each compaction operation is tracked by
its operation ID (older hosts that omit IDs remain supported), so a stale or overlapping start never
hides another operation's end, and a start whose end never arrives stops counting once it is older
than that budget. However many compactions start and end while a prompt waits, it never waits more
than 46 minutes from when it was sent. Outstanding prompts retain their originating session, so
another lease's compaction does not change their deadlines. Other commands retain their normal
deadlines, and a disconnected transport still rejects immediately. Compaction events do not
themselves acknowledge a prompt: its actual response determines success and disposition.
A timeout does not establish that the host rejected the input, so do not automatically resend it.

```bash
senpi --mode rpc [options]
```

Common options:
- `--provider <name>`: Set the LLM provider (anthropic, openai, google, etc.)
- `--model <pattern>`: Model pattern or ID (supports `provider/id` and optional `:<thinking>`)
- `--name <name>` / `-n <name>`: Set the session display name at startup
- `--no-session`: Disable session persistence
- `--session-dir <path>`: Custom session storage directory

### Client capabilities

Optional additive records are enabled through the comma-separated
`SENPI_RPC_CLIENT_CAPABILITIES` environment variable:

```bash
SENPI_RPC_CLIENT_CAPABILITIES=extension_events senpi --mode rpc
```

Rebranded distributions read the equivalent variable under their configured environment prefix
(for example `OMO_RPC_CLIENT_CAPABILITIES`). Unknown capability names are ignored. Advertising
`extension_events` opts the client into generic extension-owned event records; clients that omit it
retain the previous wire stream unchanged.

#### grant_select

Advertise `grant_select` in the connection's `set_client_info` (or the client
capabilities environment variable for classic stdio RPC) only when the client
renders `extension_ui_request` with `method:"select"` and returns the selected
option through `extension_ui_response`. The unrelated `question` capability
does not authorize these dialogs.

Project skill MCP environment decisions are select requests with
`grantSelect:true` and `timeout:120000`. Only the selected capable connection
may answer. Only **Grant and save permanently** persists the names for that
declaration; **Start without them**, cancellation, disconnect and timeout save
nothing. A client that never answers reaches the deadline and the server starts
filtered. A headless or question-only client receives no grant dialog.

Sessions retain skill-link and withheld-environment warnings. Every attached
RPC connection receives the current snapshot as warning `notify` requests on
attach and each changed generation. A late attachment receives the same
reasons; another presentation cannot consume them on its behalf. This also
applies when the shared host runs the session in a worker.

#### event_resync

A socket client may advertise `event_resync` in its connection-scoped `set_client_info`.
This opts that connection into same-connection recovery instead of an event-queue overflow
or stall disconnect. An old client that omits the capability keeps the legacy `overflow`
record and disconnect behavior. Ordinary supersession remains lossless in both modes.
A later `set_client_info` replaces the capability list: omitting `event_resync` revokes
recovery for future pressure. An already pending gap is still reported when the socket
drains; the legacy stall policy applies if it does not drain.

The host immediately sends `{"type":"rpc_ping"}`. The client answers by sending
`set_client_info` without a request id, repeating its complete capability list, and repeats
that heartbeat every 10 seconds until the socket closes. The existing connection-scoped
handler acknowledges liveness; no session command or session attachment is needed.
Each id-less heartbeat produces the id-less response
`{"type":"response","command":"set_client_info","success":true}`; clients consume it
as a heartbeat acknowledgement, not as a response to an outstanding request.
Heartbeat pulses travel in the opposite direction from event traffic, so a blocked event
reader can still prove it is alive. The host retains at most one buffered ping during a gap.
An event stall still starts at 30 seconds of host loop-served time, but it sheds the queue
rather than closing. A subsequent served budget without a heartbeat closes the peer.
The host's loop-blocked-time credit also applies to that liveness deadline.

On overflow or stall, the host drops buffered events and stops accumulating new events until
transport drain. Correlated replies that fit within the queue's byte bound are retained and
sent first; a reply that cannot fit has an unknown outcome. Every gap sends an untagged
connection-level marker, including when the connection has no attached sessions. Its
`replyLost` flag says whether a correlated reply was discarded. It then sends a snapshot for every affected
session attached to that connection:

```json
{"type":"resync_required","reason":"stall","replyLost":false}
{"type":"resync_required","reason":"stall","sessionId":"rpc-1","message":{"role":"assistant","content":[{"type":"text","text":"The complete partial reply"}]}}
```

`reason` is `stall` or `overflow`. A session's `message` is the complete current in-progress
message, or `null` when none exists. If a handle was detached during the gap, its record also
has `"closed":true`; retire that handle through the normal session-close path without closing
the socket. The affected handle set is remembered when shedding begins, so losing a close
event cannot silently leave a client attached to a nonexistent handle.
Only the handle set is frozen at shed start. Message snapshots are read at drain time,
in the same synchronous step that reopens admission, and delivered before subsequent
deltas. They replace the client's partial-message
baseline; they are not text to append a second time. Media placeholders still apply.

Every untagged marker requires connection-wide reconciliation: unsubscribe the previous
`subscribe_sessions` subscription and subscribe again, replacing the status snapshot and
restarting its sequence at zero; re-read `list_sessions` and lifecycle state; and re-read
each live session's `get_state.pendingDialogs` to restore pending select, confirm, input
and editor requests. These dialogs are distinct from `pendingQuestions`. Discard obsolete
status sequence expectations and dialogs absent from the authoritative state.

If `replyLost` is true (or absent on an earlier host), outstanding requests may have lost
their answers: settle them as **outcome unknown**, not success, and never automatically
replay a mutation. When it is false, keep outstanding requests intact. Keep the socket,
its epoch and its session handles. For each tagged marker, refresh that session with
`get_state` and the existing paginated `get_entries` path, reconcile pending questions and
run state, and replace its streaming preview from `message`. A read-only request may be
retried. A closed-handle snapshot retires that session, not the connection.
Another overflow during recovery produces another gap and a newer snapshot.

#### interactive_user

A client that advertises `interactive_user` in `set_client_info` declares that the connection belongs to a person's
client. The role is the connection's authority over pausing: only such a connection may Stop a session (`intent:
"stop"`) or release a Stop with its input (senpi#3811). It does not change an input's origin: every `prompt`, `steer`
and `follow_up` is a person's input by its entry point, whatever the role. The role belongs to the connection, not to a session:
on a shared host every connection attached to a session keeps its own role, and a stdio host's one client is a
single connection. Only the client's own `set_client_info`
declares it (at connection level or for a session); the host's launch capabilities and
`SENPI_RPC_CLIENT_CAPABILITIES` never do. It is bound at the connection's first declaration; a later `set_client_info`
that adds or drops it is refused with `connection_role_fixed`, so the heartbeat must repeat the same list. A client that dispatches input on its own (for example a queued follow-up it sends later)
should use a second connection without the role.

#### media_placeholders

A client that advertises `media_placeholders` in `set_client_info` tells the host it does not want
inline media bytes on the wire. For that connection the host replaces every image block inside a
tool result (`ToolResultMessage.content` and `tool_execution_end.result.content`, including the
entries carried by `get_entries`, `get_messages`, `get_tree`, `open_session` state and attach-time
snapshot replay) with an `image_ref` placeholder:

```json
{
  "type": "image_ref",
  "mimeType": "image/png",
  "byteLength": 553000,
  "ref": {"toolCallId": "call_abc123", "contentIndex": 1}
}
```

`byteLength` is the decoded size of the omitted payload. The original block is fetched on demand with
[`get_media`](#get_media) using the `ref`. User-authored images (`prompt`/`steer`/`follow_up`
`images`) are never replaced.

A multi-session host also keeps each tool-result image on disk, so a client can render it from a
path without a round trip. The bytes are written atomically BEFORE the placeholder is emitted, and the
placeholder gains one of two fields:

```json
{"type": "image_ref", "mimeType": "image/png", "byteLength": 553000,
 "ref": {"toolCallId": "call_abc123", "contentIndex": 1},
 "path": "/home/me/.senpi/agent/sessions/--proj--/media/<durableSessionId>/<sha256(toolCallId)>/1-<sha256(bytes)>.png"}
```

`unavailableReason` replaces `path` when the image was not kept: `image_too_large` (over 20 MiB),
`session_limit` (the durable session already holds 256 MiB of images; new images are refused and
stored ones are never evicted) or `storage_error` (the write failed, the format is not PNG, JPEG,
GIF or WebP, or the bytes are not the format the tool claimed). A session with no session file has neither field. Files are immutable and private, live next to the session files and never under the
project, outlive disconnects, idle shutdown and generation handover, and are deleted with the session
(from the interactive session selector). `get_media` keeps working for every placeholder.

A connection that does not advertise the capability receives byte-identical output to before. The
capability is advertised by the host in `get_protocol_info.capabilities` in both classic and
multi-session mode, but the transform itself is applied only by the multi-session host: classic
single-connection stdio mode never rewrites its output, so a stdio client always receives inline
media even if it names the capability. `get_media` is answered in both modes.

## Multi-session mode (D1 wire protocol)

Multi-session mode lets one `senpi --mode rpc` process serve several independent conversations concurrently over the same stdio JSONL stream. Classic single-session mode is unchanged except for two additive behaviors: `get_protocol_info` is answered, and a resolved `extension_ui_response` is acknowledged under its frame `id` (see [Extension UI Responses](#extension-ui-responses-stdin)).

### Starting multi-session mode

```bash
# Shared JSONL over stdio (legacy multi-session host)
senpi --mode rpc --multi-session [options]

# One multi-session host over a local socket; each accepted connection has its own JSONL feed
senpi --mode rpc --listen unix:///tmp/senpi-rpc.sock [options]
senpi --mode rpc --listen /tmp/senpi-rpc.sock [options]
```

`--listen unix://` selects the default per-agent socket path. Unix abstract socket names may be supplied as
`unix://@name` where supported by the host platform. Socket mode accepts concurrent connections while retaining one
process-global session registry.

### Authentication

Public POSIX endpoints advertise `socket_auth` and prove possession of a fresh per-launch key.
This applies to ensured hosts, direct supervisors, and bare `--listen` hosts. Windows pipes keep
their existing raw `.secret` handshake. Terminal control sockets and tool-child channels are unchanged.

The host publishes `<agentDir>/rpc/keys/<launch_id>` before answering any connection. The agent
directory and `rpc` must be user-owned, non-symlink directories without group/other write
permission (0755 is supported). Only `rpc/keys` must be 0700. Before publication, the host
tightens an existing user-owned, non-symlink `rpc/keys` directory to 0700; clients refuse
unsafe modes rather than changing them.
The record is exclusively created with `O_NOFOLLOW`, fsynced, and checked to be a user-owned
regular file with mode 0600. Publication failure closes the endpoint with `key_publication_failed`.
A group- or other-writable agent directory or `rpc` (for example one created under umask 002) is such a
failure: the host exits, and its message names the directory and the fix, `chmod go-w <dir>`.
Each launch generates a new UUID and a new 32-byte key in memory. Hosts delete only their own
record; `senpi host gc` also collects records whose process is dead or whose PID has been reused.

The JSON record is
`{version:1, launch_id, key, pid, process_start, endpoint, created_at}`:
`key` is 64 lowercase hexadecimal characters, `process_start` is the process start identity
or `null`, and `created_at` is an ISO-8601 UTC timestamp. Never copy the record into logs.

The client's key root defaults to its own agent directory. `SENPI_RPC_KEY_ROOT`,
`senpi host ... --rpc-key-root <dir>`, and the `keyRoot` option on `RpcClient` and socket probes
select the host's credential directory without changing the client's models, settings, skills,
MCP environment, or other profile data. For example, a client using profile B can authenticate
to an endpoint launched by profile A by selecting A as its key root while keeping B active.

The exchange uses strict LF-delimited JSON:

1. Preserve the caller's own first `get_protocol_info` frame, including `observe` and
   `origin_host_instance`, and add top-level `auth: {client_nonce}`. A caller starting with
   another command first sends an observing protocol probe. Both nonces are 32 fresh random
   bytes encoded as 64 lowercase hex characters.
2. The normal response's **`data.auth`** contains `{launch_id, server_nonce, server_proof}`.
   Read and validate the named record, including `version === 1`, matching `launch_id`,
   a 32-byte key, directory ownership/modes, and an `O_NOFOLLOW` file open.
3. Verify the server proof, then send `{id, type:"authenticate", client_proof}`. Wait for
   its successful correlated response before sending any other command. Proofs are lowercase
   hex HMAC-SHA256 digests, compared as 32 raw bytes in constant time:

   ```js
   import { createHmac, timingSafeEqual } from "node:crypto";

   const key = Buffer.from(record.key, "hex");
   const serverProof = createHmac("sha256", key)
     .update(["senpi-rpc-server", launchId, clientNonce, serverNonce].join("\n"), "utf8")
     .digest();
   // Validate that the received proof is exactly 64 lowercase hex characters first.
   if (!timingSafeEqual(serverProof, Buffer.from(receivedServerProof, "hex")))
     throw new Error("host_identity_unproven");
   const clientProof = createHmac("sha256", key)
     .update(["senpi-rpc-client", launchId, serverNonce, clientNonce].join("\n"), "utf8")
     .digest("hex");
   ```

For third-party scripts, the shipped client implements the record checks and complete exchange:

```js
import { RpcClient } from "@code-yeongyu/senpi";

const client = new RpcClient({ socketPath: endpoint, keyRoot: hostAgentDirectory });
await client.start();
try {
  console.log(await client.listSessions());
} finally {
  await client.stop();
}
```

The raw key never crosses the socket. A wrong server proof closes the client with
`host_identity_unproven`; an unsafe record closes it with `unsafe_key_record`. Neither falls
back. A host's `auth_failed` triggers one fresh connection and credential lookup, not an
unauthenticated retry.

This release serves clients that never prove the key, with one stderr deprecation line per
connection and no limit beyond the normal JSONL ones, whatever the first frame (a long prompt or
an image included) and whether or not the client first received a challenge it could not answer.
A challenge in flight is not cut short: its `authenticate` may arrive after 2 seconds.
`SENPI_RPC_REQUIRE_TOKEN=1` enforces now: the first frame must be a `get_protocol_info` carrying
`auth.client_nonce`, and any other first frame, a keyless `get_protocol_info` included, receives
`auth_required`; a wrong proof receives `auth_failed`; either way the connection closes before any
later frame executes. Under enforcement, pre-authentication input is limited to 8 KiB and 2 seconds.

The host never drops an unauthenticated connection silently. Each drop writes one stderr line,
`senpi rpc host: dropped an unauthenticated connection on <endpoint>: <reason>`, where the reason
is `auth_required`, `auth_failed`, `pre-auth budget exceeded`, `pre-auth deadline`,
`first frame over the line limit` or `key publication failed`. The line carries no frame
content, nonce or key material.

A host is supervised only when it holds the internal key its supervisor hands it on stdin; the
supervisor-watch environment (`SENPI_RPC_HOST_WATCH_*` and its companions) never switches public
authentication off, and a host removes those variables once read, so nothing it starts
inherits them.
Clients accept pre-change hosts whose protocol answer has no `data.auth`. A missing record
is the one grace exception: the client logs the key-root remedy and continues without sending
`authenticate`; an enforcing host then refuses subsequent commands. Enforcement defaults and
refusal of legacy hosts are separate follow-ups.

Keep endpoints under the protected agent directory for the sandbox boundary. Choosing a `/tmp`
path or Linux abstract name permits a process that can later bind that name to pose as a legacy
host during the compatibility period. Challenge-response still prevents disclosure of the key
to a listener that cannot prove it.

### Session runtime (`--session-runtime in-process|worker`)

`--session-runtime` selects where a multi-session host runs its sessions:

- `in-process` - every session runs IN the host process, sharing its event loop. No worker isolate is allocated and
  no session cap applies (capacity is memory, never a refusal). This is the DEFAULT for a `--listen` socket host,
  i.e. for the multi-session host clients attach to.
- `worker` - every session owns a worker isolate, bounded by the worker capacity below. This is the DEFAULT for a
  stdio host (`--multi-session` without `--listen`, and `--listen stdio://`) and for embedders, and stays available
  for socket hosts that pass the flag explicitly.

An explicit flag wins over both defaults; any other value is a startup error. The flag changes only WHERE sessions
run - the wire protocol, attachment semantics and lifecycle windows are identical on both runtimes. An in-process
session is not isolated from the host: a session that blocks the event loop blocks every other session, and there is
no per-session opening deadline like the worker runtime's 30-second budget.

What an in-process session costs is memory and host accounting, never an admission decision - but that cost is
linear, not flat. Measured on one socket host with the default builtins: about **one OS thread, two file descriptors
and 5-8 MB of RSS per open session**, with no plateau. At 1,000 concurrent sessions on one host the process went
from 20 to 1,023 threads, 14 to 2,014 descriptors and 151 MB to 4.7 GB resident, with zero errors and no refusal.
The thread is not the session runtime - the in-process runtime allocates none - it is the `config-reload` builtin,
which lazily spawns one filesystem-watch Worker per session
([senpi#1794](https://github.com/code-yeongyu/senpi/issues/1794)); the same driver with that builtin disabled
measured 0 additional threads per session. Size a daemon from those numbers: it never refuses an `open_session` for
occupancy, so the ceiling is the machine's memory and its per-process thread and descriptor limits, not a session
count the host enforces.

### Tool runtime (`--tool-runtime in-process|child`)

`--tool-runtime` selects where a session's heavy tool work runs. `SENPI_TOOL_RUNTIME` is the fallback when the flag is
absent, and `in-process` is the default. Any other value, from either source, is a startup error.

- `in-process` - every tool runs on the host's own event loop, as it always has.
- `child` - each session gets its own tool child (senpi#3566): a separate process the engine starts by re-entering
  itself, on the first tool call routed to it, never earlier. No command the child runs starts before the host has
  recorded the launch. Today only an extension tool with `placement: "child"` and a `childModule` (`{ path, export }`,
  a file inside that extension's directory) runs there; every other tool still runs on the host.

The child's state is visible two ways:

- a `session_tool_child` record `{ state: "spawned" | "exited" | "respawned", generation, pid }` on the session's
  stream whenever it changes (a dead child is started again, as a new `generation`, by the next job routed to it);
- `tool_child: { state: "none" | "live" | "exited", generation?, pid? }` on every `list_sessions` row (`none` under
  `in-process`, and for sessions on the worker runtime).

A multi-session host and a single-session `--mode rpc` process each advertise their choice as one
`tool_runtime:in-process` or `tool_runtime:child` entry in `get_protocol_info.capabilities`. Under `child` they also
advertise one `placement:<name>` entry for each part of the tool child that has landed (`placement:launch-barrier`:
every command a child-run tool starts passes the execution barrier; `placement:job-policy`: per-kind deadlines,
liveness and the cancel ladder; `placement:hostcall`: a child-run tool body reaches the session over the reverse
bridge - `tool`, `completion`, `reserved`, `list_tools`, `authorize` and drain-before-release `lock_file`/`unlock_file`,
with large arguments and replies carried by acknowledged references). Both runtimes also advertise `offload_api`: an extension's
`ctx.offload` / `pi.registerChildModule` are available, running on the tool child under `child`
(`placement:offload`) and in the host process under `in-process`. A job worker cannot start worker threads of its
own (`tool_child_nested_worker_refused`), so no launch escapes the barrier that way.

### Host identity (`get_protocol_info`)

Supervised socket hosts additionally report `lifecycle: "ready" | "stopping"`.
The supervisor closes admission synchronously when shutdown or a drain begins,
including owner-expiry shutdown. It keeps answering protocol probes while waiting
for its child to exit, even if the child no longer responds. `senpi host status`
and `status --all` expose the same `lifecycle` field (`null` for an older or
unreachable host). Session counts during stopping are unobserved and represented
by the existing empty listing, not a claim that the child has already exited.

A ready probe does not reserve an open: a later `open_session` can fail with
`errorCode: "host_stopping"` and `errorData.instanceId`, including on a connection
that previously read ready. An open still pending when stopping begins receives
the same refusal rather than a late successful attachment. Existing admitted
sessions may finish a drain.

`ensureHost()` never adopts a stopping generation. Under the endpoint lock it
waits for that registered supervisor and its child to exit, without signalling
them, within the existing stop budget. `stoppingTimeoutMs` may shorten that wait;
expiry or an unprovable generation returns `HostEnsureRefusedError` with reason
`host_stopping`. A fresh ensure then performs ordinary discovery/startup.
`senpi host session open` retries a typed stopping refusal with its original
launch specification and a shared stop deadline. Socket-only `RpcClient` reports
the typed error to its caller; it cannot launch a successor without launch options.

Every `get_protocol_info` answer - classic and multi-session alike - carries the identity of the host that
answered it, so a client sharing one machine-wide host can tell hosts, builds and launches apart without
parsing a version string:

```json
{
  "protocolVersion": 1,
  "serverVersion": "2026.9.17",
  "capabilities": ["multi_session", "..."],
  "mode": "multi",
  "instanceId": "b46e6734-881f-493a-9bf5-705f9e15327a",
  "generation": 0,
  "engineVersion": "2026.9.17+1789656604.7b59713",
  "engineOrdinal": [2026, 9, 17, 0, 1789656604],
  "launch_profile": {
    "profile_id": "ca7a4943…",
    "core": { "extensions": [], "multi_session": true, "session_runtime": "in-process" }
  },
  "agentDir": "/home/me/.senpi/agent"
}
```

- `instanceId` - UUID minted when the host process booted. It is the only reliable "is this still the same
  host?" signal: it changes whenever the process does, including after a replacement.
- `generation` - which generation of its daemon directory this host is, handed to it at spawn time
  (`SENPI_RPC_HOST_GENERATION`). A host nobody ensured reports `0`.
- `engineVersion` - the build string: the CalVer package version plus `+<buildEpoch>.<sha7>` when the binary
  was compiled with build metadata. Informational, like `serverVersion`.
- `engineOrdinal` - `[year, month, day, postRelease, buildEpoch]`, the ONLY ordering a client may use.
  `[y, m, d, n]` compares lexicographically, where `n` is the CalVer post-release increment (`2026.9.16-3`
  ships AFTER `2026.9.16`, the opposite of the semver reading of those strings). The build epoch breaks a tie
  only when BOTH sides carry one; otherwise the two builds are EQUAL, so a build whose age cannot be established
  never outranks one that can. Binaries built without git metadata report an epoch of `0`, which is exactly how a
  client reads "this build has no age": a non-zero epoch is comparable, `0` is not.
- `launch_profile` - what the host was launched with: `core.session_runtime`, `core.multi_session` and
  `core.extensions` (absolute roots, deduplicated and sorted). `profile_id` is the sha256 of the canonical JSON
  of `core` with its keys in that sorted order (`extensions`, `multi_session`, `session_runtime`), so any client
  can recompute it and compare two hosts without comparing paths.
- `agentDir` - the absolute agent directory the host reads and writes. A generation handoff is refused
  `foreign_agent_dir` when it differs from the caller's own agent dir (see "Generation handoff"). Hosts
  released before the field omit it.
- `memory_pressure` - multi-session hosts only: `true` while this host's memory sampler reads its memory footprint
  above `SENPI_RPC_HOST_RSS_WARN_MB`, else `false`. Not identity and never an admission signal; `senpi host status`
  reports it per endpoint. Classic hosts and hosts released before the field omit it.

Compatibility is decided from `protocolVersion` + `capabilities`, and "is my build newer?" from `engineOrdinal`.
A `serverVersion` string comparison is never a compatibility test: two hosts with different version strings can
speak the same protocol, and a host whose ordinal is uncomparable is attached to, never replaced.

### Caller-owned hosts (`ensureHost`)

`ensureHost({ socket, agentDir, owner: "caller" })` opts an endpoint into the lifetime of
the process making that call. The public `EnsureHostOptions` export carries this option.
Omit `owner` for machine-wide hosts and desktop thread hosts; their existing idle policy
is unchanged. An owner that is alive also leaves the normal idle policy unchanged.

Fresh launches inherit a separate lifetime pipe on POSIX and Windows. The caller retains
its write end without keeping its own event loop alive; supervisor EOF proves owner death,
including SIGKILL and PID reuse. Releasing `EnsuredHost.release()` releases only the attach
hold, not ownership. The supervisor waits for two seconds of continuous quiescence after
confirmed death: no attached or unclassified public peers, no active runs, and a healthy
activity observer. Classification follows the normal idle policy: observe-only reads
(`senpi host status`, including repeated polls) and `warm` never reset the grace.
Attached-peer activity, run start, and observer loss reset it even between ticks.
A peer with no complete first request is unclassified and blocks exit, just as it does
under the normal idle policy. If it disconnects before classification, its unknown
admission breaks continuous quiescence and resets owner grace on disconnect; it is
not treated as a proven observing read or an attached client. This deferred reset
lets dropped connects restart the grace without letting status connections restart it.
After death is observed, the
existing one-second maximum lifecycle tick adds at most two ticks to window accounting,
then normal child shutdown applies (five-second graceful
stop before the existing escalation policy). A stalled child retains that policy's longer
bounded wait. No peer is drained and no active turn is interrupted by owner death.

Reusing a running supervisor cannot inherit another fd. A generation successor launched
by a process other than the owner also cannot inherit the owner's fd. These paths, and
launches where opening the inherited pipe fails, compare the recorded PID and OS process
start identity through the existing process reader (`ps lstart` on POSIX, CIM creation
FILETIME on Windows). Both capture and probe pin `TZ=UTC` and `LC_ALL=C`; POSIX identities
carry an explicit UTC suffix. Parsed milliseconds are compared with the existing process-start
tolerance, never by raw timestamp spelling. Pipe-less probes back off from one second to a
five-second maximum interval, with a one-second query budget. This adds at most that polling
interval before owner death can be observed; failed or unreadable observations never authorize shutdown.
Windows handoff remains unsupported, as before. A successor launched by the owner inherits
a fresh pipe. Ownership survives handoff independently of the attach hold.

Pipe-binding equality uses the exact parsed start instant; the liveness tolerance cannot
merge two different process incarnations into one pipe owner.

Each new generation records `owner.json` as `{ owner: { pid, startTime } }`, or
`{ owner: null }` when unowned. Unowned generations open no owner filesystem watcher.
A failed or exhausted watcher degrades to record polling without aborting startup; polling
also discovers a first owner claimed on a previously unowned generation.
An ensure may update only this ownership record under the
endpoint lock while holding an attachment. The same owner can ensure again; a new caller
may replace only a confirmed-dead owner (or claim an unowned host). A different live or
unknown owner is refused. An old host without an ownership record refuses an ownership
claim rather than pretending it can honor one. The record is removed with the generation,
before the registration pointer. Other daemon files retain their existing writer rules.

### Attach, start or refuse (`decideHostAction`)

A client that finds a host on the shared socket decides what to do with it through one exported function,
`decideHostAction(client, host, policy)`, so every client surface answers the question the same way. `host` is
the `get_protocol_info` answer (or `undefined` when nothing answered), and `policy` is `"never"` (attach only),
`"fallback"` (prefer no host over a mismatched one) or `"upgrade"` (a generation handoff is allowed). The result
is `{ action, reason, upgradeable, warning? }`.

A host is COMPATIBLE when it answers `protocolVersion: 1` and advertises every required capability -
`multi_session`, `extension_events`, `session_context`, `session_kind`. That is the whole test; the version
string takes no part in it.

| Situation | Action | Reason |
| --- | --- | --- |
| nothing answered on the socket | `start` | `no_host`, or `restart_own_host` when the pidfile is this process's |
| the host answers another protocol version | `refuse` | `protocol` |
| a required capability is missing | `refuse` (`fallback` under policy `fallback`) | `capability` |
| policy `fallback` and the host runs a different engine build | `fallback` | `engine_mismatch` |
| compatible, on win32 | `reuse`, `upgradeable: false` | `win32_attach_only` |
| compatible, host does not advertise `generation_handoff` | `reuse`, `upgradeable: false` | `handoff_unsupported` |
| compatible, policy `upgrade`, this build's ordinal is STRICTLY greater and its extensions cover the host's | `handoff` | `newer_engine` (`profile` when both are the same release and only the extensions grew) |
| compatible, anything else | `reuse` | `compatible` |

A `reuse` can carry a warning the caller should surface: `profile_narrower_attached` (this client would have
upgraded, but its extension set does NOT cover what the running host loaded, so upgrading would drop those
extensions) or `profile_mismatch_attached` (the launch profiles differ, or one of them is unknown - a client
without a launch spec can prove nothing about extensions and therefore never initiates a handoff).

Four invariants govern every client of a multi-session host, and every client is expected to keep all four. The first two
are what this decision encodes; the other two are what a client must not undo elsewhere:

- **I1 - never terminate, signal or replace a host this process did not start.** A missing capability or a
  foreign protocol version ends in `refuse`, never in a second host bound over an endpoint somebody else owns.
  `ensureHost` records a `writer: { pid, startTime }` stamp in its pidfile and stops the host it names only when
  that stamp is this process (the start time is what keeps a recycled pid from inheriting the right). A pidfile
  written by anyone else fails the ensure with `HostEnsureRefusedError { reason: "foreign_writer" }` and the host
  keeps running. That refusal is about signalling, so it holds only while something still accepts connections at
  the public path: a registration that names a live process whose entry is GONE (it was replaced by another socket
  and the replacement later exited) or whose entry nobody listens behind (a dead listener left it, a successor's
  rename never landed) describes a generation nobody can reach, and binding a fresh generation to the free path
  touches nothing of it. The ensure then starts one beside it, numbered after the stranded generation, which
  keeps its registration until it exits; refusing there locked every client out until that process happened to
  end (#1936). A named pipe has no entry to lose, so win32 keeps refusing.
  Neither replacement happens to a generation that is alive but stalled: when its own
  `generations/<instanceId>/host-stalled.json` records a loop stall younger than `SENPI_RPC_STALL_REFUSAL_MS`
  (default 120000), or its `host-alive.json` heartbeat stopped more than the loop-lag error threshold ago yet inside
  that window, while its process is alive, the ensure fails with `HostEnsureRefusedError { reason: "host_stalled" }`
  and sends no signal, starts no generation beside it and leaves its registration untouched - a stalled host is still
  serving its sessions.
  When no registration names the endpoint at all, yet something still accepts connections at the public path and did
  not answer `get_protocol_info`, the ensure fails with `HostEnsureRefusedError { reason: "endpoint_occupied" }` (exit 3)
  and leaves that process and its entry alone: a start there could only lose the bind and exit without a reason. An
  entry nobody listens behind is still free and is replaced by the start.
- **I2 - compatibility is protocol version + capabilities, never semver equality.** An ordinal that cannot be
  compared (a build without git metadata, a host that reports none) is EQUAL, and since a handoff requires
  STRICTLY greater, such a pair attaches instead of upgrading.
- **I3 - only the generation that owns the daemon state writes it; every other client reads.** A running host's
  pidfile, settings, reservations and socket belong to that generation. A client that cannot use what it finds
  fails CLOSED - it reports the refusal, or starts its own private host on its own endpoint - and never edits
  another generation's state files, unlinks its socket, or removes its pidfile to "clean up". A handoff is the one
  exception and it still writes only its OWN generation directory before repointing the pointer (see
  [Daemon state directory](#daemon-state-directory-layout-2)); the drained predecessor keeps its registration until
  it exits, because it is still serving. The one sanctioned cross-writer is the STOP INTENT: a process about to
  signal a generation (an ensure, `host stop`, a handoff abandoning its successor, the generation's own supervisor)
  first writes `generations/<instanceId>/stop-intent.json` `{ sender, targetPid, reason, signal, at }` into THAT
  generation's directory, because the target cannot know who is about to stop it; nothing ever reads or removes
  another generation's intent, and a drain writes none. The DRAIN REQUEST is the second sanctioned cross-writer:
  `host stop --drain` writes `generations/<instanceId>/drain-request.json` into the generation it asks (see
  [Asking a named generation to drain](#asking-a-named-generation-to-drain)). Caller-lifetime registration is the
  other explicit cross-writer: only `owner.json`, under the endpoint lock and attach hold described above.
- **I4 - machine-driven work is invisible by default.** A session opened with `kind: "worker"` is omitted from
  `list_sessions` unless the caller passes `include_workers: true`, its `context` is published on that listing only,
  and its `session_closed`/`session_parked` records reach only the connections attached to it. A client that never
  asked for worker sessions sees a daemon serving hundreds of them exactly as it saw an empty one, so a task runner
  fanning out children cannot flood a desktop's session list.

### Generation handoff (`handoffHost`, `probeHost`, `stopHost`)

An engine upgrade must not end the work the running daemon is doing: one machine-wide host holds every
client's sessions. A GENERATION HANDOFF replaces the process while its sessions keep running.

1. The successor is spawned with `--socket <public> --bind <public>.next-<generation>` and binds the BIND
   path. It never binds the live public path, and the bind path is refused before the bind when it would
   exceed the platform's 103-byte socket-path limit.
2. Once its host answers, the successor renames its own entry over the public path - but only while that
   path still refers to the exact socket the handoff was decided against (`--replace <dev>:<ino>`). A path
   taken over by anything else aborts the handoff: nothing is renamed, nothing is unlinked, and the
   running host keeps serving.
3. `handoffHost` then registers the successor (its own `generations/<instanceId>/host.pid`, the pointer
   moved onto it, and `settings.json { socket, generation }`) and sends
   the predecessor SIGUSR1 = DRAIN: stop accepting, announce `host_superseded` to every connection,
   park attached and unattached sessions as their turns and requests settle, then exit independently of
   connection occupancy. Clients see `session_closed { reason: "handoff_parked", sessionPath }` before
   their connection closes and reopen with `open_session { sessionPath }` on the successor. Losing
   ownership of the public socket triggers the same sequence even if SIGUSR1 never arrives.

Three guards decide whether a handoff is attempted at all, and all of them fail closed:

- The running host must advertise `generation_handoff`. SIGUSR1 TERMINATES a process that installed no
  handler for it, so a host from before the drain existed is never signalled - `handoffHost` answers
  `{ action: "refuse", reason: "handoff_unsupported" }` and `decideHostAction` reports `upgradeable: false`.
- The registration must prove which process serves the socket (pid + start time, and the record's `socket`
  must be this endpoint) before that process is signalled. Without such a registration a handoff never
  signals a stranger (I1): it refuses while that host holds a session, and replaces an idle one without
  a signal unless a flat pre-layout-2 record proves it (see "Daemon state directory (layout 2)").
- The running host must belong to the caller's agent dir. A client reads registrations under its OWN agent
  dir, so pointed at another agent dir's socket it would see no record there and read a live, registered host
  as an unregistered idle one. `handoffHost` therefore compares the host's advertised `agentDir` with its own
  (both canonicalized through `realpath`) and refuses `{ action: "refuse", reason: "foreign_agent_dir",
  upgradeable: false }` when they differ; `detail` names both directories. A host from before the field is placed
  by the layout: when the socket is `<dir>/rpc/rpc.sock` and a layout-2 registration under `<dir>` proves a live
  owner, the host belongs to `<dir>`. With neither, the handoff proceeds as before. Nothing is signalled.
- Transition window: a host from before the `agentDir` field, serving a socket that is not another agent
  dir's default `<dir>/rpc/rpc.sock` (or whose layout-2 record there proves no live owner), cannot be
  placed and stays replaceable through the idle path above. Every host built with the field avoids it.

On win32 a named pipe cannot be renamed: `handoffHost` refuses with `upgrade_unsupported` and
`decideHostAction` never yields `handoff` there. Upgrades apply after `stopHost({ drain: true })` - which
reaches a win32 generation through its drain request, not a signal - or an idle exit.

`ensureHost` performs a handoff only when asked: `upgrade: "if-engine-differs"` (default `"never"`) makes it
run `decideHostAction` under policy `upgrade` with the launch profile its own `hostArgs` describe. A refused
handoff ATTACHES to the running host - an upgrade that cannot happen never becomes a stop.

`ensureHost` also takes `hostArgs` (CLI arguments forwarded through the supervisor to the host process) and
`env` (a `null` value removes an inherited variable) as public options.

A generation also drains WITHOUT being asked. The SIGUSR1 above can fail to arrive - an owner whose
registration cannot be proven is never signalled, a client that binds its own entry over the public path
sends nothing at all, and a wedged process can miss the signal it was sent - and the superseded generation
then holds its retained sessions and their path claims for as long as it lives, while no client can reach it
by path. So every generation checks, once a second, whether the public path still holds the entry it bound;
the moment it does not, it applies the same drain to itself: park each retained session with no attachment,
release its claims, and exit when it holds no attached session. Nothing else changes - a session mid-turn
still finishes, and a client still attached is still served.

That check separates a name that was TAKEN OVER from a name that is GONE, because the evidence differs in
strength. A different entry at the path proves supersession on sight and drains immediately. An absent entry
proves only that nobody is serving the name, so it has to be seen on several consecutive checks before it
counts, and a check that cannot answer resets the count rather than adding to it. Either way the outcome is
the same drain: an unlinked socket name can never accept a connection again, so the generation behind it is
unreachable no matter why the name went away.

An endpoint with no file identity - a win32 named pipe has no inode to compare - is checked on two POSITIVE
observations instead: the daemon pointer names another instance, and the public endpoint answers
`get_protocol_info` (an `observe` read, which never counts as activity) as that same instance. They must agree
on three consecutive checks; a missing pointer, an unanswered probe, an answer as this generation or as a third
instance each reset the count. Such an endpoint is never judged absent, and nothing is removed or reclaimed on
any observation: a confirmed loss only starts the same drain.

#### Asking a named generation to drain

`stopHost({ socket, agentDir, drain: true, instanceId?, waitMs? })` (CLI: `host stop --drain [--instance <id>]
[--wait-ms <n>]`) asks ONE generation to drain: the one the pointer names, or the one `instanceId` names - how a
client reaches a superseded generation that still holds its sessions' path claims. The target must be proven
first, exactly as for any signal: its `generations/<instanceId>/host.pid` names a live process by pid and start
time, about this endpoint; an unproven or unknown generation is refused `unknown_owner` and sent nothing.

The request needs no signal and is the same on every platform:

1. A supervisor reads drain requests once it is serving and says so in `generations/<instanceId>/drain-watch.json`
   `{ pid, at }`. The asker uses the request only when that marker names the very pid it just proved.
2. The asker writes `generations/<instanceId>/drain-request.json` `{ sender, reason, at, nonce }` by rename.
3. The supervisor polls that file once a second; each new `nonce` is one drain request. It runs the drain
   described under [Generation handoff](#generation-handoff-handoffhost-probehost-stophost): stop admitting, park each session as it
   settles, release its claims, exit once nothing is attached. It relays the drain to its host child through
   `generations/<instanceId>/host-drain-request.json`, which the child polls (on POSIX SIGUSR1 still follows as
   an immediate wake).

A generation without the marker - one from before the request existed - is drained by SIGUSR1 as before, and only
on POSIX, when the endpoint advertises `generation_handoff` AND answers as the named instance; otherwise the
answer is `drain_unsupported`. The answer is `{ action: "drained", pid, instanceId }`; with `waitMs` it also
carries `exited`, `true` once the generation's process is gone (or its pid names another process) within the
bound, `false` otherwise - an identity that cannot be read is not an exit. A client that did not wait learns the
same from `host status --json`: the drained generation leaves `generations` when it exits.

`stopHost({ socket, agentDir, drain?, force? })` ends a generation: `drain: true` is always permitted (it
ends no work, it only stops the host from taking new work), while a hard stop requires a host that reports
no open sessions, or `force: true`. A hard stop also drops that generation's registration (the pointer and
its `generations/<instanceId>/` directory); a draining host keeps its registration until it exits, because
it is still serving. `probeHost({ socket })` returns the running host's `get_protocol_info`
answer, or `undefined` when nothing is serving the endpoint.

A host that reports memory pressure (`SENPI_RPC_HOST_RSS_WARN_MB`, 4096 by default) while holding NO session
logs one line naming its RSS, and drains when it is also superseded: memory a daemon cannot attribute to a
session is memory nothing will return, and a generation nobody can reach is pure cost.

#### Runtime identity and the conditional idle handover

A version string cannot say which runtime a host loaded: a development checkout and a packaged install can
share one version, and a reinstall replaces a bundle at the same path. Every host therefore reports
`runtimeBuildId: "sha256:<64 hex>"` in `get_protocol_info`, computed ONCE at startup from the runtime it is
about to serve with: the runtime flavour (`compiled`, `packaged`, `dev`), platform and architecture, the engine
build text, the digests of the runtime files (`dist/bundle`, `dist`, `src`, or the compiled executable) sorted
by their relative path, one digest per launch-profile extension, and the profile's `multi_session` and
`session_runtime`. Absolute paths never enter it, so one build installed in two places has one id; dot-entries,
nested `node_modules`, `.d.ts`/`.map` files and the build/snapshot manifests are left out. A bundle replaced
after the host started leaves the host's id unchanged, while a client started from the new bundle computes a
different one. A host whose runtime cannot be read reports no id (unverified) and still starts.

`host ensure` and `host handoff` also print `clientRuntimeBuildId`: the id a host launched from that launch
spec by THIS client would report. A client compares it with `runtimeBuildId` to know whether the host serving
the socket runs its runtime.

A POSIX socket host with an id advertises `runtime_identity_handover` and accepts the conditional handover
`senpi host handoff --when idle --operation <id> --if-instance <instanceId> --if-generation <n>
--target-build <runtimeBuildId>`. The CLI refuses `target_build_mismatch` unless the target is its own
`clientRuntimeBuildId` (the successor runs the CLI's runtime), `stale_generation` unless the socket is served
by the named generation, `handover_unsupported` when the host does not advertise the capability, and
`foreign_agent_dir` when the host belongs to another agent dir (the same check as the generation handoff's,
`detail` naming both). It then sends the host `begin_handover`, carrying its own `agent_dir`, and the HOST
owns the operation:

1. a request naming another `agent_dir` than the host's own refuses `foreign_agent_dir` before anything else
   (a request without the field, from a CLI before it existed, is not checked); a request with an `operationId`
   it already holds answers with that operation when the terms match (and `operation_conflict` when they do
   not); a new operation is checked first against the named generation (`stale_generation`);
2. it stops admitting new work: `prompt`, `steer`, `follow_up`, `send_custom_message`, `append_user_message`,
   `bash`, `compact`, `wake` and the two message edits answer `success: false` with an error starting
   `handover_pending:`. Running turns keep running and keep their control traffic (`abort` included);
3. it waits for its next safe idle point: no request in flight and no open session busy by the same activity
   judgement a drain parks by. A retained session with no work is idle. The wait has no deadline; a long turn
   delays the handover and is never aborted for it;
4. it hands the socket over through the generation handoff above, launched from the CLI's runtime with the
   CLI's daemon environment, and drains. The successor is told the target id and exits before it listens when
   its own runtime digests to another one (its files changed since the request). A successor that never
   answers is stopped, the host keeps serving and admits work again (`handover_blocked`).

The answer is exit 0 `{ action: "handover_completed" | "handover_pending", operationId, handover, ... }`: a host
idle at once hands over before answering, and a request whose target already serves the socket answers
`handover_completed` without touching anything. A repeated `operationId` answers with the operation that
already exists; another id for the same target joins the pending operation (the answer names its id), and
one for another target while one is pending refuses `handover_in_progress`. A
blocked operation refuses `handover_blocked` with the successor's failure in `detail`; a lost reply exits 1
`handover_reply_lost` after checking whether the target now serves the socket. `host status` shows the
operation as `handover: { operation_id, state, target_runtime_build_id, reason?, successor? }` with `state`
`handover_pending`, `handover_switching`, `handover_completed` or `handover_blocked`.

#### Daemon state directory (layout 2)

Every endpoint gets its own directory, named by the socket it serves, so two sockets in one agent
directory can never read each other's state:

```
<agentDir>/rpc-host-daemon/                    flat directory (shared; also a legacy host's own state)
  layout.json                                  { "layout": 2, "dir": "<sha256(canonical socket)[:16]>" }
  <sha256(canonical socket)[:16]>/             0700
    endpoint.json                              { layout: 2, registry_version: 1, endpoint_kind, socket,
                                                 created_at } - durable identity
    host.pid                                   POINTER: { layout, instance_id, generation_dir, writer }
    settings.json                              what the supervisor reads at boot
    daemon.lock  stderr.log
    generations/<instanceId>/                  one directory per generation
      host.pid                                 { pid, processStartTime, instance_id, generation,
                                                 engineVersion, engineOrdinal, launchProfileId,
                                                 socket, writer }
      settings.json  scratch/
    reservations/                              cross-generation session-path claims
```

Directories are `0700` and every state file is `0600`. The canonical socket is, on POSIX, the socket path
with its directory resolved through its deepest existing ancestor (`realpath`; a missing tail is kept
verbatim) - the same identity the ensure lock is keyed by - and on win32 the normalized lower-cased path, so
a client recomputes the directory name from the socket alone and every spelling of one socket (`/tmp` vs
`/private/tmp`, a path through a symlinked directory) shares one directory, one registration and one lock.
A socket already spelled canonically hashes exactly as it did when the name was taken from the spelling
itself, so an existing endpoint keeps its directory. A directory an older build named after a
non-canonical spelling is still listed by `status --all` and collected by `gc`, but new state goes to the
canonical directory. `generation_dir` is relative to the directory holding the pointer (`generations/<instanceId>`), and
`instance_id` is the same id the host reports as `instanceId` in `get_protocol_info` - so a pointer that
names a different id than the socket answers describes a generation that is no longer serving.

The flat directory is deliberately missing a flat `host.pid`: layout 2 writes `layout.json` there and
NOTHING else. A flat pidfile holding `{ pid, processStartTime }` is what arms every DEPLOYED client's kill
path (a desktop reader that finds one takes the host over; a `senpi` from before layout 2 stops it through
`stopManagedHost`), so writing one would let an un-updated client replace this daemon and end every other
client's sessions. Without it those clients fail CLOSED - they find no host of their own, refuse, and leave
the daemon alone. Nothing here ever writes a legacy-shaped file, and nothing here ever REMOVES one: a flat
`host.pid` that does exist belongs to a legacy host, is read-only to this build, and while the process it
names is alive an ensure never starts a second host beside it.

That record is still the proof that retires a legacy host (`host-legacy.ts`). It describes the endpoint it
stamps as `socket`, or, when unstamped, the agent directory's default socket `<agentDir>/rpc/rpc.sock`; its
pid and start time must match the live process, so a recycled pid proves nothing:

- `stopHost({ drain: true })` (`host stop --drain`) accepts it when that endpoint is the target socket and
  the host advertises `generation_handoff`, and sends the drain. A hard stop still needs a layout-2 owner.
- An ensure on ANY endpoint of the agent directory drains a live legacy host and waits for it to exit when
  its endpoint answers with `generation_handoff` and `list_sessions` (workers included) lists no session.
  Otherwise it refuses `legacy_host`, and the CLI refusal carries `detail`: the pid, its endpoint, how many
  sessions it holds and the `host stop --drain --socket <endpoint>` that retires it.
- A handoff (`host handoff`, and an ensure's upgrade) on an endpoint no layout-2 record proves counts the
  running host's sessions over a connection it keeps open. With any session, or no answer, it refuses:
  `legacy_host` with the same `detail` when a flat record proves the process, `unknown_owner` with the
  session count otherwise. With none, the successor takes the socket; a proven legacy process is sent the
  drain only if a recount over that held connection still lists no session, and a host no record proves
  is never signalled - it drains itself once another generation owns the public entry, and the handoff
  writes one stderr warning naming the socket, that host's instance and its engine.

`ensureHost` fails with a typed `HostDaemonStateError` naming the directory it could not create or write,
and starts no host in that case.

`endpoint.json` names the socket the directory serves, in the spelling its first ensure used (its name
is the hash of that spelling's canonical form). It is
written `0600` when the directory is created and re-asserted under the ensure lock. It is written whole to a
temporary name and linked into place, so no reader ever sees half a file, and a valid one is never rewritten, so
`created_at` is the endpoint's first ensure. `endpoint_kind` is `rpc_host` for a multi-session host and `tui`
for an interactive terminal's control endpoint; the first writer's kind stands like the rest of the record. A
record written before `registry_version`/`endpoint_kind` existed (`{ layout, socket, created_at }`) reads as
`rpc_host` and is never rewritten to add them. Under the lock the ensure does replace a file that does not name a
socket hashing to this directory (torn by a crash of an older build, or foreign): left alone, such a file would
leave the endpoint listed as `socket: null` and kept by `gc` as `unknown_identity` forever. It is the one file a generation's release
leaves behind: a supervisor that exits (idle, drained, or after its host child crashed) removes the pointer,
`settings.json` and its generation directory, and without `endpoint.json` such an endpoint could not even be
enumerated. A generation that exits because another entry TOOK its public socket removes only its own
generation directory: the pointer and `settings.json` then belong to whoever replaced it (a handoff rewrites
the settings before its successor boots and moves the pointer once the rename landed), and removing them could
delete the successor's freshly written registration. `stderr.log` and `crashes.jsonl` stay too. The only thing that ever removes an endpoint directory
(`endpoint.json` included) is the explicit `senpi host gc` below, and only on proof that nothing runs behind it.

The directory is PRUNED of what is no longer running on every registration write and on every single-socket
`host status` (never by `host status --all`):
a `generations/<instanceId>/` whose record names a pid nobody is running is removed, the pointer goes with it
while it still names one, and claims in `reservations/` whose owner is gone are removed too. A record that
cannot be parsed is left alone - an ensure writing one right now must not be mistaken for a generation that
ended.

#### Session paths across generations (`reservations/`)

During a handoff two hosts are alive at once, so the in-process path reservation cannot keep them off one
JSONL file. Every generation records each open session path in
`<daemonDir>/reservations/<sha256(canonical path)[:16]>.json` as
`{ instanceId, pid, processStartTime, sessionPath, attached }`, and removes it when the session closes or
parks. `attached` is republished whenever that session gains its first client or loses its last one, so the
claim says whether anybody is still driving the file.

A claim STANDS while one of two things is true: its owner is the generation the pointer names, or its owner
still has a client attached to that session. Those are the cases where somebody is really writing the file.
A claim from a SUPERSEDED generation that published `attached: false` is reclaimable - that generation has
been asked to drain and parks the session as it settles - so the current generation takes the path over
instead of refusing it forever. A claim whose owner is gone (a killed host, a reboot, a recycled pid with a
different start time) is ignored, and a claim written before the field existed is honored, so a running older
build is never reclaimed from.

An `open_session { sessionPath }` refused by a standing claim answers `session_path_in_use` with
`errorData { owner, retry_after_ms: 2000 }`, where `owner` carries `{ instanceId, pid, processStartTime,
sessionPath, current }` - `current: false` names a generation that is still writing the file but no longer
serves the socket. So a reopen during a handoff waits for the previous writer to finish rather than
corrupting its transcript, and a session file is never permanently unopenable.

### The `senpi host` command

Everything above is reachable from one command, so a terminal, a desktop and a task runner get a
daemon the same way instead of each re-implementing the decision:

```
senpi host ensure     [--json] [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
senpi host status     [--json] [--include-workers] [--all] [--socket <path>]
senpi host stop       [--json] [--drain [--instance <id>] [--wait-ms <n>]] [--force]
                      [--expected-generation <json>] [--socket <path>]
senpi host handoff    [--json] [--launch-spec <file>] [--socket <path>]
                      [--when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <id>]
senpi host shard-path --kind <p|i> --owner <id> [--root <dir>] [--json]
senpi host gc         [--json] [--agent-dir <dir>]
senpi host session <open|close|model|prompt|steer|abort|read|state|list|wait> ...   (see "Driving sessions from the CLI")
```

`host stop --force --expected-generation '{"instanceId":…,"generation":…,"pid":…,"processStartTime":…}'` stops only the
generation the operator confirmed (the identity `host status` reports). It takes the endpoint lock and refuses
`stale_generation` without signalling when another generation holds the endpoint, and `unknown_owner` when the process
cannot be proven. `processStartTime` is `null` on platforms that record none (Windows); there a registration and
confirmation that are both null bind pid, instance id and generation, and the stop proves the same process before
signalling: its live start time (read with a 10 s budget) must be no later than the registration was written, so a
reused pid is refused `unknown_owner`, and an answering host must report the confirmed instance id. It cannot be
combined with `--drain`.

The contract is machine-first: EXACTLY ONE JSON line on stdout and nothing else, diagnostics on stderr,
and an exit code that classifies the outcome without parsing the line.

| Exit | Meaning |
|---|---|
| `0` | it happened (`action`: `start`, `reuse`, `handoff`, `stopped`, `drained`, or a reachable `status`) |
| `1` | it failed; `{ action: "error", reason: "host_error", detail }` |
| `2` | the command line or the launch spec is unusable (`{ action: "error", reason: "launch_spec_*" }`) |
| `3` | refused: `{ action: "refuse", reason, host }` - or an unreachable socket (`status`) |
| `4` | fallback: `{ action: "fallback", reason, host }` - under `--policy fallback`, no host is better than this one |

The socket is `--socket`, else `SENPI_RPC_SOCKET`, else `<agentDir>/rpc/rpc.sock`. `--json` is accepted for
symmetry with other commands; the answer is always JSON (the one exception is `shard-path` without `--json`,
which prints the bare socket path).

- `ensure` prints `{ action, socket, pid, instanceId, generation, engineVersion, engineOrdinal,
  capabilities, launchProfileId, runtimeBuildId, clientRuntimeBuildId, reused, upgradeable }`. `--policy upgrade` (the default) allows a
  generation handoff, `never` only attaches or starts, and `fallback` answers exit 4 rather than attaching
  to a host this build disagrees with. `action` is `handoff` exactly when the socket was already served and
  the process behind it changed. An ensure invoked by an in-process session inside a multi-session host is
  attach-only even when its caller requested an upgrade: a host generation never starts its own successor.
  This is process-local state, not an environment marker, so a shell child remains free to run the explicit
  `senpi host handoff` command.
- `status` prints `{ reachable, lifecycle, socket, pid, instanceId, generation, engineVersion, capabilities,
  launchProfile, runtimeBuildId, handover, sessions: { total, interactive, worker, retained, foreign_attached, foreign_retained },
  zombies, rss_mb, host_rss_mb, host_footprint_mb, open_fds, memory_pressure, env_keys, generations, pointer, crashes, shard, session_rows,
  claims_live, claims }` and exits 3 when nothing answers - with the same
  field set, so a caller parses one shape and branches on one boolean. The additive `lifecycle` field is
  `"ready"` while an answering supervised host accepts opens, `"stopping"` while it shuts down or drains,
  and `null` when nobody answers or the answering host does not advertise its lifecycle. An unserved
  socket therefore includes both `"reachable": false` and `"lifecycle": null`; `null` is not `"ready"`.
  `status --all` carries the same field and values on each endpoint row. While stopping, session listing
  is not queried and its empty counts are unobserved, not proof that all sessions have finished.
  Otherwise, `sessions` is what `list_sessions`
  reports under the same flag, so `worker` stays `0` without `--include-workers`; `foreign_*` is the same
  count from the point of view of a client holding none of those sessions itself. `rss_mb`, `open_fds` and
  `zombies` describe the daemon's whole process tree (supervisor, host, and every tool, kernel and server its
  sessions spawned); `host_rss_mb` is only the supervisor and the host process, the number `ps` shows for those
  pids (the host's memory sampler judges pressure by the host's footprint instead, see "Memory pressure").
  `host_footprint_mb` is that footprint for the same supervisor and host processes (`phys_footprint` on macOS,
  `RssAnon` on Linux): unlike RSS it keeps counting compressed and swapped pages, so a host whose RSS reads
  1.3 GB can hold 14 GB, and it is the number to watch when a host grows. All are `null` where the platform does not publish them
  (`open_fds` is `/proc`-only). `generations` lists every ALIVE generation of
  this daemon as `{ instanceId, generation, pid, engineVersion, rss_mb, host_rss_mb, sessions, current, alive }`, newest
  ordinal last: `rss_mb` is that generation's own process tree, `host_rss_mb` only its supervisor and host processes, and `sessions` counts the session files it
  still claims in `reservations/` - the one occupancy number that is observable for a generation which no
  longer answers on the socket. Records of generations that ended are pruned by the read itself, so a status
  never lists a dead pid.

  `pointer` (additive) says which generation the daemon directory names as the one serving the socket:
  `{ state: "current", instanceId, candidates: [] }` normally. When the pruned pointer named a dead generation
  (or none exists), the read gives it back to the ONE generation whose record proves it still serves this socket
  (its own instance id and this public socket path, a live pid with the recorded start time, and no stop intent or
  drain request), reported as `{ state: "elected", instanceId, candidates: [instanceId] }`. With zero or several
  such generations nothing is elected: `{ state: "missing", instanceId: null, candidates }` lists the ones it saw,
  and `host stop` / `host handoff` then refuse `unknown_owner`. `host stop` and `host handoff` run the same
  election under the ensure lock; `status --all` only reports it. An election never replaces a pointer another
  writer created meanwhile, and a prune never removes a pointer a registration replaced after the prune read it.

  The last five fields and `memory_pressure` are additive (a client that does not know them ignores them):
  - `memory_pressure`: whether the ANSWERING generation's memory sampler currently reads its footprint above
    `SENPI_RPC_HOST_RSS_WARN_MB` (the state its `host_memory_pressure` records announce), read from its
    `get_protocol_info`; `null` when nothing answers or the host predates the field. It lives in the host process
    alone, so a draining predecessor's state is not reported, and it is observability only: a pressured endpoint
    admits every open.
  - `crashes`: records in the endpoint's `crashes.jsonl` that are deaths - supervised host children that died
    rather than stopped, `engine_stop` and watchdog lines excluded; `0` when the file is absent. Each line of that
    file is `{ at, signal?, code?, uptimeMs, kind?, generation?, detection?, sender?, chain?, reason?, stopIntent?,
    stall? }`: `kind: "rpc-host"` is a generation's TERMINAL record (at most one per generation) and
    `kind: "rpc-host-watchdog"` the host child's own line when its supervisor vanished; `detection` is
    `supervisor` (it crashed), `external` (a signal nobody announced) or `engine_stop` (an engine process stopped it on
    purpose, named by `sender`/`chain` and `reason`, e.g. `replace_unreachable -> signal:SIGTERM` or
    `readiness_timeout; supervisor_escalated` when the caller had to SIGKILL the supervisor). Every field after
    `uptimeMs` is optional, so older readers keep parsing.
  - `shard`: `{ kind: "p" | "i", key }` when the socket's basename is `<kind>-<16 hex>.sock` (the naming
    contract below), else `null`.
  - `session_rows`: under `--include-workers` only (else `[]`), every row of that same `list_sessions
    { include_workers: true }` reply as `{ id, kind, session_path, cwd, name, attachments, context, memory }`. `session_path` is
    the host's canonical path, the key a client matches a session by; `context` is the published labels
    including the host's own `host_socket`/`host_instance`, `null` where none were published. `memory` is the
    per-session heap split the host published on the listing, as `{ main_heap_mb, kernel_heap_mb, kernel_count }`:
    the host's main-thread heap (the same host-wide number on every row), the sum of this session's kernel
    heaps, and how many kernels that is. All three are `0` for a session holding no kernel, and for every row
    of a host released before the field - never `null`.
  - `claims_live`: session-path claims in `reservations/` whose owner process is still running, `0` when the
    directory is absent.
  - `claims`: under `--include-workers` only (else `[]`), every claim in `reservations/` whichever generation
    wrote it, as `{ session_path, owner_pid, instance_id, generation, attached, live }` - so a path a
    draining predecessor still holds is visible although the answering generation no longer lists it.
    `generation` is the owner's ordinal while its generation record exists, else `null`; `attached` is `null`
    for a claim written before that flag existed.
- `status --all` reports every endpoint the agent directory holds state for and ignores `--socket`:
  `{ endpoints: [<status row>, ...] }`, each row the single-socket report above plus `dir` (the endpoint's
  daemon directory) and `identity` (what named its socket: `endpoint` = `endpoint.json`, `settings` = the
  boot `settings.json`, `generation-settings` = a generation's own `settings.json`; each accepted only when
  that socket hashes to the directory it was found in), `endpoint_kind` (`rpc_host` | `tui`, from
  `endpoint.json`; `rpc_host` for a legacy record or any other source), `alive`, `reason` and `owner`. `alive` is `true`
  exactly when the endpoint is routable - its socket ITSELF answered `get_protocol_info` naming an instance its
  directory recorded under `generations/` (a socket that answers without naming one is not routable, whatever
  generation the directory last recorded; the row's `instanceId` may still show that recorded id) - and `reason`
  is then `null`; otherwise `reason` is `live_unresponsive`
  (a recorded process is still running, or something answered that the directory did not record: a
  suspended terminal, a host past its budget) or `dead` (nothing answered and every recorded process is
  gone, or its pid now names a process with another start time - the same test `gc` applies to
  generations). A `tui` row is probed for at most 1.5 s whatever budget the hosts get, so a stopped
  terminal is reported `live_unresponsive` without stalling the listing. A `tui` endpoint is sent
  `get_protocol_info` and `list_sessions` only - the two commands both endpoint kinds answer - and its row
  carries `owner: { pid, cwd, session: { id, path, name } | null }`: the terminal's recorded pid and the one
  session it lists (`cwd`/`session` are `null` when it did not answer). `owner` is `null` on a host row. A directory none of them names is still listed with
  `socket: null` and `identity: "unknown"`, built from the directory alone - the ensure lock is keyed by a
  longer hash of the socket's transport address and cannot be rebuilt from the 16-hex name, so it can be
  shown but never addressed. Before layout 2 (no `layout.json`) the answer is `{ "endpoints": [] }`. Unlike
  the single-socket form, `--all` REMOVES NOTHING: a dead generation is a row with `alive: false`, an endpoint
  whose host exited stays listed through its `endpoint.json` with `reachable: false` and `generations: []`,
  and reclaiming what ended is left to the explicit, evidence-gated `gc`. Every endpoint is read at
  once, each under its own budget (10 s per read), and a socket that does not answer the identity probe is
  not asked for its session listing, so hung hosts cost about one budget in total; rows stay in directory order. Exit `0` while at least one endpoint answers, `3` when none does or none exists.
- `shard-path` computes a shard socket without contacting any host, so a client that does not link senpi
  can check its own copy of the naming contract against the engine: `{ kind, key, socket }` under `--json`,
  the socket path otherwise. `--root` defaults to `<agentDir>/rpc/shards`.
- `gc` removes the state of endpoints whose host is PROVABLY gone, in the agent directory (`--agent-dir`, else
  the current one; `--socket` is ignored), and answers `{ removed: [{ socket, dir, reason }], kept: [{ socket,
  dir, reason }] }` with exit `0` whatever it found (`2` for a bad flag). It never signals a process and never
  runs implicitly - not inside `ensure`, not inside `status`. For each endpoint whose socket is known it takes
  that socket's ENSURE lock (`<tmp>/senpi-rpc-host-locks/<sha256(transport address)[:32]>.lock`, the one
  `ensureHost` serializes on - not `daemon.lock`; on POSIX the address is the socket path with its directory
  realpath-canonicalized, so every spelling of one socket shares one lock) for at most 2 s, and inside it requires all three: (a) no
  `generations/*/host.pid` names a live process (pid live and start time matching; a live pid whose identity
  cannot be read counts as live; the generation the pointer names is one of them), (b) no claim in
  `reservations/` has a live owner, and (c) connecting to the socket fails with `ENOENT`, or with `ECONNREFUSED`
  on an entry that is a socket (a regular file where the socket should be is kept as `reachable`) - and so does
  every `<socket>.next-*` successor bind beside it. Only then does it unlink the `<socket>.next-*` /
  `<socket>.shield-*` siblings, then the socket, then remove the endpoint directory LAST, still under the lock;
  `reason` is `socket_refused` or `socket_absent`. A sibling that is a directory is not unlinked: it stays and
  the removed entry lists it as `skipped: [{ path, type: "directory" }]`. Because the directory goes last, a
  removal that fails part-way leaves the endpoint listed for the next gc. Everything else is kept with its
  reason: `live_generation`, `live_claim`, `reachable`, `locked` (an ensure held the lock for 2 s),
  `legacy_layout` (a flat directory without `layout.json` - a legacy host's, never touched), `unknown_identity`
  (nothing names the socket, so its lock cannot be taken), or `failed` (reading the evidence or removing threw;
  the entry carries `error`) - and a `failed` endpoint never stops gc from going on to the others.
  One RUNNING host is different (#3268): a host of an OLDER engine runs that engine's idle decision, so when that
  decision is stuck no newer build can end it from inside. For an endpoint otherwise kept as `live_generation` or
  `reachable`, gc (`senpi host gc` and the budgeted pass `ensureHost` schedules) also judges, still under the
  lock and with observing reads only, whether the host is a stale older-engine leftover. A host that is no
  candidate at all - its owner is not proven, it does not answer, or its `engineOrdinal` is not strictly older
  than the caller's (an uncomparable ordinal is equal), which is every host of the caller's own engine - keeps
  the reason above. A candidate is stopped through the `host stop` path only when ALL of these hold, and is
  otherwise kept with the first `stale_*` reason that failed: its recorded policy is not `persistent` (`stale_persistent`), it lists no
  session, workers included (`stale_sessions`), `reservations/` holds no claim (`stale_claims`), it has been up
  longer than its own recorded `idleExitMs` plus 10 minutes (`stale_young`), and its supervisor holds no
  accepted connection on the public socket, read from the operating system (`lsof` on macOS, `/proc` on
  Linux), counted before the judge's own reads connect; an unreadable count, and Windows, keep it (`stale_clients`). A stopped host is listed under
  `stopped: [{ socket, dir, reason: "stale_old_engine", pid }]` (the key is absent when nothing was stopped), and
  its directory is collected by a later gc. The stop itself re-reads the host with 2 s budgets and is refused
  unless both reads answer and report no session, so a host that went silent after it was judged is not stopped.
  `senpi host status --all` marks such a host `stale_old_engine: true`.
  An `unknown_identity` directory is never removed by gc; remove it by hand only after checking that no pid in
  its `generations/*/host.pid` or `reservations/*.json` is running and that no process holds files under it.
  An ensure that raced a gc simply re-creates `endpoint.json` under the lock after gc released it.
  The library call `gcHostEndpoints(agentDir, { kinds: ["tui"] })` narrows a run to endpoints of those
  `endpoint_kind`s (a terminal reaping dead `tui` endpoints at its own startup): every other endpoint, and
  the legacy flat directory unless `rpc_host` is listed, is neither judged nor reported, and the ones it
  judges face the same three-part evidence. `classifyEndpointLiveness(entry)` returns the `alive`/`reason`
  verdict above for one `listHostEndpoints` entry, probing it once under its kind's budget; it reads only.
- `ensure`, `handoff` and `stop` never act on a terminal control endpoint: a `--socket` whose directory's
  `endpoint.json` says `endpoint_kind: "tui"`, or whose name is a terminal socket's (`t-<16hex>.sock`, which a
  terminal that exited leaves unrecorded), is refused with exit 3 `{ action: "refuse", reason:
  "unsupported_endpoint_kind", socket, endpoint_kind: "tui", host: null }` from disk alone, before any
  connection - whatever `--policy`, `--drain` or `--force` says. A terminal owns its endpoint; `gc` reaps a dead
  one on the same evidence as a host's.
- `stop` is the I1 carve-out: a plain stop needs a validated pidfile AND `foreign_attached +
  foreign_retained == 0`, or it refuses with exit 3 and prints the counts it refused on; `--force`
  overrides after printing the same counts; `--drain` is always permitted, because it ends no work. It
  asks through the generation's drain request (SIGUSR1 only for a generation from before it), `--instance <id>`
  names a generation other than the current one, and `--wait-ms <n>` waits for it to exit and adds `exited` to
  the answer; both need `--drain`.
- `handoff` forces a generation handoff from THIS binary. A host that cannot drain and a platform that
  cannot rename answer alike: exit 3 `{ reason: "upgrade_unsupported", detail }`. The handoff runs inside the
  endpoint's ensure lock (the one `ensure` and `gc` take), so an `ensure` arriving while the successor comes up
  waits and then attaches to the successor, and `gc` reports the endpoint `locked` rather than judging it
  halfway. An `ensure` waits for the lock as long as the longest holder can keep it: a probe plus either a
  stop-and-restart or a handoff (probe, successor start, 30 s readiness). A REFUSED handoff leaves the endpoint
  as it found it: the successor it started is killed and, once it has exited (up to 5 s), its generation record
  and directory are released, so `status --all` never lists it; the boot `settings.json` it rewrote before
  spawning is restored byte for byte. A cleanup that fails is reported in the refusal's `detail`.

#### Shard naming contract (`shardKey`, `shardSocketPath`)

A client may run many endpoints under one agent directory - omo one per parent session (`p`), the Desktop
one per thread (`i`), under `<agentDir>/rpc/shards/`. Every client derives the socket identically:

```
key    = sha256("<kind>:<ownerId>") in hex, first 16 characters
socket = <root>/<kind>-<key>.sock
```

`packages/coding-agent/src/modes/rpc/host-daemon-paths.ts` exports `shardKey(kind, ownerId)`,
`shardSocketPathForKey(root, kind, key)` (no hashing) and `shardSocketPath(root, kind, ownerId)`. Fixed
vectors every implementation must reproduce:

| kind | owner | key | socket under `/r` |
|---|---|---|---|
| `p` | `01a0e28d-40e4-7402-bac7-8de6e76ad84c` | `6d410ba846ba1550` | `/r/p-6d410ba846ba1550.sock` |
| `i` | `thread-0001` | `da99f196e11b1cf9` | `/r/i-da99f196e11b1cf9.sock` |
| `p` | (empty) | `3ba7290d74188485` | `/r/p-3ba7290d74188485.sock` |

#### Launch spec (`--launch-spec <file>`)

The spec is what decides the code a long-lived, machine-wide daemon LOADS, so it is a trust boundary and
deliberately a FILE - never stdin, never an argv blob, both of which have no owner to check:

```json
{
  "spec_version": 1,
  "core": { "session_runtime": "in-process", "multi_session": true, "extensions": ["ext/probe.js"] },
  "tunables": { "idleExitMs": 900000, "coldStart": "transient" },
  "env": { "SENPI_X": "1" }
}
```

Extension paths are resolved against the SPEC FILE'S directory. Four refusals are proven before any
process is started, each reported with exit 2:

| Reason | When |
|---|---|
| `launch_spec_insecure` | the file is not owned by this uid, or it is group/world writable |
| `launch_spec_path_escape` | an extension path leaves the spec directory's tree, lexically or through a symlink |
| `launch_spec_env_denied` | an `env` key outside `^(SENPI\|OMO\|PI)_[A-Z0-9_]+$` |
| `launch_spec_missing_extension` | a listed extension does not exist - a daemon never boots with half a profile |

(`launch_spec_unreadable` and `launch_spec_invalid` cover a missing file and a malformed document.)

#### Daemon environment scope

A daemon outlives the shell that started it and serves every client on the machine, so it does NOT inherit
the ensuring process's environment. It receives an allowlist of NAMES - `PATH`, `HOME`, `USER`, `LOGNAME`,
`SHELL`, `TMPDIR`, `TERM`, `LANG`, `LC_*`, `XDG_*`, `SENPI_*`/`OMO_*`/`PI_*`, `HTTP_PROXY`/`HTTPS_PROXY`/
`NO_PROXY`, `*_API_KEY`, and the provider prefixes (`ANTHROPIC_`, `OPENAI_`, `GOOGLE_`, `GEMINI_`, `AZURE_`,
`AWS_`, `OPENROUTER_`, `XAI_`, `MISTRAL_`, `DEEPSEEK_`, `GROQ_`, `CEREBRAS_`, `MINIMAX_`) - plus whatever the
spec's `env` states. Matching is case-sensitive on POSIX and case-insensitive on win32, where the OS wiring
(`SystemRoot`, `ComSpec`, `PATHEXT`, ...) is allowed as well. Values are never inspected; `status` reports
the granted NAMES as `env_keys` and never a value.

The product-lane allowlist has an explicit transient denylist. Session context (`PI_SESSION_*`,
`PI_GOAL_STORE_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`,
`PI_PROMPT_CACHE_SAFE_WAIT_SECONDS`), the Python eval-kernel parent
(`SENPI_PY_KERNEL_PARENT_PID`), and inherited `SENPI_RPC_HOST_*` generation/watch/scratch identity never
cross into either an initial daemon or a handoff successor. Legitimate daemon configuration in the same
namespace, such as RSS thresholds, idle windows and feature flags, remains allowed. The spawn applies the
new generation's own instance id, generation and daemon directory after filtering, so caller overrides
cannot replace lifecycle identity.

#### Verifying a daemon build (live QA drivers)

Two POSIX-only drivers in this repository exercise the whole daemon against real processes in a sandbox agent
directory, printing one JSON line per step (written synchronously, so a step that hangs has still printed every step
before it) and a final cleanup receipt. They are how a build is checked before it is trusted with other clients'
sessions:

| Driver | What it proves |
|---|---|
| `node scripts/qa-rpc-socket/inprocess-daemon-qa.mjs` | Two COMPILED binaries of the tree differing only in build epoch; `host ensure --json` run from the older one; per-session `context` isolation (each session's extension sees only its own); `list_sessions` with and without `include_workers`; 50 sessions with the measured thread cost and no refusal; a retained session re-attached across a dropped connection; 200 bash calls leaving zero zombies; and a generation handoff by the newer binary while a client stays connected. |
| `node scripts/qa-rpc-socket/generation-handoff.mjs` | The handoff alone, against the source supervisor: `ensureHost` -> generation 0, `handoffHost` -> generation 1 on a new pid, `session_path_in_use` naming the owner while the held session is parking, `session_closed { reason: "handoff_parked" }`, the predecessor exiting, the transcript reopening intact in the new generation, and `stopHost({ drain: true })` draining to exit. |

Both exit non-zero if a daemon, a fixture host or the sandbox survives the run: a host outliving its QA is
exactly the failure they exist to catch.

### Driving sessions from the CLI

`senpi host session` is a thin client over the wire commands this document already describes: it attaches to a
session (or starts the shared host, for `open` only) and relays one request, so an orchestrating agent or script
can drive a session without writing its own RPC client. It adds no new wire command; it relies on the typed
`errorCode` the host sets on `prompt` (`streaming`), `set_model` (`model_not_found`) and `get_entries` (`not_found`)
refusals.

```
senpi host session open   --cwd <dir> [--model <provider/id>] [--name <text>] [--prompt <text|@file>]
                          [--launch-spec <file>] [--socket <path>] [--json]
senpi host session close  <ref> [--socket <path>] [--json]
senpi host session model  <ref> <provider/id> [--socket <path>] [--json]
senpi host session prompt <ref> <text|@file> [--socket <path>] [--json]
senpi host session steer  <ref> <text|@file> [--socket <path>] [--json]
senpi host session abort  <ref> [--socket <path>] [--json]
senpi host session read   <ref> [--tail <N>] [--since <entryId>] [--messages] [--socket <path>] [--json]
senpi host session state  <ref> [--socket <path>] [--json]
senpi host session list   [--socket <path>] [--json]
senpi host session wait   <ref> [--until idle|done] [--timeout <ms>] [--socket <path>] [--json]
```

The contract is machine-first, exactly like `senpi host` itself: EXACTLY ONE JSON line on stdout per call
(written synchronously), diagnostics on stderr, and an exit code that classifies the outcome without parsing
the line.

| Exit | Meaning |
|---|---|
| `0` | it happened - the payload's `action` names the subcommand (`open`, `close`, `model`, `prompt`, `steer`, `abort`, `read`, `state`, `list`, `wait`) |
| `1` | it failed: `{ action: "error", reason, detail }` with `reason` one of `transport_gone`, `wait_timeout`, `open_failed`, or `host_error` (a host failure that carries no code; `detail` is the host's text) |
| `2` | the command line is unusable: `{ action: "error", reason: "usage" \| "prompt_file_unreadable", detail }` |
| `3` | refused: `{ action: "refuse", reason, detail, data? }` - every host error code (`unknown_session`, `host_draining`, `session_held` with `holders`, `model_not_found`, ...; the host's `streaming` reads `busy` and `not_found` reads `unknown_cursor`) plus the CLI's own `ambiguous_session` (with `candidates`), `host_unavailable` (no host answers the socket and the verb is not `open`) and `unsupported_endpoint_kind` (the socket is a terminal's control endpoint, refused before any connection) |

A refusal is classified by the host's `errorCode`, or by the session router's bare code when that is the whole
`error` string; message text is never parsed. A host started by an older build (reused by `open` as compatible)
sends no `errorCode` for a busy `prompt`, an unknown model or an unknown cursor, so until that host is replaced
those three refusals read exit 1 `host_error` with the host's text in `detail`.

Every verb except `list` resolves `<ref>` (a `sessionId`, `durableSessionId`, `name`, or `sessionPath`) through
`list_sessions` and then ATTACHES to the session before acting. A name that more than one live session carries is
refused `ambiguous_session` rather than resolved to either, and so is a `durableSessionId` that more than one
transcript carries, live or parked (a caller-minted id reused while its first session was parked): `candidates`
lists their paths, or the routing handle (`rpc-N`) of a live session that has no transcript file yet. A
`sessionPath`, or a `durableSessionId` naming one
transcript under `<agentDir>/sessions/`, that the host no longer lists (it parked the session) is RESUMED: the CLI
re-opens it with `open_session { sessionPath, retain_on_disconnect: true }`, so the resumed session again outlives
the call, and acts on the new routing handle it reports. Attaching is what authorizes `close` and what lets `wait` receive events;
it also resets the host's idle window like any other attached connection (see "Host idle exit" above). `list` is
the one exception: it calls `list_sessions { observe: true }`, so polling it never counts as host occupancy.

- `open --cwd <dir> [--model <provider/id>] [--name <text>] [--prompt <text|@file>] [--launch-spec <file>]`
  attaches to or starts the shared host through the same `ensureHost` attach-or-create path as `senpi host ensure`
  (`--socket` resolution is identical, too), then calls `open_session { cwd, retain_on_disconnect: true, ... }` so
  the session survives this process's exit. It prints `{ action: "open", socket, pid, sessionId, sessionPath,
  durableSessionId, cwd, model: { provider, id }, attached, reused, prompt? }`. `--name` sets the session's display
  name; `--prompt` starts one turn after open and reports its `disposition` without waiting for the turn to finish.
  When naming or `--prompt` fails after the session exists, `open` closes that session again and the failure
  payload carries `sessionId`, `sessionPath`, `durableSessionId` and `closed`; `closed: false` (the close itself
  failed, e.g. the transport dropped) tells the caller to close it by those ids.
- `close <ref>` attaches and closes the session. `{ action: "close", sessionId, closed, reason? }`: `closed: false`
  means another client still holds an attachment (`close_session` only released this call's own attachment), not a
  failure. The host aborts and drains a mid-turn session within its own grace; the CLI never force-aborts.
- `model <ref> <provider/id>` changes the model whether the session is idle or mid-turn and prints
  `{ action: "model", sessionId, requested: { provider, id }, model: { provider, id }, pendingModelSwitch }`
  (`model` and `pendingModelSwitch` come from `get_state` read right after the call). `set_model` also persists the
  GLOBAL default model and provider, not just this session's; a switch to a smaller context window can be held as
  `pendingModelSwitch` instead of applying immediately. An unknown model answers `{ action: "refuse", reason:
  "model_not_found" }`.
- `prompt <ref> <text|@file>` starts a turn and prints `{ action: "prompt", sessionId, disposition }`
  (`"started"` or `"handled"` - a `"handled"` disposition means an input handler consumed it and no model run
  necessarily follows). A prompt sent while a turn is already running is refused `busy` (the host's `streaming`
  code); the check is the host's own admission, made when the prompt arrives.
- `steer <ref> <text|@file>` prints `{ action: "steer", sessionId, disposition, streaming }`. `streaming: false`
  means the session was idle when the steer arrived: the message is PARKED and delivered with the next `prompt`,
  it does not start a turn by itself. `streaming: true` means it was queued into the running turn.
- `abort <ref>` stops the running turn (if any) and prints `{ action: "abort", sessionId, acknowledged: true,
  aborted }`. `aborted` reflects whether a turn was actually running when the abort was admitted; an abort on an
  idle session is still exit 0 with `aborted: false` (a no-op, not a failure). Use `wait --until idle` to confirm
  the session has actually settled afterward.
- `read <ref> [--tail N] [--since <entryId>] [--messages]` prints `{ action: "read", sessionId, entries, count,
  total, leafId, nextSince }` (or, with `--messages`, `{ action: "read", sessionId, messages, count }` from
  `get_messages`, the runtime context rather than the durable log). `--since` is EXCLUSIVE (entries after that id)
  and is applied before `--tail`; `nextSince` is the id of the LAST entry this call actually returned, in append
  order - it is the cursor for the next call. `leafId` is the current branch leaf and is informational only; it is
  never the right value to pass as the next `--since`. An unknown `--since` id is refused `unknown_cursor`.
- `state <ref>` prints `{ action: "state", sessionId, durableSessionId, state }`, the session's `get_state` object
  untouched.
- `list` prints `{ action: "list", socket, sessions }`, an observe-only read of `list_sessions`.
- `wait <ref> [--until idle|done] [--timeout <ms>]` (defaults: `idle`, `600000`) blocks on the session's real
  settle events, never on a poll: `--until done` resolves on the first `agent_settled` (or a synthetic one from a
  sealed session) after the call; `--until idle` resolves only once a settle ALSO leaves `steering`, `followUp` and
  `pendingMessageCount` empty in `get_state`, so a steer queued mid-turn delays `idle` until its own follow-up turn
  also settles. `turn_end` and `agent_end` are deliberately never used for either mode: one prompt can produce
  several `turn_end`s through tool continuations, and `agent_end` may still be followed by a retry. It prints
  `{ action: "wait", sessionId, until, outcome }` where `outcome` is `"done"`, `"idle"`, `"already_idle"` (no turn
  was running when `wait` was called; for `--until idle` the queues must also be empty, so a steer parked on an idle
  session keeps `idle` waiting until a `prompt` drains it), `"session_closed"` or `"session_parked"`; a timeout is
  `{ action: "error", reason: "wait_timeout" }` exit 1, and a transport loss while waiting is `transport_gone`.

Session references: `open` and `list` report `sessionId`, `sessionPath` and `durableSessionId` together. `sessionId`
is a per-host-epoch routing handle that disappears across a park or handoff; `sessionPath` and `durableSessionId`
survive it, and every subcommand accepts any of the three (plus the session's `name`) as `<ref>` and re-resolves it
on every call, resuming a parked session as described above. A session parked before its first message has no
transcript yet and cannot be resumed; a reference to it is `unknown_session`.

Ownership: public endpoints first use [authentication](#authentication); socket clients then attach before mutating a session. The `senpi host session` commands already attach
on the acting connection. Raw clients use `attach_session` for a live identity or `open_session` to open/resume
a path. This release serves and logs legacy unattached mutations unless `SENPI_RPC_REQUIRE_ATTACH=1`;
see [Attachment admission](#attachment-admission). Reads remain available without an attachment. `close`
releases the caller's own attachment and closes the session only when no other client still holds one.

Retention limits (what `open`'s `retain_on_disconnect: true` does NOT survive): an explicit `close`, the host's own
idle-eviction window (`SENPI_RPC_SESSION_IDLE_EVICTION_MS`, default 30 minutes, after which the session is parked -
any `senpi host session` verb given its path or durable id resumes it), or the host process exiting. A session that has not
received a message yet may have no JSONL file on disk even though `open` already reported a `sessionPath`.

A minimal orchestration run:

```sh
id=$(senpi host session open --cwd /work --model anthropic/claude-sonnet | jq -r .sessionId)
senpi host session prompt "$id" "do the thing"
senpi host session wait "$id" --until done --timeout 300000
senpi host session read "$id" --tail 5
senpi host session close "$id"
```

### Child reaping on a socket host (`SENPI_RPC_HOST_REAPER`)

A socket host reaps the exited child processes that no thread is left to wait on. A `worker_threads` Worker owns the
exit watchers of every child it spawned, so terminating one - which is what the session-worker quarantine does - turns
its already-exited children into zombies of the HOST process, for every spawn API (`child_process.spawn`, `Bun.spawn`,
`Bun.$`) and under both the source and compiled runtimes. Children spawned from a live thread are reaped by their own
runtime and never reach the reaper.

Latency and safety: a 1-second unref'd tick enumerates the host's DIRECT children, peeks at each with
`waitid(P_PID, pid, WEXITED | WNOHANG | WNOWAIT)` - which reads the exit status without consuming it - and only
`waitpid(pid, WNOHANG)`s a pid that stayed waitable across two ticks at least 30 seconds apart (`waitpid(-1)` is never
called). So an abandoned child is claimed 30-31 seconds after it exits. That window is what keeps the reaper from
stealing a child from a live owner: a thread blocked in a synchronous call cannot reap its own child until it unblocks,
and a stolen child breaks the owner's contract (measured: `child_process` and `Bun.spawn` reject with `ECHILD`,
`Bun.$` never settles). A thread that blocks synchronously for longer than the window while awaiting a child therefore
loses that child's exit status; `SENPI_RPC_HOST_REAPER_MIN_WAITABLE_MS` raises the window (never below its 5-second
floor) and `SENPI_RPC_HOST_REAPER=0` turns reaping off entirely. The bindings need `bun:ffi`: a host running under Node
logs one warning at startup and reaps nothing. While at least ten children sit waiting, the host logs one line per
five minutes with the count and the three commonest command names.

On Windows, listeners and clients deterministically map the logical socket path to
`\\.\pipe\senpi-rpc-<sha256[:32]>`. Callers keep using the same `unix://` CLI value; the logical path remains the
ownership and settings identity, and callers never construct the pipe name themselves.

Socket event visibility is attachment-scoped for session content: each connection receives agent output only from sessions
attached to that connection, with every record tagged by its routing `sessionId`. Content-free lifecycle records
(`agent_start`, `agent_settled`, `agent_idle`, `session_opened`, `session_closed`, and `session_parked`) are broadcast to all
registered connections, including the supervisor's unattached observer, so host lifecycle accounting remains accurate without
exposing session content. The one exception is `session_closed` and `session_parked` for a session opened with
`kind: "worker"`: they are delivered only to
the connections attached to that session, so machine-driven work neither appears in nor disappears from a client that never
asked for it. Every other lifecycle record, and every record of an `interactive` session, keeps today's broadcast. Host-level
records (`host_superseded`, `host_stalled`, `host_memory_pressure`) are broadcast the same way and describe the host process rather than a
session. Correlated responses and dialog extension UI
requests (select, confirm, input, and editor) are requester-only; other extension UI state records go to the session's
attached connections. To observe a foreign session, open it by its existing
`sessionPath`; the host attaches that connection during `open_session`.

### Session status stream (`subscribe_sessions`)

A multi-session host advertising the capability `session_status` pushes one `session_status` record per change of every session a subscription matches: opened, running, waiting on a question, compacting, idle, unloaded or closed, plus attachment, model, queue and context changes. A subscription is activity-neutral: it never counts as an attachment, never refreshes a session's idle window, and an `observe: true` request never counts as host activity either.

#### subscribe_sessions

```json
{"id": "s1", "type": "subscribe_sessions", "sessions": "all", "include_workers": false, "include_context": false, "mirror": "none", "effects": false}
```

- `sessions`: `"all"` (default), `{ "ids": [...] }` (routing ids, durable session ids or session paths), or `{ "childrenOf": "<durableSessionId>" }` (sessions whose `context.parent_session_id`, or else `context.root_session_id`, equals it).
- `include_workers`: include `kind: "worker"` sessions; default `true` for `childrenOf`, `false` otherwise.
- `include_context`: carry each session's published `context` on its records; default `false`.
- `mirror`: `"none"` (default), `"all"` or an array of record types (`["message_update", "tool_execution_start"]`). The matched sessions' records of those types are also delivered to this connection. Mirroring is an explicit opt-in open to every subscriber of the host (the socket is per user, mode 0600): it is not an attachment and does not keep a session alive. Worker content is mirrored only with `include_workers: true`.
- `effects`: also deliver `effect_status` receipts of matched sessions; default `true` for `childrenOf`, `false` otherwise. Each `effect_status` is enqueued after the record that caused the transition and shares the subscription's `seq`.
- `dialogs`: with capability `dialog_observer`, also deliver the `ui_request_pending` and `ui_request_settled` records of matched sessions; default `false`. It takes effect only together with a `mirror` selection, stays observing, and grants no answering authority (see "UI-answer receipts and dialog observation").

Response:

```json
{"id": "s1", "type": "response", "command": "subscribe_sessions", "success": true,
 "data": {"subscriptionId": "sub-1", "seq": 0, "hostGeneration": "0", "hostInstanceId": "<uuid>", "snapshot": [ /* session_status records, seq 0 */ ]}}
```

The snapshot is the state at subscription time. The response carrying it is the first record of the subscription: a connection that already holds 64 subscriptions is refused with `subscription_limit`, and on the stdio transport the command is refused with `unsupported_transport`. Every later record of the subscription has `seq` strictly one more than the previous one, starting at `seq + 1` behind the response. A reconnect is a new subscription with a fresh snapshot; nothing is replayed. Refusals carry `errorCode: "invalid_subscription"` (or `subscription_limit` / `unsupported_transport`) and `errorData { reason, action }`.

#### unsubscribe_sessions

```json
{"id": "u1", "type": "unsubscribe_sessions", "subscriptionId": "sub-1"}
```

Ends a subscription held by the same connection; a closed connection ends its subscriptions. Any other id answers `unknown_subscription` with `errorData { reason, action }`.

#### set_session_context

```json
{"id": "c1", "type": "set_session_context", "sessionId": "rpc-1", "patch": {"task_status": "running", "run_epoch": 2, "stale_key": null}}
```

An attached connection patches the context a session publishes (on `list_sessions { include_workers: true }` and on `session_status` for subscribers with `include_context`). Keys match `^[a-z][a-z0-9_]{0,63}$`; values are strings of at most 256 characters, numbers, booleans, or `null` to delete; the patched context is at most 4096 bytes of JSON. The host's own keys (`host_socket`, `host_instance`, `shard_key`, `tree_key`) and the lineage keys (`parent_session_id`, `root_session_id`) are refused with `invalid_session_context` and `errorData { reason, action }`. The session's extensions keep reading the context the session was opened with, and a `childrenOf` subscription matches on that frozen open-time context, so no patch moves a session into or out of a supervisor's children view. The response carries the published `context`; subscribers with `include_context` receive a `session_status` with cause `context`.

The SDK sends it with `RpcClient.setSessionContext(patch, sessionId?)`, which defaults to the attached session and rejects with an `RpcCommandError` carrying the code. A client with no attached session that passes no `sessionId` refuses locally, without sending anything, with the same `RpcCommandError` and `errorCode: "session_not_attached"`.

A connection without an attachment receives `errorCode: "session_not_attached"` with `errorData.reason: "this connection is not attached to that session"` and `errorData.action: "attach first with open_session { sessionPath }, then patch its context"`.

#### session_status

```json
{"type": "session_status", "subscriptionId": "sub-1", "seq": 4, "sessionId": "rpc-1", "durableSessionId": "<id>", "sessionPath": "<path>",
 "kind": "interactive", "cwd": "<cwd>", "status": "idle", "reason": "aborted", "attachments": 3,
 "model": {"provider": "anthropic", "id": "<model>"}, "thinkingLevel": "high", "pendingQueue": {"steering": 1, "followUp": 0},
 "lastChange": {"at": "2026-10-12T08:00:00.000Z", "cause": "abort", "by": "client"}}
```

- `status`: `opening`, `idle`, `running`, `waiting_input` (a question is pending), `compacting`, `unloaded` (the routing handle ended and the session reopens by `sessionPath`; `reason` is `idle`, `unload_session` or `handoff`), or `closed` (`reason` is the `session_closed.reason`). After an abort ends a run, `idle` carries `reason: "aborted"`.
- `lastChange.cause`: `open`, `prompt`, `agent_end`, `agent_idle`, `abort`, `question`, `compaction`, `set_model`, `queue`, `attach`, `detach`, `replace`, `park`, `close` or `context`; `by` is `client`, `agent` or `host`.
- `context` is present only with `include_context`. `lastEffect: { effectId, kind, state }` names the session's most recent effect receipt (an input with a `clientMessageId`, an abort, a model or thinking-level switch) and is absent on hosts without the `effect_ledger` capability or before the session's first effect.
- On `new_session`, `switch_session` or `fork` the routing id stays; the record carries the new `durableSessionId` and `sessionPath` with cause `replace`.

Ordering: a status rides the subscribing connection's own queue and is enqueued AFTER the record that caused it, so a connection that is both attached and subscribed always reads `queue_update` before the `session_status` it caused, and `agent_idle` before the matching `idle`.

Three-client example (A drives, C attaches, B only subscribes):

```text
B -> subscribe_sessions {}                               <- snapshot [] seq 0
A -> open_session {cwd}                                  B <- session_opened rpc-1; session_status open (seq 1)
C -> open_session {sessionPath}                          B <- session_status attach, attachments 2
A -> set_model {...}                                     B <- session_status set_model
A -> steer {message}                                     B <- session_status queue, pendingQueue.steering 1
A -> abort {}                                            B <- session_status abort, idle/aborted
A -> new_session {}                                      B <- session_status replace, new durableSessionId
A -> open_session {cwd}                                  B <- session_opened rpc-2; session_status open
A -> close_session {rpc-1}                               B <- session_status detach, attachments 1
```

`session_opened { sessionId, durableSessionId, sessionPath, kind, cwd, context? }` is emitted for every session the host creates (not for an attach). An `interactive` session's record is broadcast to every connection, including connections without a subscription. A `worker` session's record reaches its attached connections and matching subscribers with `include_workers`. For both kinds, `context` is included only for matching subscribers with `include_context`; all other recipients receive the record without context.

#### effect_status

```json
{"type": "effect_status", "subscriptionId": "sub-1", "seq": 5, "sessionId": "rpc-1",
 "effectId": "stop-1", "kind": "abort", "state": "done", "disposition": "applied",
 "by": {"connectionId": "A"}, "at": "2026-10-13T08:00:00.000Z"}
```

On a host with the `effect_ledger` capability, a subscription with `effects: true` receives one `effect_status` per effect transition of every matched session: every `rpc_effect` transition (`abort`, `set_model`, `set_thinking_level`) and every input admission transition (`prompt`/`steer`/`follow_up` with a `clientMessageId`, whose `effectId` IS the `clientMessageId`). `kind` is `input`, `abort`, `set_model`, `set_thinking_level`, `unload` or `dequeue`; `state` is `accepted`, `applied`, `done` or `failed`; `disposition` and `outcome` follow the `get_effect_status` shape. `by` names the connection whose command the effect belongs to (absent on `input` receipts, which carry no actor) and `at` is the transition time.

An `effect_status` is enqueued on the subscribing connection AFTER the record that caused the transition and shares the subscription's gap-free `seq`: a subscriber watching an `abort { effectId }` reads the abort's `session_status` deltas and the effect's `accepted -> applied -> done` as one ordered stream, with `done` landing after the `agent_idle` status that sealed the turn. The causing record is a session event or status delta, never the command's own response: a connection that sends `abort { effectId }` and also subscribes can read the effect's `accepted` (and usually `applied`) before its `abort` response arrives. A host publishes `effect_status` only for sessions it holds; transitions of a session no host holds are not buffered.

### Client information

Clients may send `set_client_info` with `{ sessionId?, width, capabilities? }`. `capabilities` registers the connection's
opt-in client capabilities (see [Client capabilities](#client-capabilities)); a name the host does not know is ignored,
never refused. Registration belongs to the connection that sent it: socket disposal removes it, and clients must
re-register `capabilities` after every reconnect. `width` is accepted for compatibility and has no effect: the host
renders no extension components, so a component factory passed to `setWidget`, `setHeader`, or `setFooter` never
reaches the wire.

In classic `--mode rpc` (one client over stdio), `SENPI_RPC_CLIENT_CAPABILITIES` is the initial set and a
`set_client_info` that carries `capabilities` replaces it, after the `interactive_user` role check; one without
`capabilities` keeps it. Withdrawing `question` settles each pending structured question once as `question_resolved` with
outcome `cancelled`, and withdrawing or declaring `extension_events` stops or starts extension events.

### Session kind and context (`open_session`)

`open_session` accepts two additive, opaque per-session fields. Both are inert inside the host: they never take part in
auth, model, extension or resource resolution, and they are never merged into the host's parsed CLI configuration.

- `kind: "interactive" | "worker"` (default `interactive`) is the session's visibility class. A `worker` session is
  machine-driven work (a task child, a team member): it is omitted from `list_sessions` unless the caller passes
  `include_workers: true`, and its `session_closed` record reaches only the connections attached to it. An `interactive`
  session behaves exactly as before. A value that is neither is refused with `invalid_session_kind` - an unknown kind is
  never downgraded to `interactive`, because that would publish machine-driven work to every client.
- `context: Record<string, string>` (default `{}`) is an opaque label map. The host stores it frozen for the session's
  life, hands it to that session's extensions as `pi.sessionContext`, and republishes it only on
  `list_sessions { include_workers: true }`. Caps, enforced at the boundary: at most 32 keys, every key matching
  `^[a-z][a-z0-9_]*$`, every value at most 16 KiB, and at most 32 KiB of JSON in total. Anything else is refused with
  `invalid_session_context: <detail>`, where the detail names the cap that was broken.

A socket host also stamps its own identity into every session's context, overwriting any client-supplied
value for the same keys, because the host is the authority: `host_socket` is the PUBLIC endpoint clients
address (the supervisor's path for a supervised host, the bound path for a bare one), realpath-canonicalized
through the deepest existing ancestor of its directory (so the first generation of a shard, which starts before
`rpc/shards/` exists, and every successor stamp the same string), and stays the same across a generation handoff; `host_instance` is the answering generation's `instanceId`
(`get_protocol_info`) and changes with every handoff. So an extension can tell which endpoint and generation
it runs behind without an environment variable. `host_socket` is omitted where no public path exists (an
abstract socket, a supervised win32 host); a stdio host adds neither key.

One multi-session host therefore loads ONE extension set and still lets an extension recognize the session it was loaded for
(`pi.sessionKind`, `pi.sessionContext` - see
[ExtensionAPI session identity](extensions.md#pisessionkind--pisessioncontext)). Probe
`session_kind` and `session_context` in `get_protocol_info` capabilities before relying on either: an older host
ignores both fields and lists every session.

Default-invisible worker sessions are invariant **I4** above: a client that does not pass `include_workers: true`
sees the daemon exactly as it saw a host serving only that client.

### Warming a host (`warm`)

A fresh host pays a one-time cost on its FIRST session: the extension module graph compiles, and the extensions'
factories load whatever they load for that session's kind and context (a task engine for a `child` role, for
example). Every later open on that host reuses it. A client that starts one host per session pays it on every session
unless it warms the host first.

#### warm

Loads what the next `open_session` with the same `cwd`, `kind` and `context` needs, without opening a session:

```json
{"id": "w1", "type": "warm", "cwd": "/abs/project", "kind": "worker", "context": {"role": "child"}}
```

```json
{"id": "w1", "type": "response", "command": "warm", "success": true, "data": {"state": "warmed"}}
```

Every field is optional and means what it means on `open_session`: `cwd` defaults to the host's cwd and must be
absolute, and `kind` and `context` are validated with the same caps and refused with the same codes
(`invalid_path`, `invalid_session_kind`, `invalid_session_context`). A socket host stamps its own identity into the
context exactly as it does for an open, so the extensions see what they will see in the real session. The host builds
that session's cwd-bound services - settings, resources, extensions with their factories run for this kind and
context - inside a provider scope of their own, then drops them.

- No session is created: nothing appears in `list_sessions` (with or without `include_workers`), no `AgentSession`
  exists, and no extension receives `session_start`.
- `warm` never attaches its connection, whether or not it carries `observe: true`: a connection that has only sent
  observing reads and warms is an observer, so a host that only received `warm` idles out on its normal deadline
  (`SENPI_RPC_HOST_IDLE_EXIT_MS` under a supervisor, `SENPI_RPC_HOST_EMPTY_EXIT_MS` for the host itself). A warm still
  loading neither holds that window open nor holds a drain.
- It takes no session lock and no open barrier, so it never waits for a live turn and a live turn never waits for
  it. It does share the host's one loop: loading an extension graph is the same work an open does.
- It is idempotent per profile: `data.state` is `warmed` when this call (or a concurrent warm of the same profile it
  joined) did the loading, and `already_warm` when an earlier warm had, in which case nothing runs again. A failed
  load (`warm_failed: <detail>`, for example a `cwd` that does not exist) is not remembered, so it can be retried.
- A host whose sessions run in worker isolates (`--session-runtime worker`) has nothing it can warm from the host
  process: it answers `state: "unsupported"` and does not advertise the capability. A draining generation refuses with
  `host_draining`.

Probe `warm` in `get_protocol_info` capabilities before sending it: an older host answers an unknown command with an
error.

### Prompt surface

Where a session's replies render decides its system prompt. `terminal` is the classic prompt; `app` (a host that
shows replies as chat, such as the OmO Desktop) keeps the same intent routing and stop-condition rules but asks for no
visible `I read this as ...` routing line, and tells the agent that tool and hook feedback (comment-checker findings,
language-server availability, internal notices) is for it to act on, not to report unless it changes the result.
`chat` (a chat bridge that posts each reply to people in a conversation) takes every `app` rule and also drops the
handoff block and todo/ledger lines: the reply is the answer itself, and the todo tool emits no "Handoff due" cue.
As a backstop, the `chat-reply-scrub` builtin removes a leading routing line, a handoff block and todo-ledger lines
from each finalized assistant message on `chat` before it is emitted or persisted; streamed `message_update` deltas are
not rewritten.

A multi-session host decides the surface per session: `open_session.promptSurface: "terminal" | "app" | "chat"` builds that
session's prompt for the named surface, so one host serves a terminal client and an app client at once. An omitted field
uses the host process's `SENPI_PROMPT_SURFACE` (`app` or `chat` selects that surface; unset or any other value is `terminal`),
which remains the only switch for a single-process `--mode rpc` client. A later `open_session` that attaches to a live
session with another `promptSurface` rebuilds that session's prompt; an attach without the field keeps the current
surface, and `new_session` / `switch_session` / `fork` inside the session keep it too, also when the attach lands while
one of them is still building the replacement. Probe `prompt_surface` in
`get_protocol_info` before sending the field; an older host ignores it. Probe `prompt_surface_chat` before sending
`chat`: a host without it refuses `chat` with `invalid_launch_profile`, so a gateway falls back to `app`. Any value other
than `terminal`, `app` or `chat` is refused with `invalid_launch_profile`.

#### Fallback chain per session (`retry_fallback_profile`)

`open_session.retryFallback: { modelFallback: boolean, fallbackChains: Record<string, string[]> }` is the fallback
policy THIS session runs with, e.g. a task child's own chain. It overrides that session's `retry.modelFallback` and
`retry.fallbackChains` in memory only: it is never written to a settings file, and no other session on the host sees
it. A session opened without the field keeps the host's settings. It is applied when the open creates the session; an
attach to a live session keeps the policy that session was created with. Probe `retry_fallback_profile` in
`get_protocol_info` before sending the field. A malformed profile (a missing `modelFallback`, a chain that is not an
array of non-empty selectors, a selector longer than 512 characters, more than 32 chains or 32 entries per chain) is
refused with `invalid_launch_profile` rather than opening a session without the chain its caller asked for; an empty
chain (`[]`) is accepted and means no fallback for that key. If something inside that session later changes a
fallback setting through the settings setters, that write follows the setters' own rules (it persists to the global
settings file) and replaces the session's override for that one key only: a `setFallbackChain` drops the profile's
chains, while `modelFallback` keeps the profile's value. The policy is not stored with the session, so a client that
reopens a session after it was closed sends the profile again.

#### Browser engine per session (`browser_engine`)

`open_session.browserEngine: "connected" | "builtin" | "none"` names the browser THIS session's skills drive: the
user's own browser, the app's in-app browser, or none. It is session-scoped, never process-wide: the session's tool
subprocesses (the bash tool and everything it spawns) and its eval kernels, including their child processes, see
`OMO_BROWSER_ENGINE=<value>`, and no other session on the host does. A session opened without the field sees no such
variable, even when the host process itself exports one (a daemon never inherits it from the process that ensured it).
`BSK_HOME` and `BSK_BIN` are per install, not per session: they pass from the host environment to every session
unchanged. A later `open_session` that attaches to a live session with another `browserEngine` moves that session to
it, and an attach without the field keeps the current engine; `new_session` / `switch_session` / `fork` keep it too,
also when the attach lands while one of them is still building the replacement. Probe `browser_engine` in
`get_protocol_info` before sending the field; the capability is advertised only because the value reaches every
consumer above. Any other value is refused with `invalid_launch_profile`.

A skill that must tell the client what the browser is doing publishes it as that session's own event: an extension
registers a tool that calls `pi.rpc.emit(name, data)`, an eval cell reaches it as `tool.<name>(...)`, and the host adds
the owning `sessionId` to the `extension_event` record. Only clients that advertised `extension_events` receive it.


### Session auto-titling

Auto-generated session titles are on by default only for interactive launches. A multi-session host decides titling per
`open_session`: `auto_title: true` titles that session, `auto_title: false` leaves it untitled, and an omitted field
keeps the host-wide default (`--auto-title-sessions` or the `auto_title_sessions` client capability). Probe
`auto_title_per_session` in `get_protocol_info` before relying on the field; an older host ignores it. A non-boolean is
refused with `invalid_launch_profile`. Sessions resumed with existing context messages are never retitled.

`--auto-title-sessions` still opts every session on that host into titling when `auto_title` is omitted. It is
deprecated for multi-session hosts — prefer per-session `open_session.auto_title` so two clients on one daemon do not collide
over a launch-profile flag:

```bash
senpi --mode rpc --multi-session --auto-title-sessions
```

Startup: `senpi --mode rpc --multi-session` → NO default session is constructed (no default `AgentSessionRuntime`, no default extension/watcher load). Classic `senpi --mode rpc` is unchanged except that `get_protocol_info` is answered and a resolved `extension_ui_response` is acknowledged under its frame `id` (see [Extension UI Responses](#extension-ui-responses-stdin)). Mode is fixed at process start; there is no runtime transition.

### Session replacement

A replacement (`new_session`, `switch_session`, `fork`) responds as soon as the swap is committed; the derived-surface refresh that rebinds extensions continues afterwards. That refresh does not disturb work the client starts against the committed session: tool activation performed while extensions are still binding no longer cancels an in-flight compaction or invalidates its context. `loaded_surfaces_changed` is emitted only when the surface digest actually changes, so it is NOT a settle barrier clients can wait on.

#### Replacement identity event

When `new_session`, `switch_session`, or `fork` swaps the live session - including replacements an extension drives, which a client never issued - every attached connection receives:

```json
{ "type": "session_replaced", "durableSessionId": "…", "sessionFile": "…", "cwd": "…", "sessionName": "…" }
```

The command response reports only `{ cancelled }`, so this event is the only push channel carrying the new identity. The identity is `durableSessionId`, never `sessionId`: top-level `sessionId` is reserved for the per-connection routing handle that multi-session hosts tag every record with, and that tag is applied last, so reusing the key would overwrite the identity the event exists to deliver. Classic mode emits the event untagged.

A replacement first stops the session's running turn. That turn's `agent_end` (`aborted: true`) arrives before `session_replaced` and names the cause, so a client that did not ask for the abort can tell it apart from a failure:

```json
{ "type": "agent_end", "aborted": true, "abortCause": { "kind": "session_replaced", "reason": "new", "targetSessionFile": "…", "targetSessionId": "…" } }
```

`reason` is `new`, `fork` or `resume` (`switch_session`); when present, `targetSessionId` equals the `durableSessionId` of the `session_replaced` that follows. A fork of a session that was never saved gets its new id only after the teardown, so it names no target. The first named cause wins until the `agent_end` it explains: a plain `abort` arriving meanwhile does not erase it. An ordinary `abort`, a `reload` and a shutdown carry no `abortCause`.

### Session lifecycle: unload and reopen

#### unload_session

```
open --(turns)--> idle --unload_session / idle sweep--> unloaded (session_parked) --open_session { sessionPath }--> open
                                                        close_session / release_session --> closed (session_closed, terminal for this handle)
```

`unload_session { sessionId, effectId?, interrupt?, clearQueue?, children?: "refuse" | "detach", force? }` frees a session this host keeps loaded. The transcript stays on disk; queued input stays in the admission ledger and is restored on the reopen (input sent without a `clientMessageId` too) unless `clearQueue`; every attached client receives `session_parked { sessionId, sessionPath, reason: "unloaded" }` (the idle sweep's park says `reason: "idle"`); the session leaves `list_sessions`; `open_session { sessionPath }` reopens it.

The answer is always `success: true` with `data.outcome`: `unloaded` (with `sessionPath`), or `refused` with `reason`, `detail` and `action`, changing nothing:

| `reason` | When | Override |
|---|---|---|
| `turn_active` | an agent run, a prompt about to start, compaction, barrier-held work | `interrupt: true` aborts and waits (bounded) first |
| `work_pending` | bash, an admitted delivery not yet written, another request for the session | `interrupt: true` |
| `extension_work` | extension-published work: background terminal jobs, non-persistent monitors, detached eval cells, a pending question; `detail` names the sources | `force: true` (that work is stopped; only persistent monitors come back on the reopen) |
| `children_live` | child tasks still working, or worker sessions here whose `context` names this session as parent or root | `children: "detach"` leaves them running |
| `attached` | other clients hold the session (none of the caller's own holds count) | `force: true`; they receive the park |
| `host_draining`, `session_closing`, `unsupported` | the host is draining, the session is already closing, or it has no file / a worker isolate owns it | none |

With `effectId` the unload is a ledger effect (`kind: "unload"`): `done` with `disposition: "unloaded"`, or `failed` with `outcome.kind: "refused"` and the same reason; a same-id retry replays. Capability: `unload_session`. CLI: `senpi host session unload <ref> [--interrupt] [--force] [--clear-queue] [--children detach]` (exit 3 on a refusal).

### Multi-session host lifecycle (cold start + idle exit)

The lifecycle supervisor is also available to bundled/rebranded runtimes through the hidden internal launch route `--internal-rpc-host-supervisor`. This route is wire-invisible and intended only for desktop launchers: it receives the public socket, ownership directory, and the runtime command/arguments to wrap, then runs the same `host-lifecycle.ts` implementation used by `ensureHost()`. Normal CLI modes do not use or advertise this route. Compiled standalone binaries also re-enter themselves through this route automatically: a bun executable always boots its embedded entrypoint, so the script-path re-entry used under a JS runtime would be parsed as CLI arguments (`Unknown option: --socket`) and the host could never start.

When a Node.js or Bun caller starts a host, both spawn levels retain runtime options such as loaders and memory limits, but remove eval/print expressions, `--input-type`, and interactive mode from `process.execArgv`. This lets embedding code launched with `node -e` or `bun -e` start the intended host entry instead of replaying itself. Under Bun, any token beginning with `-e` or `-p` is removed as well, because Bun reads it as code glued to the flag (`-eCODE`, `-e=CODE`, `-pCODE`); Node rejects those forms, so single-dash V8 options such as `-expose-gc` are kept there. Explicit child commands keep their supplied arguments.

On win32 the supervisor's internal hop lives under `<daemonDir>/internal-<uuid>`, and that directory is created recursively. Before allocating the internal hop or spawning a child, the supervisor ensures `<publicSocket>.secret` exists, creating its parent directories and a 32-byte secret with mode `0600` when needed. An existing valid secret, including one written by `ensureHost()`, is reused unchanged. Direct launch therefore works on a fresh profile without caller-side secret provisioning. Provisioning failures identify the bootstrap step and secret path; the public endpoint still requires the secret handshake before forwarding RPC traffic.

Hosts started through `ensureHost()` are wrapped by a lifecycle supervisor that owns the public socket and spawns the
real RPC host on a private internal hop. The policy lives in `<daemonDir>/settings.json` (and is copied into
the generation's own directory):

```json
{ "socket": "…/rpc.sock", "capabilities": ["extension_events", "custom_unsupported"], "coldStart": "transient", "idleExitMs": 900000 }
```

- `coldStart` — `transient` (default): the host exists for the current login session and idle-exits. `persistent`:
  no idle exit; the host stays until it is stopped or dies.
- `idleExitMs` — idle-exit window in milliseconds, default `900000` (15 minutes).

Environment overrides beat the file, and invalid values fall through to the next source: `SENPI_RPC_HOST_COLD_START`
(`transient`|`persistent`) and `SENPI_RPC_HOST_IDLE_EXIT_MS` (positive integer milliseconds).

The host exits only after the window elapses with NO attached client connections and NO active turns — continuously.
Any attached connection or agent turn resets the window, so a busy host never exits. A connection attaches with its
first request line, unless that line is an OBSERVING read: a side-effect-free read carrying `"observe": true` -
`get_protocol_info`, `list_sessions`, `subscribe_sessions`, `unsubscribe_sessions`, `get_effect_status`,
`get_pending_inputs`, `get_subscription_limits`, and the session reads `get_state` and `get_entries` (capability
`observe_reads`) - or a `warm` (marked or not - see "Warming a host"). A connection that only ever sends observing reads never counts and never resets the window, so a
poller (`senpi host status [--all]`, which marks both of its reads, a doctor loop, a runtime panel) can look at every
endpoint as often as it likes without keeping any of them alive; the first request that is anything else attaches the
connection from then on, and `observe` on any other command is ignored. While a connection has not sent its first
line yet the host does not exit, and the window keeps running. Hosts that predate the field ignore it, so a marked read
works against every generation. A watcher can therefore read a session's state and history (`get_state`,
`get_entries` with `observe: true`) as often as it likes: the host's attached count stays at 0 and its idle window
keeps running.

A connection from one of the host's OWN sessions is DEPENDENT and never counts either. A host exports its generation
id (`SENPI_RPC_HOST_INSTANCE_ID`) to the sessions it runs, and `RpcClient` sends that id as `"origin_host_instance"`
on every socket request. When a connection's first non-observing request names the host's own generation, the
connection neither holds the window open, nor blocks the owner-death grace, nor keeps an empty host alive. Without
this, a task tree whose children open their own children on the shard they run in (omo's `p` shards are keyed by the
root session) keeps that shard alive through its own connections after the owner and every outside client are gone.
Turns still count as activity, so a dependent session mid-turn keeps the host open until the turn ends. Hosts that
predate the field ignore it. The supervisor learns about turns through
its observer connection to the host; while that connection is unhealthy it cannot see turns, so it treats activity as
unknown and keeps the host open as if a turn were running — but only for one idle window, during which it keeps
reconnecting. An observer that stays unhealthy for longer than the window stops counting as busy, and the connection
count alone decides from there. A `persistent` host has an infinite window and so keeps its infinite benefit of the
doubt. The exit itself is clean: the RPC host
receives SIGTERM first, flushes pending output, removes its socket, and the supervisor then removes `settings.json`,
its generation directory and, last, the registration pointer (`host.pid`); the stderr log stays for diagnostics. The
crash-path cleanup the host runs when its supervisor dies uses the same order, so a missing pointer always means the
teardown is complete. After an idle exit, the next `ensureHost()` transparently
starts a fresh host. `get_protocol_info` over the public socket behaves exactly as before; the supervisor is
wire-transparent.

`ensureHost()` hands its caller an attach hold: the connection its readiness answer arrived on stays open and counts
as an attached client, so the idle window cannot close between the ensure and the caller's own attach, however slow
that attach is. Every caller must call `release()` on the returned `EnsuredHost` once its own client is
attached, or right away when it attaches later on its own connections; the idle window starts from there. Until then
the host counts the calling process as an attached client, so a transient host whose ensuring process is still running
never starts its idle window: a long-lived caller that ensures and never releases keeps the host up for its whole
lifetime. The hold never keeps the calling process alive, and the operating system ends it when that process exits.

On POSIX, the supervisor writes a fresh 32-byte internal key once to its child's stdin and keeps the write end
open. Before the CLI touches `process.stdin`, the child reads exactly that key within a two-second startup budget,
reopens `/dev/fd/0` as a close-on-exec lifetime descriptor, and restores fd 0 to `/dev/null`. Descendants that inherit
stdin therefore receive immediate EOF. A missing or short key refuses startup with `internal_key_unavailable`.

On Linux the supervisor also creates `lifetime.fifo` (mode 0600) in its private 0700 hop directory, holds its only
writer (close-on-exec, opened before the child is spawned), and passes the path in `SENPI_RPC_HOST_LIFETIME_FIFO`. The
host opens the read end non-blocking; EOF, when the kernel closes the last writer at the supervisor's death, ends it. This
is the Linux event binding, because reopening stdin fails there. On macOS libuv reports no EOF for a FIFO, so the
reopened stdin is the event binding. While either is armed, the recorded-identity check is one 30 s backstop.

Where reopening succeeds, Node watches lifetime EOF with an unref'd `net.Socket`; Bun uses a `Bun.file(fd).stream()`
reader that does not hold `process.exit()`. Any reopen failure, including Linux socketpair stdin's `ENXIO`, is logged
and falls back to polling the recorded supervisor `SENPI_RPC_HOST_WATCH_PPID`: a free `kill(pid, 0)` every tick, and
its start compared on one clock per platform, rarely. On Linux that is `SENPI_RPC_HOST_WATCH_PSTART_TICKS`, the
supervisor's `/proc/<pid>/stat` start ticks (internal, not a secret; immune to wall-clock steps, read without spawning);
elsewhere it is the `ps lstart` value in `SENPI_RPC_HOST_WATCH_PSTART`. Only `ESRCH` or an observed start change ends
the host. Missing, unreadable, timed-out or permission-denied identity observations keep it
running. The direct parent is never compared: spawning wrappers may legitimately be between supervisor and host.
Slot 3 is still passed but is not armed for supervised POSIX children because wrappers can close or reuse it.
Windows retains its inherited lifetime pipe. Bare hosts and embedders without supervisor configuration are unaffected.

The POSIX internal hop stays in its per-launch temporary directory and publishes no key file. Proxy, readiness and
activity-observer connections all prove the in-memory key with challenge-response before sending session traffic.
The readiness probe (10 s) and the activity observer (5 s) bound their handshake, so a child that accepts the hop and
never answers fails startup; the proxy forwarding a public connection has no deadline.
The child announces `launch_id: "internal"` and `socket_auth`; neither side sends the key. After authentication,
HKDF-SHA256 derives separate `senpi-rpc-internal c2s` and `senpi-rpc-internal s2c` keys using the two raw nonces as salt.
Each record has a four-byte big-endian ciphertext length (17..65552), AES-256-GCM ciphertext and a 16-byte tag.
The nonce is four zero bytes followed by a big-endian 64-bit direction counter, starting at zero; AAD is the
UTF-8 direction label (`c2s` or `s2c`) followed by that eight-byte counter. A direction closes at 2^32 records.
Plaintext (1..65536 bytes per record) is released only after tag verification. Tampering, replay, reordering,
invalid lengths and incomplete records at EOF close the hop. Complete-record truncation is ordinary transport loss.
JSONL lines span records with backpressure and retain the existing 16 Mi-character ceiling. Windows retains the
secret-file/raw-handshake internal hop.

### Supersession lifecycle: `host_superseded`

Before parking for a generation handoff, the old host sends every connected client one unsolicited record:

```json
{"type":"host_superseded","instanceId":"old-host-uuid","generation":0,"successor":{"socket":"/tmp/agent/rpc.sock"}}
```

`instanceId` and `generation` identify the OLD host, matching its `get_protocol_info` response. `successor.socket`
identifies the public socket, never the supervisor's private hop. `successor` is `null` when a drain is requested
without a known replacement. This record has no request id or session handle; older clients can ignore it.

1. The announcement is queued on every connection before handoff parking changes any session.
2. Every parkable session, attached or unattached, is parked immediately. A session is **parkable** when no agent
   run, bash/tool execution, compaction, queued session work, or in-flight host request remains. Accepted opens,
   binding creation, close requests, and steer delivery must finish. This is the ordinary busy predicate with
   **durable wake-source holds excluded**: persistent monitors, scheduled continuations and goal-loop holds do not
   pin an old generation. They resume from the persisted session when reopened, as after a restart. Ordinary idle
   eviction retains its broader activity predicate, including all wake sources.
3. Active sessions keep serving their existing connections and park when their turns and requests settle. Each
   released handle emits `session_closed { sessionId, reason: "handoff_parked", sessionPath }` after releasing its
   file. This is not a session deletion: reopen `sessionPath` on the successor to obtain a new routing handle.
   That `sessionPath` is the CANONICAL path the host reserved the file under, which is not necessarily the string
   the client passed to `open_session` (a scratch dir under `/var/...` on macOS is reported as `/private/var/...`).
   A client matching the record against its own stored path must canonicalize before comparing; reopening with
   either spelling resolves to the same reservation.
   The connection closes after its last attached session parks; a connection shared with another active session
   stays open until that session also settles. A command racing parking on the old connection is either served
   or answered by that terminal record and close, never `unknown_session` for the parked handle. New opens on a
   draining supervised connection are refused with `host_stopping`; a bare (unsupervised) socket host
   still returns `host_draining`. Re-resolve the public endpoint rather than retrying the draining connection.
4. The **supervisor** starts `SENPI_RPC_HANDOFF_GRACE_MS` at supersession (default **600000 ms / 10 minutes**).
   This is a soft grace, not an abort deadline or a delay before parking. At expiry it reports outstanding work
   and requests another drain pass. Sessions still mid-turn or handling requests remain alive even beyond grace;
   no turn is cut short. Parkable sessions never wait for grace. A bare socket host has no supervisor grace timer,
   but follows the same announce/park/settle sequence.
5. Once every session has parked and its terminal records have drained, the generation exits even if an observer
   or client never voluntarily disconnects. Neither the normal idle timeout nor persistent-host mode can pin it.

A client may react to `host_superseded` early, but the old generation retains each file until its work settles;
`session_path_in_use` on the successor remains a retryable response until parking releases that claim. A client
that ignores the announcement still receives the terminal record and connection close.

### Multi-session host occupancy (idle eviction, retention, empty-host exit)

**The daemon does not cap sessions.** On the in-process runtime - the default for a `--listen` socket host, i.e. the
shared daemon clients attach to - there is no session limit, no admission counter, and no eviction of a live session
to make room for another: capacity is memory, and `open_session` is never refused for occupancy. `too_many_sessions`
exists only on the worker runtime described below. On that runtime every session owns a worker isolate and a complete
runtime; on the in-process runtime each session is a runtime in the host process. Memory depends on a session's
extensions and contents; neither runtime provides process-fatal OOM containment.

Closing a session on the in-process runtime also closes what that session's extension instances left open. After the
extensions' `session_shutdown` handlers run, senpi closes every server (`Bun.serve`, `Bun.listen`, `node:net` and
`node:http` servers), `node:net` client socket and timer that an extension's own code created during the session and
has not released, and writes one stderr line per extension naming what it closed. Memory those handles kept reachable
is then collectable. Senpi's own builtin extensions and inline SDK factories are not tracked, and neither is work senpi itself does on an
extension's behalf (a turn the extension started, a UI notification it showed). See
[extensions.md](extensions.md#session_shutdown) for what this means for an extension that shares one server across
sessions.

What the host does enforce are lifecycle windows, and they only ever return memory from work nobody is doing:

- **Idle eviction**: a session with no activity-refreshing command and no session-owned work for
  `SENPI_RPC_SESSION_IDLE_EVICTION_MS` (default 30 minutes) is closed through the exact `close_session` sequence
  (abort → waitForIdle → dispose, all attachments drained, path reservation released) and every attached connection
  receives that handle's `session_closed { reason: "idle_evicted" }` broadcast plus a final `close_session` response
  record. A session opened with
  `retain_on_disconnect` is PARKED by that same sweep instead: identical teardown, but the terminal record is
  `session_parked { sessionId, sessionPath }` and there is no `close_session` response, because nothing closed the session -
  the routing handle was released while the session itself stays on disk and reopens with `open_session { sessionPath }`
  (as a NEW handle). A client that does not know `session_parked` ignores it and learns the handle is gone from its next
  command's `unknown_session`. A GENERATION HANDOFF also parks attached sessions, using the distinct activity
  predicate below, and emits `session_closed { sessionId, reason: "handoff_parked", sessionPath }`, so a client can tell "the host handed
  over, reopen by path" from "this session ended". An explicit `close_session` is `reason: "client_close"`; the host
  process exiting is `reason: "host_shutdown"` (even for a retained session - the process is going away, so this is not
  a park). `reason` is optional on the wire; a client that does not know a
  value, or receives a record with no `reason` field, treats the record exactly as a reason-less one. "Session-owned
  work" is the complete activity contract, not just a streaming turn: an agent run, a running bash command,
  background terminal jobs and any other published wake source (terminal monitors, loop-guard holds), compaction,
  and barrier-held session work all defer eviction, and the idle clock restarts when that work settles. An evicted
  session resumes like any other: the next `open_session` with the same `sessionPath` reopens it.
- **Observational reads**: session state, history, model/auth inventory, loaded surfaces, and `memory_report`
  do not restart the idle clock of a **detached** session in either runtime. With any client still attached,
  these reads keep refreshing activity as before: an attached client polling `get_state` keeps the same live
  routing handle and runtime. An attached session receiving no commands can still idle-evict as before.
  Commands that change the session restart the clock even when detached. An in-flight request or prompt
  preflight prevents ordinary idle parking while the request is running; directory-removal teardown is separate.
- **Completed detached workers**: on the in-process runtime, a retained `kind: "worker"` session with zero
  attachments is parked on the next occupancy sweep once its transcript is flushed and it has no session-owned
  work, queued input, admitted unwritten delivery, pending prompt, or in-flight request - provided the disconnect
  has already stood for at least five seconds (a short grace age, so a transient reconnect keeps the live runtime
  instead of re-opening cold). It does not wait out the normal idle window. This releases its runtime and eval
  kernels, not its durable history: reopen its
  `sessionPath` to continue under a new routing handle. Active monitors and other wake sources still prevent
  early parking. Unflushed workers, worker-isolate runtimes, and interactive sessions keep their normal window.
  A zero-attachment worker without a recorded disconnect time also keeps its normal idle deadline.
- **Worker capacity** (worker runtime ONLY - a stdio host, `--listen stdio://`, an embedder, or a socket host that
  passed `--session-runtime worker` explicitly): at most 20 workers may be preparing, open, closing, or quarantined
  together, because each one is an isolate the host must keep alive. Admission beyond this bound fails explicitly
  with `open_failed: too_many_sessions`; it never evicts another session or starts an OS process as a fallback. It
  applies to new worker allocation, not attachments: a known canonical path or original opening spelling joins its
  already-bound owner without allocating a worker, even at capacity. An unknown path/alias still needs a preparation
  worker slot. In-process SDK registries using an injected runtime factory retain their existing behavior. A socket
  host on its default runtime never reaches this bound and never answers `too_many_sessions` - there is nothing to
  raise, tune, or shard.
- **Retained sessions**: a session opened with `open_session { retain_on_disconnect: true }` treats a client's
  disconnect as a DETACH, not a close. The dropped connection's attachment is released immediately (no waiting for a
  streaming turn, since nothing is being torn down), the entry stays `open` with `attachments: 0`, keeps running any
  in-flight turn to settlement, keeps its path reservation and worker slot, and stays in `list_sessions`. A later
  `open_session` with that `sessionPath` — from any connection — attaches to the same routing handle and returns
  `attached: true`. Retention never outranks an explicit teardown: a `close_session` from an attached connection still
  reaches zero attachments and closes the session, host shutdown closes it, and the idle-eviction window above still
  parks it (or the completed-detached-worker rule above parks it sooner) — announced as
  `session_parked { sessionId, sessionPath }`, after which the file reopens by path like any
  evicted session, and the parked session counts as gone for the empty-host exit below. The park is also recorded
  for the NEXT generation, which reopens it on startup; the host that parked it never reopens it on its own, so a
  client reopening the session right after `session_parked` is the only open of that path (senpi#3485). It is also bounded by the empty-host exit
  and the supervisor's idle-exit window below: retention survives a client, not the host. Any attach may turn retention
  on for a live session; no attach turns it off for clients that already rely on it. Omitting the flag is byte-identical
  to the previous behavior — the session is closed with its last connection. Probe `retain_on_disconnect` in
  `get_protocol_info` capabilities before relying on it: an older host silently ignores the field.
- **Empty-host exit**: when the registry holds zero sessions AND no client is connected, continuously for
  `SENPI_RPC_HOST_EMPTY_EXIT_MS` (default 15 minutes), the host exits through its clean shutdown path (flush, socket
  removal), for stdio and `--listen` hosts alike. A connected client counts as occupancy even with no session open,
  so the host never drops a live socket under itself - except a connection whose every request so far was an
  observing read (`"observe": true`, the same rule as the idle-exit window above) or a `warm`, which never holds the host open.
  A connection that has not sent its first request yet still counts. Supervised hosts stay clean either way: a supervisor reads a
  child exit of 0 without a signal as an intentional idle stop and exits 0 with the same cleanup, not as a crash.

Values are positive integers; invalid values fall through to the defaults. These lifecycle windows run inside the host process,
so they hold even for embedders and hand-started hosts that have no supervisor.

### Interactive sessions expose a control endpoint

An interactive terminal session is its own process with its own local session; nothing joins it to a host. Another
local session reaches it only through a control endpoint, and only when an extension of that terminal registers
one with `pi.session.registerControlEndpoint({ inboxDir, drain, isSessionReferenced? })` (see
[pi.session](extensions.md#pisession)). OmO's thread component registers one at startup; a plain `senpi` with no
registrant opens no socket and writes no registry directory.

- **Platform.** Every platform. On win32 the socket path below is the endpoint's logical address: the secret is
  written beside it, and the listener binds the named pipe the host transport derives from the path and the secret
  (`\\.\pipe\senpi-rpc-<32hex>`), the address every client already connects to after reading the secret. It is
  registered and listed like a POSIX terminal. On a multi-session host the
  same call binds nothing - the host's public socket is the endpoint - see "Waking a host session (`wake`)".
- **Socket and auth.** The endpoint listens on `<agentDir>/rpc/tui/t-<16hex>.sock` (16 hex of the SHA-256 of a
  fresh instance id). When that path is longer than a Unix socket path allows, it moves to
  `/tmp/senpi-rpc-<8hex>/tui/`, which must be a private directory of this user. The directory is 0700 and the
  socket 0600. A 32-byte secret is written 0600 beside the socket, and every connection must send it first, the
  TUI-specific handshake; public RPC hosts use [challenge-response](#authentication). A wrong TUI secret
  is disconnected before a line is read. After that it is
  ordinary RPC framing: one LF-terminated JSON object per request, one response carrying its `id`.
- **Registration order.** Registering first writes the session header (so the session id is durable), reaps dead
  `tui` endpoints (`senpi host gc` scoped to `kinds: ["tui"]`), binds the socket and only then writes the
  registry directory under the ensure lock, generation record before `endpoint.json`. A listed endpoint is one
  that answers; a failed step undoes the earlier ones and answers `{ status: "failed", reason }`.
- **`endpoint_kind`.** The registry record is `{ layout: 2, registry_version: 1, endpoint_kind: "tui", socket,
  created_at }` (see "Daemon state directory (layout 2)"). `senpi host status --all` lists the terminal with
  `endpoint_kind: "tui"`, `owner` and `alive`, probing it for at most 1.5 s. `senpi host gc` reaps a dead one on
  the same evidence as a host. `ensure`, `handoff` and `stop` refuse it with `unsupported_endpoint_kind` (exit 3)
  before connecting, because a terminal endpoint is owned by its terminal process.
- **Commands.** Anything not listed below is answered `unsupported` as data. No command opens another session or
  runs a command; input goes through the terminal's admission (`steer`/`follow_up`/`prompt` below), so the
  user's draft still holds it.
  - `get_protocol_info`: `mode: "tui"`, `endpoint_kind: "tui"`, `capabilities: ["tui_control", "session_status",
    "tui_observer", "observe_reads", "entries_tail"]` (`tui_observer`: the observe-and-drive set below), `generation: 0`, the endpoint's
    `instanceId`, and `commands`: every command this endpoint accepts. A terminal from before the session
    controls below lists no `commands`.
  - `list_sessions`: exactly one row, `kind: "interactive"`, `surface: "tui"`, `attachments: 1`.
  - `get_state`: the RPC session state plus `turn_epoch`, `blocking_question`, `compacting`,
    `editor_has_draft` and `state_version`.
  - `get_messages`.
  - `get_entries { since?, before?, limit?, tail?, maxBytes? }`: the host's answer, pages and tail pages included
    (see `get_entries`).
  - `set_session_name { name }`: a blank name is refused.
  - `subscribe { cursor? }`: a feed of `session_control_event { seq, kind, data }` records, where `kind` is
    `state`, `report` (an assistant message's text), `question` (pending question ids) or `completion` (the
    session went idle, with `turn_epoch`). Resubscribing with the last `seq` replays what the 256-record ring
    still holds after it.
  - `open_session { sessionPath }` (or `{ sessionId }`) naming this terminal's session attaches the connection, as
    on a host: the answer is `{ sessionId, state, attached: true }`, preceded by the replay of the in-flight
    message and pending questions, then the session's records (`message_update`, `agent_end`, ...) in the
    host's projection. A path or id of any other session is refused `terminal_single_session`; a terminal hosts
    one session. Detaching is closing the connection; neither changes the terminal.
  - `subscribe_sessions` / `unsubscribe_sessions`: the host's status stream over this one session
    (`session_status`, `effect_status`, the same `mirror` opt-in for content to a client that never attached).
    `attachments` counts the terminal plus each attached client; a subscriber, mirrored or not, is not one.
  - `steer`/`follow_up { message, whenIdle?, clientMessageId?, expected_turn_id? }` and
    `prompt { message, streamingBehavior? }`: delivered through the terminal's admission
    (`admitExternalMessage`), so the user's draft holds them, with the host's `whenIdle` choice (`queue`, the
    default, holds input on an idle session for its next turn; `start` starts one; `prompt` always starts). A
    steer that names no `expected_turn_id` steers the current turn. The answer's `disposition` is `started` or
    `queued`; `held_draft` (the user is composing) and `turn_conflict` are refusals with a reason and an action.
    Unlike a host's input, the message lands as a remote delivery (a `session_control_delivery` entry the
    terminal renders as "remote message"), not a user message: there are no prompt templates, slash commands or
    skills. Input sent with a `clientMessageId` is answered with an admission receipt,
    `admission { clientMessageId, durableSessionId, disposition }`; a retry with the same id and the same input is
    answered from it, with `replayed: true` (and `duplicate: true`) and the original `disposition`, and delivers
    nothing; the same id with different input is refused `client_message_id_conflict`. Frames carrying
    `images`, `thinkingLevel`, `expandPromptTemplates`, `unknownCommandAsText`, `sessionTitlePrompt` or
    `enqueueOrder` are refused `unsupported_field`, naming them.
  - `get_effect_status { effectId, sessionPath? }`: the same effect ledger as a host.
  - `set_client_info { width, capabilities? }`: declares the connection's roles (`interactive_user`,
    `task_parent`), fixed once declared (`connection_role_fixed`), as on a host.
  - `attach_session { sessionId, durableSessionId, expectedHostInstance? }`: a live attachment, as on a host:
    `sessionId` is the terminal's session id from `list_sessions`, `durableSessionId` the same id, and
    `expectedHostInstance`, when sent, this endpoint's `instanceId`. Answers `{ sessionId, attached: true }` after the
    replay of the in-flight snapshot, then the session's records follow; another session is `unknown_session`, an
    identity that does not match is `session_identity_mismatch`.
  - `release_attachment { sessionId }`: drops this connection's attachment, answered `{ deferred: false }`;
    `session_not_attached` when it holds none.
  - `abort { intent?, effectId?, awaitIdle?, clearQueue?, graceMs? }`: the host's `abort` and effect receipts.
    `intent: "stop"` is refused `stop_requires_interactive_client: declare interactive_user with set_client_info first`
    until the connection declared `interactive_user`.
  - `wake { delivery_ids? }`: one drain pass, answered `{ admitted: [{ delivery_id, kind }] }`.
  - `extension_ui_response`: answers only a question this session asked and still waits on
    (`unknown_request` / `question_incomplete` / `invalid_response` otherwise). `uiRequestId` names the
    question (a pending question id from the `question` feed); without it, `id` does. The answer settles by
    the host's rule (see `question`) and the reply carries the frame's `id`, as on a host (see "Extension
    UI Responses").
  - The session controls run the pane's own paths, so validation, the footer and persistence are the ones the
    user gets doing it in that terminal:
    - `get_available_models` and `get_available_thinking_levels`: the same answers as a host's.
    - `set_model { provider, modelId }`: the `/model` switch (the footer and the pane's status line). It applies
      to that session only: the default model new sessions start on is left alone, and the `model_change` entry
      records `source: "control"`. An unknown model is refused `Model not found: <provider>/<modelId>`; a switch the
      session refuses answers its reason. Success answers the model, as on a host.
    - `set_thinking_level { level, scope? }`: the thinking-level selector. `scope: "turn"` sets this session's
      level; otherwise the level is also remembered for the model (the selector's Ctrl+S). A level the active
      model cannot run is refused `Thinking level <level> is not supported by the active model.` and nothing
      changes, for either scope. A host refuses it only for `scope: "turn"`; for the default scope a host clamps it
      to a level the model runs.
    - `interrupt { turnId? }`: Esc on a running turn - queued input returns to the editor, the turn aborts and
      settles before the answer. Answers `{ interrupted: true, turnId }` with the `turn_epoch` it stopped. An idle
      session answers `{ interrupted: false }`; a `turnId` that is not the running turn answers
      `{ interrupted: false, turnId }` with the running one and leaves it alone. The session stays open.
- **Admission.** A message from another session enters only through the registrant's drain, which calls
  `pi.session.admitExternalMessage({ delivery_id, text, deliverAs, expected_turn_id? })`. One synchronous call
  decides and acts:
  - `started`: the session was idle, and the delivery starts a turn.
  - `queued`: the session is mid-turn and `deliverAs: "followUp"`; the delivery goes on the follow-up queue once.
  - `steered`: the session is mid-turn, the steer names the current `turn_epoch`, and it goes on the steering
    queue once.
  - `turn_conflict`: the epoch is stale, or a steer names none.
  - `held_draft`: the user is composing, or their submitted input has not reached the runtime yet (a buffered
    submission, a command that may still submit text). Nothing is enqueued; retry on the next wake.
  - `already_admitted`: this process already holds or already wrote that `delivery_id`, or the session file refused
    its entry and it is not admissible again yet (see `failed` below).

  The delivery becomes a `custom` transcript entry, `customType: "session_control_delivery"`, whose `details`
  carry the `delivery_id`. `listAdmittedDeliveries()` reports `pending` (held by the runtime) and `emitted`
  (entry written) for the life of the process. When the session file refuses a delivery's entry (`EACCES`,
  `ENOSPC`), the delivery is settled as `failed: [{ delivery_id, error }]` (listed only while non-empty): it is no
  longer held, so it blocks no later delivery and no release, and it stays with its sender. It becomes admissible
  again once the run that refused it has settled and the file's last write succeeded: the redelivery then starts or
  joins a later run, whose start drops the refused copy from the model context (so the model holds it once, as the
  file does), and it never loops against a file that still refuses writes.
- **Wake.** The drain runs on edges only, never on a timer, as the extension event `session_control_wake`. The
  edges are: the session went idle (`idle`), the user's last submission reached the runtime (`submission`),
  the editor was cleared without a submission (`draft_cleared`), a `wake` command (`command`), an entry created
  or deleted in `inboxDir` (`inbox`), an admitted delivery reaching the transcript (`emitted`), and the
  terminal continuing after a stop (`continue`). One pass runs at a time; edges that arrive during a pass merge
  into exactly one more pass. A first `inbox` pass runs right after registration.
- **Exit.** A clean exit unregisters the endpoint. A session whose file holds only its header is deleted, unless
  `isSessionReferenced()` answers `true`.

A session that lives on a multi-session host is taken over by a terminal with `release_session` (see "Handing a
session over (`release_session`)"); a terminal's own session is never handed over through its endpoint.

### Endpoint kinds: hosts and terminals

An agent directory's endpoint registry (`rpc-host-daemon/<16hex>/endpoint.json`) names two kinds of endpoint.
`rpc_host` is a multi-session host, everything in this section. `tui` is ONE interactive terminal whose extension
registered a control endpoint (see "Interactive sessions expose a control endpoint" above). Both kinds appear in
`senpi host status --all` and are reaped by `senpi host gc` on the same evidence; only a host is ever ensured,
handed off, drained or stopped (see "The `senpi host` command").

### Waking a host session (`wake`)

`wake { sessionId, delivery_ids? }` is session-scoped like `prompt`, and has the contract of a terminal endpoint's
`wake`, so a sender wakes every recipient kind with one command. An extension on a host session registers the
same way it does in a terminal - `pi.session.registerControlEndpoint({ inboxDir, drain })` - and on a host that
registration binds nothing: the host's public socket is the endpoint (`registered.socket` is its `host_socket`).
The drain then runs on the session's `session_control_wake` edges - `agent_idle`, an admitted delivery reaching
the transcript, an entry created or deleted in `inboxDir`, and this command - one pass at a time, edges that
arrive during a pass coalescing into one more. `wake` answers `{ admitted: [{ delivery_id, kind }] }`, the outcome
of the pass that covered it (`delivery_ids` appear on that pass's event). With no drain registered it still
emits `session_control_wake` into the session's extensions and answers `{ admitted: [] }`. A host without a
public socket (stdio) answers a registration `{ status: "unsupported", reason: "unsupported_mode" }`: nothing
outside its parent could reach it. `pi.session.admitExternalMessage` and `listAdmittedDeliveries` work on host
sessions exactly as in a terminal.

### Handing a session over (`release_session`)

`release_session { sessionId, reason: "takeover", interrupt?, force? }` hands a session to a runtime outside the
host - `omo daemon adopt` resumes it in a local terminal with `senpi --session <session_path>` (a path; `--resume`
is the picker). It is a teardown, not a transfer: nothing is replayed. The host appends one `custom` entry
`session_released` (`{ reason, interrupted, attachments, host_instance, released_at }`, a bookkeeping entry the
model never sees) to the transcript - writing the header first if the file was still buffered - then drains
every attachment, disposes the runtime, releases the path reservation (in-process and the cross-generation claim
in `reservations/`) and answers `{ released: true, session_path, attachments, dropped }`. From then on `list_sessions`
no longer lists it and the handle answers `unknown_session`.

- It hands over only a QUIET session: no agent run, no `prompt` still in preflight (its command already answered,
  its run not started), no queued user steer/follow-up (`queued`: still owed a turn even after the stream it was
  aimed at ended), no admitted delivery not yet written, no bash, compaction or barrier-held session work
  (the fields the handoff park judges by), and no other request for that session in flight on any connection.
  Otherwise it is refused, changing nothing: `turn_active` when a turn is running or about to start (`busy`
  contains `turn`, `prompt`, `queued` or `delivery`), `session_busy` for other work (`bash`, `compaction`, `session_work`,
  `activity`, `request`); `errorData { attachments, busy: [...] }` names every signal. The refused work runs to
  its end on the host, which keeps the path.
- With `interrupt: true` a busy session first has its queues emptied, then its run and any bash aborted (a turn
  that a pending prompt starts meanwhile is aborted too), and external admission closed; the release waits up to
  10 s for the run to go idle, for the other requests and prompts to settle - the cancelled bash is recorded then,
  before the release - and checks again. Still busy answers the same refusal with `errorData.interrupted: true`
  and `errorData.dropped`; otherwise the entry records `interrupted: true`. Every refusal after the interrupt
  (still busy, `attached` because a client attached while it waited, `unknown_session`, `session_closing`)
  reopens admission on the session the host keeps and carries `interrupted: true` and `dropped` in `errorData`,
  since the queues were already emptied.
- A refusal whose `busy` names `queued` also carries `errorData.retry_with: { interrupt: true }` and a `hint`:
  queued user input is owed a turn even when none is running (an aborted run leaves it queued), and only an
  interrupt release takes it out and hands it back in `dropped.user_messages`.
- Nothing queued vanishes silently. `dropped: { deliveries, user_messages }` (always present; empty without
  `interrupt`) lists what the interrupt took out of the queues: `deliveries` are the ids of admitted deliveries
  that were never written - they are no longer in the session's ledger and not on disk, so their sender delivers
  them again to the next owner - and `user_messages` is the user's queued steer and follow-up text in enqueue
  order. The host only hands them back; what the adopting client does with them is its own decision (for example,
  resubmit them in order as queued prompts).
- The final check, closing external admission and the close claim run in one synchronous step: a command for the
  session routed after it finds the session closing (`session_closing`); a drain pass still running admits
  nothing more (`pi.session.admitExternalMessage` throws, the delivery stays with its sender); and work started
  before it is seen by the check. Nothing is written to the file after `session_released`.
- A session whose file was never written first waits for its header write, before that final check, so the
  `session_released` entry has a file to land in. A prompt or delivery routed right after such a release is not
  answered `session_closing`: either its whole turn runs and lands before `session_released`, or it is still
  running at the final check, which then answers `turn_active`. A header write that fails answers `release_failed`
  with `errorData.detail`, and the session stays hosted. A session whose file exists awaits nothing here.
- It refuses while another client is attached (e.g. a second Desktop window): `attached` with
  `errorData { attachments }`, counting only OTHER connections' holds. The caller's own holds, including repeated
  attaches, do not require `force` (capability `release_caller_aware`): a client attached to the session it
  releases is drained with it. With `force: true` the other clients receive
  `session_closed { sessionId, reason: "released", sessionPath }`, which tells them the file is now written
  elsewhere and must NOT be reopened on this host.
- A draining host answers `host_draining`; a worker-isolate session or one with no file answers
  `release_unsupported`.
- A hand-over that fails after it began - the header or the `session_released` entry cannot be written
  (`EACCES`, `ENOSPC`, a removed directory), or the teardown throws - answers `release_failed` with
  `errorData { detail }` (the error message), plus `interrupted: true` and `dropped` after an interrupt. When
  the entry could not be written the session stays on this host as it was: admission reopened, no
  `session_released` entry on disk or in memory, and a later release can be retried. A teardown that fails
  after it claimed the session leaves it closing.

A release with `reason: "move"` (and a `moveId`) seals the session for a move to another device: its `session_released` entry records `move_id`, `target` and `session_id`, and from then on any write to the file is refused with `session_moved_away` until that same move is reclaimed. A later `takeover` release, or any ownership entry for another move, is refused too. A `move` without a `moveId`, or with one that is not a plain id (a letter or digit first, then letters, digits, `.`, `_` or `-`, at most 128 characters), is refused with `invalid_release_reason`, and a session whose own id is not a plain id is refused with `release_unsupported` (`errorData.detail: "session_id_not_plain"`) before anything is interrupted or sealed. A `session_moved_away` refusal after an `interrupt` carries `interrupted` and `dropped` like any other refusal after one. Before the seal, a `move` release runs the extensions' `session_move_export` handlers, each under the `session_shutdown` handler budget (`sessionShutdownHandlerTimeoutMs`); a handler that throws or is still running at the cap fails the release with `release_failed` (nothing sealed, admission open again). Each `move` release attempt stages into its own folder and its `session_released` entry records that attempt (`state_attempt`); `move_session export` bundles only the sealing attempt's state, so a handler still running from an earlier, failed attempt of the same move never feeds the bundle. A release refused after those handlers ran and before its seal is written removes its own attempt's folder; one refused after the seal (for example `session_closing`) keeps it, since the seal names it.

### Moving a session to another device (`move_session`)

A move hands a session to another host under the same id (capability `move_session`). The transport between the two hosts only carries the bundle folder and the receiver's answers; every decision about the session file is taken by `move_session`. Each host keeps its move folders under `<agentDir>/session-moves`.

| `op` | Side | Fields | `data` |
|---|---|---|---|
| `prepare` | receiver | `moveId` | `{ state: "ready", expires_at }` (or `receiving` / `accepted` if it already is); the move must see its bundle within 10 minutes |
| `cancel` | receiver | `moveId` | the record: `declined` with reason `cancelled`, unless already `receiving` or `accepted` |
| `export` | sender | `sessionPath`, `moveId`, `target`, `droppedUserMessages?` | `{ move_id, session_id, bundle_dir, files }`; `bundle_dir` is the folder to send, kept until `finish` |
| `import` | receiver | `bundleDir`, `cwd` (both absolute), `from?` | `{ session_id, session_path }`; the session lands in this host's session folder for `cwd`. A move lands in one file only: see below |
| `status` | receiver | `moveId`, `sessionPath?` | the answer for the sender: `receiving`, `accepted`, or `declined` / `failed` with `reason`; an unknown move is recorded `declined` (`no_record`) before the answer. `accepted` carries `revoked: true` once the import was revoked, with or without `sessionPath`; `revoked: true` wins over `accepted` for writability: that copy refuses every write (`session_moved_away`). A `sessionPath` whose file is not this move's import is refused with `move_mismatch` |
| `finish` | sender | `sessionPath`, `moveId`, `answer` (the `status` data, `revoked` included) | `{ ownership: "moved" \| "writable" \| "moving" }`; an answer with `revoked: true` takes the session back (`writable`), and is refused with `move_already_moved` if the file was already marked moved |
| `revoke` | receiver | `sessionPath` (the imported copy), `moveId` | `{ ownership: "moved" }`; capability `move_session_revoke` |

A move lands in one file only. The first `import` that starts receiving a move records the session file it lands as; from then on, while the move is receiving or accepted, an `import` for any other folder is refused with `move_fenced` before anything is written, so two imports at once, or an import after a crash lost the `accepted` record, never land a second copy. The rename itself also runs only into that recorded file. Importing again into the same file returns it unchanged when it is there (a landed file whose `accepted` record a crash lost is accepted then). A move lands once: if the landed copy was deleted, the copy is gone, and an `import` for the move is refused with `move_fenced` whether or not it was revoked (copy the session to a new thread to keep working). A move an older version started receiving, whose record names no landing file, accepts only the file it already landed (an `import` into that same folder); an `import` into any other folder is refused with `move_fenced`.

An interrupted step never leaves two writable copies, and the record always ends up agreeing with the files. Before the import renames the session into place, the record is stamped `committing`, so a crash or a failure on either side of the rename never lets the move land again: a failure after the rename never records `failed` beside the landed copy. `status` then settles the move from the file at the recorded landing target. If this move's file is there, the move is `accepted` (with `revoked: true` if it is sealed); if no file is there, the move is `failed`, and the sender takes the session back. A same-file `import` confirms a landed file the same way and keeps its revoke mark, and `status` also restores a revoke mark a crash lost after the copy was sealed. A repeated `finish` re-queues the dropped input once and removes the bundle.

`revoke` seals the copy this host imported for a move after the sender took the session back, so two writable copies never exist. It appends `session_moved` with `reason: "revoked"` (and `target` set to the import's `from`), and from then on any write to the copy is refused with `session_moved_away`. It runs under the same move lock as `export` and `finish` (`session_held`, `session_open_here`). Only a file whose latest ownership entry is this move's `session_moved_in` is revoked; a repeat for the same move changes nothing and answers the same, and any other file (another move's import, the sender's released copy, a session that was never imported) is refused with `move_mismatch`. A client checks for the `move_session_revoke` capability before relying on it.

A copy the receiver already used is still revoked: entries written to it after the import (turns typed on this host) are kept, and the copy becomes read-only for good, so the client offers "Copy to a new thread" to keep working from it. Refusing would leave two writable copies of one session.

The receiver's record of the move stays `accepted` after a revoke; that state is final. Under the same move lock, after the copy is sealed, `revoke` adds `revoked: true` to that record, so `status` reports the revoke with or without `sessionPath`, and the engine's write guard refuses every write to the copy whatever the record says. A crash between the seal and the record write leaves the record plain `accepted` until the revoke is repeated (a repeat writes it again); meanwhile `status` with the copy's `sessionPath` still answers `revoked: true`, read from the file. With `sessionPath`, the file is read in this host's queue for that session file, so a `status` racing a `revoke` in this host answers after it; across processes it may answer just before it, and asking again settles it. A `sessionPath` whose file exists but is not this move's import (another session, a mistyped path) is refused with `move_mismatch`; a path with no file answers from the record. `finish` treats an answer that carries `revoked: true` as a take-back, never as a move: the receiver's copy is sealed, so the sender's copy must be the one writable copy. A sender still sealed for the move reclaims it exactly as for `declined` (`session_reclaimed` with `reason: "revoked"`, queued input back, under the move lock); a sender that already took the session back is left as it is, and a repeat changes nothing. A sender already marked moved by an earlier plain `accepted` answer cannot be taken back: that `finish` is refused with `move_already_moved` and changes nothing, since neither copy is writable any more; the client offers "Copy to a new thread".

To take a session back, the sender's client first sends `cancel` to the receiver, which fences a move whose import has not landed (a later `import` is refused with `move_fenced`), then sends `revoke` if the import already landed (`cancel` answers `accepted`). A `cancel` that answers `receiving` met an import in flight; the client asks `status` until it settles and revokes if it is `accepted`. A `revoke` alone does not fence a pending move: before the import it is refused with `move_mismatch`, and a late import would still land a writable copy. A client whose `revoke` did not succeed (an error, a timeout, a lost connection) repeats it before acting on any `status`: a revoke that sealed the copy but crashed before marking the record leaves the record plain `accepted`, and the repeat writes the mark again.

`export` and `finish` run one at a time per session file, so two `finish` calls for one move settle it once and hand the queued input back once. This holds across processes too: each step takes the session's move lock, refuses a session any live process holds (`session_held`, for example another host generation on the same agent directory) and makes a concurrent open of that session wait or refuse. Inside the lock, both first refuse a session this host has open (compared after resolving `.`, `..` and symlinks).

The order is: the receiver `prepare`s; the sender releases the session with `release_session` reason `move` (usually with `interrupt: true`) and passes its `dropped.user_messages` to `export`; the transport carries `bundle_dir` to the receiver, which `import`s it; the sender asks `status` (on start, on reconnect, and when the session is opened) and `finish`es with the answer. `accepted` leaves the sender's copy read-only for good; `declined`, `failed`, or `accepted` with `revoked: true` makes it writable again with its queued input back. `receiving` changes nothing.

Refusals carry `errorData.detail` (the reason and what to do): `invalid_move_request` (a field does not parse), `session_open_here` (export or finish of a session this host has open), `move_not_released` (export of a file not sealed for that move), `move_fenced` (a move already answered, or a bundle for a move the receiver never readied), `move_bundle_invalid`, `move_repository_mismatch` (`cwd` is not a checkout of the same repository), `move_target_occupied`, `move_mismatch`, `move_already_moved` (a revoked answer for a sender already marked moved), `session_moved_away`, `session_held`, and `move_failed` for anything else. `move_failed` also refuses an `export` whose sealing `release_session` staged extension state that is no longer on disk: the session is never bundled without it, and `finish` with a `declined` answer takes it back.

### Continuing a session on another computer (`session_relocation`)

The agent can ask to continue its own session on another of the user's computers (tools `list_relocation_targets` and `relocate_session { target, reason }`). The engine knows no other machines, so it asks the client that offers relocation, and that client (the host app, for example the desktop) runs the move with the commands above. The engine never moves anything itself and never interrupts a turn. Both tools are registered search-exposed and kept out of the agent's tool list until a host offers relocation for the session. They are activated at the start of each run while it is offered, so a plain CLI session (or one with no offering client) never sees them.

A multi-session host advertises `session_relocation` in `get_protocol_info.capabilities`. A client offers relocation by sending `session_relocation` in its own `set_client_info.capabilities` and attaching to the session (`open_session`). Relocation belongs to ONE connection: the earliest-attached connection of the session that advertised it. Only that connection receives `host_request` and `relocation_due`; every other attached client (an older client, a second window) sees neither, and a `host_response` from any connection other than the one asked is refused `not_offering_connection` and changes nothing. When no attached connection offers it (a plain CLI, a classic single-session `--mode rpc` process, a client that does not offer it, a session running in a worker isolate, which `release_session` could not release anyway, and the stdio lane of a multi-session host, which has no connection identity to address or tell apart from other answerers; a desktop uses the socket host), both tools answer `unavailable` with reason `not_offered`, nothing is sent, and the session keeps working here. A classic single-connection handler reads its own client's capabilities.

The session asks with an outbound `host_request`, tagged with the routing `sessionId` and sent to the offering connection only:

```json
{"type":"host_request","id":"hr_5f0c...","method":"list_relocation_targets","sessionId":"rpc-1"}
{"type":"host_request","id":"hr_9a1d...","method":"relocate_session","target":"Studio","reason":"heavy build","sessionId":"rpc-1"}
```

The client answers once, under the request's `id` and the same `sessionId`, with `data` (or `error` when it failed):

```json
{"type":"host_response","id":"hr_5f0c...","sessionId":"rpc-1","data":{"targets":[{"name":"Studio","online":true,"capacity":"high","aboutToSleep":false}]}}
{"type":"host_response","id":"hr_9a1d...","sessionId":"rpc-1","data":{"accepted":true,"moveId":"mv-a1","target":"Studio"}}
{"type":"host_response","id":"hr_9a1d...","sessionId":"rpc-1","data":{"accepted":false,"reason":"target_busy","detail":"Studio is running a build"}}
```

Every `host_response` is acknowledged under its `id`: `{"type":"response","command":"host_response","success":true}`, or `success: false` with `error: "unknown_host_request"` (no request of this session waits for that id: already answered, timed out, or never sent), `"not_offering_connection"` (the request went to another connection), or `"invalid_host_response"` (no `id`). A host that accepts a move and is told `unknown_host_request` answered too late (after `no_answer`) or for a closed session: the agent was told the move did not happen, so the host must roll back what it prepared for that move (for example `move_session cancel` on the receiver).

- `list_relocation_targets` `data`: `targets`, each `{ name, online, capacity?, aboutToSleep? }`. `name` is what the agent passes as `target`; `capacity` is a free-form hint. The list passes through unchanged; one that does not parse is refused `invalid_host_answer`.
- `relocate_session` `data`: `{ accepted: true, moveId, target? }` accepts (`moveId` is the plain id the host will use for `release_session` and `move_session`; `target` is the name to show, defaulting to the asked one), and `{ accepted: false, reason?, detail? }` declines. The host should prepare the receiver before accepting, and must decline a session it cannot release (for example one in a worker isolate, which `release_session` answers `release_unsupported`).
- The session waits at most 60 seconds for an answer (refused `no_answer`); an aborted tool call is refused `cancelled`; a session closed while waiting is refused `session_closed`; a request whose connection leaves the session (`close_session`, `detach_connection`, a dropped socket) is refused `app_disconnected` at once; `error` is refused `host_error` with the error text.
- A session without a session file answers `unavailable` with reason `not_releasable` without asking. One accepted move per run: a second `relocate_session` while one is scheduled or still being asked is refused `already_scheduled` without asking.

The agent's tool results are typed in `details`: `{ status: "listed", targets }`, `{ status: "scheduled", target, moveId }`, `{ status: "unavailable", reason, detail }`, or `{ status: "refused", reason, detail }` (the host's own `reason` and `detail` when it declined). Every outcome except `scheduled` leaves the session open and writable here.

**When the move happens.** An accepted request is scheduled; it never interrupts the run that asked for it. The tool result tells the agent the work continues on the target when this turn ends, and the run goes on to its natural end (further tool calls, its closing reply, queued follow-ups). When that run settles (`agent_settled`) and every `prompt` call behind it has returned, the session sends one event:

```json
{"type":"relocation_due","moveId":"mv-a1","target":"Studio","reason":"heavy build","sessionId":"rpc-1"}
```

It comes after the run's `agent_end`, and only when no new run has started meanwhile; if one has, the notice follows that run's settle instead. At that point `release_session` finds the session quiet. The host then runs the ordinary move: `release_session { reason: "move", moveId, target }` from its own attached connection (which does not count as another client, so no `force` is needed; another attached client makes it refuse `attached` and the session stays writable), `move_session export`, the transport to the receiver, `import`, `status` and `finish`. The release ends this runtime: `session_released` records `move_id`, `target` and `session_id`, and the thread keeps its id, conversation and queued input (`dropped.user_messages` travels with `export`). A host that decides not to move after `relocation_due` changes nothing; the session stays writable here, and the host should tell the agent (for example with a follow-up prompt).

`relocation_due` is delivered **at most once**. The schedule lives only in the running host: no due event follows when the user aborts any run while it is scheduled (the run that asked for it, or a later run the notice was waiting behind: the user's control wins), when the session closes or its runtime is replaced, when the connection that accepted it leaves the session before the notice (`close_session`, `detach_connection`, a dropped socket) or no longer offers relocation, and when the host process ends. A host must therefore time out an accepted request that never receives `relocation_due` and roll back what it prepared (a readied receiver expires after 10 minutes on its own).

If the schedule is cleared because the offering connection left, the user aborted, or the offering capability was withdrawn or taken over by another connection, the agent receives exactly one custom session message of type `session_relocation`, with `details: { status: "dropped", reason, moveId, target }`. The reason is respectively `disconnected`, `aborted`, or `withdrawn`; `moveId` and `target` identify the accepted request. A withdrawal during a long run is reported when the run settles. After a user abort, the notice is appended at `agent_settled`, before another prompt is needed, and is saved even if the session then closes. The message says the session stays on this computer and the agent should keep working here. It is context only (`display: false`, `triggerTurn: false`): it never starts another turn or resumes a user-stopped run. This is a session message through the existing message events, not another host request or a new RPC event type. Session disposal and process exit still have no later agent notice.

### Host self-observation (event-loop stalls and memory pressure)

Every in-process session shares the host's event loop, so a session that blocks it freezes every other session and the
transport with it. A multi-session host therefore watches itself. Both observers run on unref'd timers, and both only
REPORT: nothing here aborts a turn, kills a session, or refuses an `open_session`.

- **Event-loop stalls**: a 200 ms timer measures how late it is actually invoked; that lateness is the time the loop
  could serve nobody. Drift above `SENPI_RPC_LOOP_LAG_WARN_MS` (default 500) writes one stderr line per 10 seconds,
  `senpi rpc host stall: event loop blocked <drift>ms (sessionId=<handle> tool=<tool>)`. Drift above
  `SENPI_RPC_LOOP_LAG_ERROR_MS` (default 5000) additionally broadcasts a `host_stalled` record
  (`{ type, driftMs, sessionId?, tool?, processCpuMs?, heapDeltaMb? }`) to every connection, like the other content-free lifecycle records.
  `processCpuMs` is the process CPU time spent during the stalled window and `heapDeltaMb` the JS heap change across it, so a
  stall explains itself: CPU close to `driftMs` means the host was busy (a large heap drop in the same window points at a
  collection), and CPU close to zero means the process did not run at all (the machine starved it, or it sat in a blocking
  wait). The stderr line carries the same two numbers as `cpu=<ms> heap=<+/-MB>`.
- On accepting an `open_session`, the host sends that connection a `queued` record
  (`{ type, for_request, position, in_flight }`) before the open enters the session loop.
  `position` is 1-based and `in_flight` counts opens already accepted across the whole host,
  since every session shares one loop. It is addressed to the opener only, carries the request
  id under `for_request` rather than the response-id field, and is dropped if that connection
  has disconnected. The bundled `RpcClient` treats it as the host's acknowledgement: an
  acknowledged open waits up to 10 minutes for its response instead of the 30 s request
  deadline (a busy host was measured answering after 57 s), and a timeout after it names the
  queue position instead of a bare deadline. A lost transport still rejects at once.
- A multi-session host sends the same `queued` record for a session-routed `prompt` the moment it receives it,
  before the prompt's preflight runs on the session's loop (`position` counts that session's requests in flight).
  The bundled `RpcClient` then waits up to 5 minutes for the prompt to be accepted instead of the 30 s request
  deadline (a compaction's longer wait is never shortened by it), and a timeout after it says the host received the prompt. A prompt the host never acknowledged still
  fails at the request deadline. A reply written for a session that already closed is dropped, with one stderr
  line naming the session.
- **Stall attribution**: each routed command is dispatched inside an `AsyncLocalStorage` scope carrying its routing
  `sessionId`, and an in-process session's tool executions open a span carrying `{ sessionId, tool }` for as long as
  the tool runs. A stall is blamed on the synchronous work that finished inside the measured window, or on the tool
  still executing when it ended; when neither exists the record and the log line carry no session, because the stall
  belongs to the host itself. Worker-runtime sessions block their own isolate rather than the host loop and
  deliberately have no tool spans.
- **Memory pressure**: a 30-second sampler reads the host's memory footprint: `phys_footprint` on macOS, `RssAnon` on
  Linux, `PrivateUsage` on Windows, and RSS only where none of those can be read (`measure: "rss"`). RSS itself never
  decides: it keeps counting memory the host already returned (after a collection or an eval kernel reset it stayed
  at gigabytes while the footprint was back near 150 MB, senpi#2261). Above `SENPI_RPC_HOST_RSS_WARN_MB` (default 4096,
  compared with the footprint despite its name) it broadcasts `host_memory_pressure`
  (`{ type, rssMb, footprintMb, measure, sessions, main, kernels }`) on every sample, writes one stderr line per five minutes naming
  both numbers, and HALVES the idle-eviction window above while the host stays above the threshold, so idle sessions
  return their memory sooner. `main` is `{ heapBytes }`, the host's main-thread heap in bytes (`bun:jsc heapSize()` when
  the runtime offers it, else `process.memoryUsage().heapUsed` - on Bun that counts the main thread only, never a kernel
  worker's heap, which is also why the loop-lag watchdog's `heapDeltaMb` is a main-thread figure). `kernels` lists every
  live kernel as `{ sessionId, language, liveBytes, measure }`, so the record names which sessions own the pressure:
  `measure: "heap"` for a JS kernel's own estimate, `"footprint"` for an interpreter process's footprint; a kernel
  without a reading yet reports `liveBytes: 0`, and one that crashed between samples is absent rather than repeated
  with a stale number. `list_sessions` rows carry the same split per session as `memory`
  (`{ main_heap_bytes, kernel_heap_bytes, kernel_count }`, zeros for a session holding no kernel), which is what
  `host status --all --include-workers --json` reports as `{ main_heap_mb, kernel_heap_mb, kernel_count }` on
  `session_rows`. It is released as soon as the footprint falls back under the threshold. Memory never refuses an open: the
  host has no resource caps, so every `open_session` is admitted whatever the host holds (#2207). Hosts released
  before #2207 had a second admission watermark; current hosts have no such admission path.
- **Per-endpoint pressure under sharding**: an agent directory may contain many independent hosts, so each endpoint
  samples and reports its own memory pressure. `host_memory_pressure` describes only the host that emitted it; pressure
  on one `p-*` or `i-*` endpoint does not gate opens on another endpoint. In `host status --all`, `rss_mb` is the
  endpoint generation's whole process tree, `host_rss_mb` is the supervisor plus host processes, and `memory_pressure`
  is whether the answering generation is above the threshold right now. Read them on the endpoint row (and the RSS
  pair on its generation rows) rather than treating an aggregate agent-directory number as an admission
  signal. The warning threshold remains observability-only: every endpoint continues to admit worker `open_session`
  requests while pressured.
- **Stall-proof dead-peer detection**: the socket dead-peer budget (30 s, `socket-event-fanout.ts`) counts only time
  the host loop actually SERVED. The loop-lag watchdog deposits each measured drift into a process-wide ledger
  (`loop-blocked-time.ts`) and the deadline re-arms for whatever blocked time landed inside its window, so a host that
  blocked for longer than the budget cannot cut every live peer on unblock (#1905). A peer that drains nothing for a
  fully-served 30 s window is still cut.
- **Teardown order**: a session's provider scope closes only after its runtime disposal settles, on the graceful path
  and at the close grace deadline alike; a config-reload watcher callback bound to a closed scope is a no-op (#1905).

- **Zero-session trim**: when a host that held sessions drops to zero (opening and closing ones included), it runs one
  full collection (`Bun.gc(true)`; `gc()` on Node only with `--expose-gc`) and, one second later, broadcasts
  `host_trimmed { footprintBeforeMb, footprintAfterMb, measure, collected, sessions, pauseMs }` - the allocator returns
  freed pages lazily, so the after reading waits for it. At most one trim per minute; idle exit is unchanged.
- **Busy-host trim**: a host whose footprint is at least 2 GB also collects when its session count drops while other
  sessions still run (`sessions` > 0 in the record), because a host whose sessions keep allocating never idles long
  enough to return freed pages (#3218). Each collection is timed (`pauseMs`), and the next busy-host trim waits at least
  60 s and at least 100 times that pause, which keeps collection near 1% of a busy host's loop in steady state. A drop that
  lands inside that wait is held and collected when it ends. The
  first busy-host trim has no earlier pause to wait on, and one collection on a multi-GB live heap can itself exceed
  the stall threshold (a `host_stalled` record and ~120 s of refused ensures, never a lost session).
  These collections are the only synchronous work the no-sync rule allows, and the record is their log.

`host_stalled`, `host_memory_pressure` and `host_trimmed` are additive records: a client that does not know them ignores them.

#### The no-sync rule

One event loop serves every session of the daemon, so a synchronous wait taken while handling one session is an
outage for all of them: a five-second `spawnSync` inside a tool is five seconds in which the host answers nobody -
not another session's `prompt`, not even `get_protocol_info`. The rule for code on the session path is therefore
absolute: **no blocking primitive, and no unbounded synchronous filesystem read.**

- Banned inside the engine: `execSync`, `execFileSync`, `spawnSync`, `Bun.spawnSync`, `Bun.sleepSync`, `Atomics.wait`.
  A ban-with-ledger audit (`test/suite/no-sync-in-session-path.test.ts`) walks the transitive call graph rooted at the
  session registry, session binding, connection handler, command router, `AgentSession`, auth storage and every tool,
  and fails on any call site the checked-in ledger does not already record with the reason it is still there.
  Synchronous filesystem calls are reported against the same ledger: a new call site, or one more call inside a
  ledgered function, fails; removing one never does. The blocking ledger is five bounded entries - the sync credential
  and settings lock backoffs (1 s budget each), the memoized `which`/`where` probe, the win32 `taskkill` path and an
  on-demand tool extraction - and the filesystem ledger records each remaining synchronous read/write with the bytes
  it moves (the JSONL transcript append is deliberately there), so "how long can this host be frozen by its own code"
  has a written answer instead of a guess.
- The same rule applies to EXTENSIONS, where nothing can enforce it: an extension that shells out synchronously,
  sleeps synchronously, or reads a large file synchronously inside an event handler freezes every other client's
  session on that host. Use the async API, and give genuinely CPU-bound work its own worker or child process.
- The rule is observable rather than enforced at runtime: the stall watchdog above is what names the offender.
  `host_stalled { driftMs, sessionId, tool, processCpuMs, heapDeltaMb }` and the matching stderr line are how a blocking call in a session or a
  tool becomes a report instead of an unexplained freeze.

### Worker ownership and flow control

This section describes the WORKER runtime (`--session-runtime worker`). An in-process host owns transport,
attachments and reservations on one event loop, so none of the cross-thread grants, credits or opening deadlines
below exist there.

The main host owns transport, attachments and canonical reservations. Workers canonicalize caller-supplied paths;
main does not synchronously traverse those paths. An open prepares a path, obtains the main host's exclusive grant,
and only then constructs its session writer and runtime. A conflicting alias attaches to an open owner or fails
explicitly before opening another writer.

SessionManager writes, switches, forks, new sessions and imports obtain the same grant before writer creation or
append-side normalization. A grant is bound to a LIVE writer, not to the worker's lifetime: every snapshot a fully
open worker publishes names the session files its live session writers still own, and the host releases each granted
path that list (and the worker's current session path) no longer names. A session replaced by `new_session`,
`switch_session`, a fork or an import therefore frees its previous file as soon as the replacement is published:
another `open_session` for that superseded path opens its own worker instead of attaching or failing, and the
previous opening spelling stops resolving to the replaced owner. Each worker may reserve at most 64 live paths
at once; a request past that budget first reconciles against the latest snapshot and only then fails with
`session_reservation_limit`, which is distinct from `session_path_in_use` (another owner holds the path). Only a
fully open entry reconciles. An entry that is opening, closing or quarantined keeps every acquired path, because a
worker stuck in a syscall can still be writing a path it can no longer report. Close or an opening deadline requests
worker termination, but does not release reservations or worker capacity until the actual exit event. A syscall that cannot yet be interrupted can therefore keep an entry
internally quarantined after the routing handle has closed. `list_sessions` continues to publish `closing`, not a
new status: existing clients must not mistake a quarantined worker for a live reattach target. Retry the path only
after that entry disappears.

Each worker accepts at most 64 ordinary pending requests totaling 16 MiB, plus four reserved interrupt/UI-response
slots totaling 1 MiB. Prepare, commit and bind share one 30-second opening budget starting with worker allocation;
they do not each reset that budget. Interrupt requests have a five-second deadline. Ordinary commands remain bounded
by count and bytes without imposing a new timeout on long-running commands. The desktop's 60-second open/readmission
window is a separate client-side wait: the host normally reports its earlier 30-second failure within that window,
but a slow transport can delay delivery. Neither timeout proves worker exit or permits concurrent reopening.
UI cancellation coalesces to one pending request, and close has its own control message. IPC output and snapshots are limited to 16 MiB per record, with one acknowledged record at a time. Over a
socket host, credit returns as soon as every destination of that session has ACCEPTED the record into its own bounded
queue (64 MiB per connection), not when the peer's kernel has drained it: a client that is merely busy cannot withhold
the producing worker's credit. On the shared stdio lane credit still waits for stdout backpressure. A five-second credit
failure closes that session visibly (`session_error` followed by `session_closed`), rather than retaining an
unbounded queue. Socket clients advertising `event_resync` use the same-connection recovery described above.
Other socket queues keep their independent overflow/disconnect behavior: a connection whose queue would
exceed 64 MiB is cut immediately, and a peer that has not accepted a single pending write within 30 seconds
(`DEFAULT_STALL_MS`) is cut as a dead peer. That budget is a transport liveness bound and is deliberately independent
of the 5-second worker control deadline — a busy client is not a dead one. A cut connection receives one `overflow`
record (`error: "overflow, resync required"` or `"stalled, resync required"`); the host then half-closes the socket
instead of destroying it, so a peer that resumes reading within a 5-second grace (`SOCKET_CUT_GRACE_MS`) still receives
that notice, and everything already written to it, before EOF. A peer that is still silent when the grace expires has
its socket destroyed. A cut peer must reconnect and resynchronize, while the session keeps running and its other
destinations keep receiving output. A failed or cut connection never withholds a session's credit and never fails the
host writer; only the stdio lane can. Because credit no longer paces a session against its slowest reader, a
session that outruns a peer fills that peer's 64 MiB queue instead of slowing down, and that peer then resynchronizes
or, without `event_resync`, is cut on overflow. The default stdio
queue is bounded at 64 MiB or 4096 records, with reserved terminal-failure records and one control-overflow notice.
Close admission counts both queued output and pending close replies (including their serialized bytes) before
releasing an attachment or waiting for teardown. An admitted first closer reserves its lifecycle and terminal reply;
admitted joiners follow those records in FIFO order. Excess closes are not admitted and do not release ownership.
One bounded `overflow` record with `command: "close_session"` and
`error: "rpc_close_output_overflow, resync required"` reports the saturation episode instead of retaining a reply
or promise for each rejected request. Over sockets, this notice goes only to the requester whose close was rejected;
each connection may have at most one outstanding notice, released when its sink consumes it. After socket-only drain,
a subsequent saturation episode on the same connection can report a new notice without reconnecting. A healthy peer is not
told to resynchronize, and a newly affected or reconnected peer receives its own notice. Stdio retains one notice per
episode. Clients receiving a notice must stop issuing closes, drain output, and resynchronize unacknowledged requests; the notice is not a successful close acknowledgment. Admission resumes as capacity becomes available.
Canonical reservations and worker capacity remain held until native exit, including after close-output overflow.

The classic handler, extension UI bridge and provider scope run inside the owning worker; only
plain data crosses IPC. Inline `main()` extension factories cannot be cloned and are rejected in shared mode: use
file-backed extensions. Classic single-session RPC remains in-process. Standalone Bun builds must embed
`src/modes/rpc/session-worker.ts` as an explicit entrypoint. Bun 1.4.2 supports `--compile --splitting`
with `--minify --keep-names`; standalone release and package binary builds use these flags to share code
between embedded entries. Splitting does not change the worker-entry define contract below.
Node bundles must ship `session-worker.js` beside the chunk containing its worker client.
Third-party/rebranded Bun wrappers must pass the published
`dist/modes/rpc/session-worker.js` as an additional compile entry, set an explicit `--root`, and set
`--define=SENPI_RPC_SESSION_WORKER_ENTRY='"./<worker-path-relative-to-root>"'`. The define is a build-time
contract, not an environment variable. Its path must match Bun's embedded entry name, not the source machine's
absolute path or the runtime working directory. The client resolves it against its compiled `import.meta.url`
before constructing the Worker: Bun 1.4.0 resolves a bare relative Worker string against the real cwd instead
of the embedded filesystem. Verify the relocated wrapper on the wrapper's supported Bun version and platform
by opening two shared sessions;
a standalone Senpi smoke does not verify a wrapper's different compile graph.

Workers isolate JavaScript event loops, not OS processes: they do not promise syscall cancellation, process-fatal OOM
containment, or containment of arbitrary native code. They are not an extension sandbox.

### D1 normative table (multi-session mode)

Hosts that support `open_session.permissionPreset: "accept-edits"` advertise
`permission_preset_accept_edits`. This preset allows project read/list/grep/edit
and asks for bash, external_directory and other tools. Clients without that
capability must use `ask`, never `workspace`, for an edit-only approval promise.
Hosts that support `permissionPreset: "auto"` advertise `permission_preset_auto`;
clients without it must not send `auto`.
Explicit permission rules and remembered approvals retain their existing precedence, except under `auto`: there settings and CLI rules can only narrow the preset (the more restrictive decision wins), and an "Always" answer (saved in `.senpi/permissions-approved.jsonl`, from this or an earlier session) still allows its pattern.
An `open_session` that attaches to a live session with another `permissionPreset` moves that session to it: the next
tool call is decided under the new preset, in either direction, and `new_session` / `switch_session` / `fork` keep it,
also when the attach lands while one of them or a `reload` (or two overlapping reloads) is still rebuilding the
session. An attach that names a preset is applied even when the session was opened or last attached with the same one.
An attach without the field keeps the current preset. An attach accepts exactly the values `open_session` accepts and
treats them the same way: an unknown preset name is applied like one given to `open_session`, so the session's next
tool call is refused with `Permission setup failed: Invalid --permission-preset "<name>". ...` until a later attach
names a valid preset.

| Command | Params | Success data | Notes |
| --- | --- | --- | --- |
| `attach_session` | `sessionId`, `durableSessionId`, `expectedHostInstance?` | `{ sessionId, attached: true }` | Live-only, identity-fenced attachment; never opens/resumes or changes the launch profile. Capability `attach_session`. |
| `release_attachment` | `sessionId` | `{ deferred: boolean }` | Releases exactly one caller hold with disconnect semantics; `deferred` is true only when settlement owns the final release, and false while draining. Capability `release_attachment`. |
| `reclaim_session` | `sessionPath`, `durableSessionId`, `expectedHostInstance` | `{ reclaimed: true, sessionId }` | Atomic attach-and-claim of every caller hold; refuses other connections before aborting. Capability `reclaim_session`. |
| `get_protocol_info` | - | `{ protocolVersion: 1, serverVersion: string, capabilities: string[], mode: "classic"\|"multi", instanceId: string, generation: number, engineVersion: string, engineOrdinal: [y, m, d, n, epoch], launch_profile: { profile_id, core }, memory_pressure?: boolean }` | Answered in BOTH modes; side-effect-free; the capability probe. Multi-session hosts include `multi_session`, `session_held` (the active foreign-holder admission guard, in both runtimes), `retain_on_disconnect`, `session_kind`, `session_context`, `auto_title_per_session`, `durable_session_id`, `moved_path_guard` (senpi resolves and guards paths the OmO desktop moved with its data home), `prompt_surface` and `prompt_surface_chat` plus the negotiated launch capabilities. Those are HOST capabilities (a client never sends them) and are advertised only in multi-session mode, where the host owns the attachment refcount and the per-session launch profile. The identity fields are described under "Host identity" above; compatibility is decided from `protocolVersion`, `capabilities` and `engineOrdinal`, NEVER from `serverVersion`. |
| `open_session` | `sessionPath?`, `cwd?`, `provider?`, `modelId?`, `thinkingLevel?`, `permissionPreset?`, `retain_on_disconnect?`, `kind?`, `context?`, `auto_title?`, `durableSessionId?`, `promptSurface?`, `browserEngine?`, `retryFallback?` (all optional; paths MUST be absolute) | `{ sessionId, state: RpcSessionState, attached?: true }` | `sessionPath` = today's `--session` semantics (open-if-exists else create persisting there, `session-manager.ts:926-940`); `provider`/`modelId` applied only on create (resume restores the session's model — mirrors `SenpiSessionRuntime.ts:198-200`); params form the immutable launch profile (D8). When the path is already held by a fully-open session, the open ATTACHES to it: same routing handle, `attached: true`, one more attachment counted; the runtime is torn down only when the last attachment closes. Idle sessions past the eviction window are closed by the host itself. `retain_on_disconnect: true` (default false) makes a dropped connection DETACH from this session instead of closing it — see "Retained sessions" below. `kind` (default `interactive`) and the opaque `context` map are described under "Session kind and context" above; both are stored frozen for the session's life and never influence auth, model or resource resolution. |
| `close_session` | `sessionId` | `{}` | Refused with `unknown_session` when the requesting connection never attached to that handle (a close releases the CALLER's attachment, and `list_sessions` publishes every handle). Otherwise aborts active work, awaits agent idle + settled persistence for up to the host grace window (default 10s), then quarantines any worker that has not exited without releasing its path reservation; its response is the LAST record tagged with that handle for the first closer — no events after (test-pinned). An admitted concurrent close joins the same teardown and receives its own successful response; output saturation rejects admission with the bounded close-overflow/resync notice described above. |
| `list_sessions` | `include_workers?` (default false) | `{ sessions: [{ sessionId, durableSessionId, sessionPath, cwd, name, status, attachments, kind, context? }] }` | Includes `opening`/`closing` entries. Internally quarantined workers remain externally `closing` until exit. `attachments` is the session's live client attachment count; `0` on an `open` row is a retained session with no client attached. Every row carries `kind`. Rows with `kind: "worker"` are omitted unless `include_workers: true`, and `context` is published ONLY on that listing — a default listing carries no `context` at all. |
| `detach_connection` | - | `{ deferred: string[] }` | Multi-session hosts that advertise `detach_connection`. Meant as the connection's last request: the host releases every session attachment this connection holds and answers only after that, so another connection's next `list_sessions` no longer counts it. `deferred` names the sessions that still count it (see `#### detach_connection`). Closing the socket afterwards releases nothing more. `senpi host session` sends it before closing, bounded at 5 s; on a host without the capability, or after a request timed out or the connection was lost, it relies on the release at socket close. |
| `release_session` | `sessionId`, `reason: "takeover" \| "move"`, `moveId?` (required for `move`), `target?`, `interrupt?`, `force?` | `{ released: true, session_path, attachments }` | Hands the session to a runtime outside this host. See "Handing a session over (`release_session`)" below. |
| `move_session` | `op` and its fields (see "Moving a session to another device (`move_session`)") | per `op` | Drives one step of a session move between hosts. Capability `move_session`. |
| `host_response` | `id`, `data?`, `error?` | `{ type: "response", command: "host_response", success }` | Answers one `host_request` of the session (see "Continuing a session on another computer"). Capability `session_relocation`. |
| `wake` | `sessionId`, `delivery_ids?` | `{ admitted: [{ delivery_id, kind }] }` | Runs the session's registered inbox drain once. See "Waking a host session (`wake`)" below. |
| `warm` | `cwd?`, `kind?`, `context?` (as on `open_session`; `cwd` MUST be absolute) | `{ state: "warmed" \| "already_warm" \| "unsupported" }` | Loads what the next matching `open_session` needs without opening a session; never listed, never an attachment, idempotent per profile. See "Warming a host" above. Advertised as the `warm` capability by in-process hosts only. |
| every existing command | + `sessionId` (REQUIRED in multi mode) | unchanged | Routed to that session. |

### Live-only attachment and scoped release

#### attach_session

`attach_session { sessionId, durableSessionId, expectedHostInstance? }` attaches the current connection
only to the live session selected by both routing and durable identity. A vanished or non-open target
returns `unknown_session`; a recycled routing id or mismatching host instance returns
`session_identity_mismatch`. A draining or shutting-down host refuses before admission with
`session_busy_lifecycle` and `errorData: { reason: "host_draining" }`; a caller without a connection
receives `session_not_attached` with `errorData: { reason: "no_connection" }`. It never creates or resumes a runtime, and never applies a permission preset,
prompt surface, or browser engine. Each success adds one attachment, connects the event stream, and publishes
`session_status` with `lastChange.cause: "attach"`. Intentional profile-changing attaches through
`open_session { sessionPath, permissionPreset, ... }` retain their existing behavior.

#### release_attachment

`release_attachment { sessionId }` releases exactly one hold this connection owns on this session;
other sessions and repeated remaining holds are untouched. It uses disconnect semantics, not close:
when the final hold of a non-retained session leaves during a streaming turn, physical release waits
for settlement. The turn survives even when its original owner disconnected before a temporary
attacher released. The released hold immediately loses mutation and close authorization.
A retained session remains live at zero attachments. `close_session` remains the destructive release.
An unattached caller cannot release another connection's hold: a connection with no hold on that
session receives `session_not_attached` with `errorData: { reason: "not_attached" }`. These
attachment-command refusals carry `reason` only; only the gate refusal below adds `action`.

### Atomic recovery (`reclaim_session`)

#### reclaim_session

Send `reclaim_session { sessionPath, durableSessionId, expectedHostInstance }` when recovering a known
leftover on this host. Both identities are required; neither is inferred from the path.
Before admission, a draining or shutting-down host refuses with `session_busy_lifecycle` and
`errorData: { reason: "host_draining" }`. Otherwise, before any
await, the host resolves the live path, checks lifecycle state before both identities, refuses
other connections, records a visible attachment for the caller, then claims ALL that caller's holds
(including the newly recorded one) and marks the entry closing. It then aborts and performs normal
finalization. Zero-attachment retained sessions and leftovers with one or several caller holds are
supported in both runtimes.

Lifecycle precedes identity because an opening entry may not have published its runtime identity yet.
An entry that is both busy and identity-mismatched therefore returns `session_busy_lifecycle`.

Refusals change nothing: `session_busy_lifecycle` with `errorData.reason: "host_draining"` while
draining or shutting down, `unknown_session` for an
unheld path, `session_identity_mismatch` for missing or different identities,
`session_busy_lifecycle` for opening/closing targets, `attached_elsewhere`
with `errorData.attachments` counting other holds, and `session_not_attached` with
`errorData.reason: "no_connection"` for a caller without a connection. An attach that wins the synchronous admission race
causes `attached_elsewhere`; an attach after the claim cannot join the closing entry. Reclaim never opens
or resumes an absent path.

A disconnected owner's deferred physical hold still counts as `attached_elsewhere` until its active
turn settles, even though that owner no longer has a live connection. Settlement releases that hold.

### Attachment admission

On a socket host, session-scoped commands require the current connection to be attached unless they are
in the following effect-based read allow-list:

`get_state`, `get_messages`, `get_entries`, `get_tree`, `get_fork_messages`,
`get_last_assistant_text`, `get_media`, `get_commands`, `get_loaded_surfaces`,
`get_available_models`, `get_available_thinking_levels`, `get_fast_mode`, `get_session_stats`,
`get_pending_inputs`, `get_steering_messages`, `get_follow_up_messages`, `get_auth_providers`,
`get_provider_accounts`, `resolve_path`, `memory_report`, `eval_cells.list`, `eval_cells.peek`,
and `check_reload_veto`.

`record_user_activity` is gated like any other session command (lead ruling 2026-10-22, senpi#3814). Its only
known caller, the desktop app's prewarm path (omo-desktop-app `apps/server/src/provider/Layers/OmoAdapter.ts:7121`),
sends it on the session's own opener connection: the handle it uses is created from that session's
`open_session` reply (`OmoSessionHandle.ts:397-403`), so the connection is already attached.

Host discovery/control remains available: `get_protocol_info`, `list_sessions`, `subscribe_sessions`,
`unsubscribe_sessions`, `get_subscription_limits`, `warm`, `detach_connection`, `attach_session`,
`reclaim_session`, and `set_client_info` without `sessionId`. `get_effect_status` is a read with
either a routing id or a transcript path. `open_session` is exempt from this gate because its own
admission creates the caller's attachment. Attachment lifecycle commands apply their own admission
rules. `export_html` and `export_jsonl` write files and therefore require attachment.
Every other session-scoped command is gated by default, including abort, wake, release/unload,
message injection, settings/account changes, and extension UI responses/progress.
`resume_session` is gated too: it releases the session's engine holds and starts the held turns.
An `open_session { "attended": false }` is an attachment like any other open: it admits the
connection to gated commands until its own `close_session` or disconnect gives the hold back.
`senpi host session` therefore needs no extra `attach_session` after reopening a parked session.

This release **serves** each new violation and writes exactly one stderr line per violation:

```text
senpi rpc host: <command> on <session> from a connection not attached to it (refused from the next release)
```

Set `SENPI_RPC_REQUIRE_ATTACH=1` to enforce now. Enforcement returns
`errorCode: "session_not_attached"` with `errorData.reason` and
`errorData.action: "attach first with attach_session { sessionId, durableSessionId } or open_session { sessionPath }"`.
Already-refused commands are not relaxed by grace: unattached `close_session` still returns
`unknown_session`, and `set_session_context` keeps its existing `session_not_attached` refusal.
Stdio hosts and host-internal lifecycle calls have no current connection and retain existing behavior.
Worker sessions pass through this same gate before worker dispatch.

### Identities (D6)

Response-level `sessionId` = opaque **routing handle**, unique per process epoch, ephemeral (dies with the child). `state.sessionId` = **durable** JSONL session identity (what a resume cursor stores today). `list_sessions` exposes both. Clients store both, discard routing handles on child exit, and verify only durable ids against cursors.

### Fenced holder attachment

Shared hosts advertise `expected_host_instance`. After discovering a holder,
read `get_protocol_info` through its public RPC socket with the existing socket
authentication, then send `open_session { sessionPath, expectedHostInstance }`.
The field is attach-only: `owner_changed` with
`errorData { reason: "host_instance_mismatch", action: "rediscover_holder" }`
means the generation changed. A matching generation that no longer owns the
path returns `session_not_held` with the same rediscovery action. Neither
refusal constructs a runtime or claims a file. A matching held path attaches
to its existing routing handle and event stream. Without the field, open
retains its existing create/resume behavior. Clients must check the capability
before using this safety fence; older hosts may ignore unknown fields.

Session holder records publish `host_socket` (the public endpoint, not a
supervisor's private child hop) and `host_instance` alongside PID/boot/start
identity. Path reservation claims publish `host_socket` alongside their
existing `instanceId`. `session_held` exposes these optional endpoint fields
on validated live holders; a record that changed during the liveness probe
reports neither the endpoint fields nor `cwd`. They are discovery evidence,
not authorization: this fence protects against stale or other host
generations, not against a malicious same-user process. Any same-user process
can write a holder record naming a live PID and any `host_socket`, and the
fence only compares against the instance ID the endpoint reports about
itself, so a fake same-user socket could echo it back. Validate the process
identity and the endpoint's live protocol identity before attachment, and
fence every attach. A legacy record missing endpoint fields still blocks
another writer while its process is live. An unreachable endpoint or missing
fields never prove that a writer is absent; rediscover through registered
host reservations or a transcript-context candidate and validate that
candidate against the live host. Proven dead/stale process identities
continue to be reclaimed by the existing lease guard.

Attachment creates no input effect receipt. Send ordinary `prompt` with
`clientMessageId`/`clientTurnId` through the attached connection and use the
existing durable input admission/replay machinery below. This adds no second
ledger and uses no process-kernel startup credential. TUI socket sidecar auth,
Windows host handshake auth, and restricted local Unix host sockets retain
their existing contracts.

### Stable error codes

The shared host advertises the exact HOST capability `session_held` in
`get_protocol_info.capabilities`, forwarded in endpoint information, from the same
capability inventory in both `in-process` and `worker` runtimes. Probe it before
enabling in-place binding with an engine pin. Classic bindings do not run this guard
and do not advertise it, even if a client supplies the string in its flags.

Match `errorCode` when present; legacy responses expose machine-matchable
codes or code prefixes in `error`:

- `unknown_session`
- `session_not_attached: <reason>` (`set_session_context` from a connection without an attachment; `errorData { reason, action }` tells the caller to attach with `open_session { sessionPath }` first)
- `eval_cells_unavailable` (the routed session has no eval-cell RPC handler)
- `eval_cell_not_found` (unknown or foreign-session cell ID)
- `invalid_eval_cell_request` (malformed eval-cell identifier or tail budget)
- `session_closing` (an entry whose owner is tearing down). A worker that FAILS while its session is being opened is not that case and reports `open_failed` carrying the worker's own reason, so the code a client matches on always names what actually happened.
- `session_held` (`open_session`, including attach, or any session-writing RPC whose JSONL has a live holder outside this daemon family). The refusal has `errorCode: "session_held"` and `errorData { holders: [{ pid, cwd?, host_socket?, host_instance? }] }`; no boot or process-start metadata is exposed. A single dispatch guard covers prompt/steer/follow-up, continuation/custom messages/wake/compaction, model/thinking changes, bash/results, edits/name/labels, appends and tree/session changes; only explicit read/control commands bypass it. The host queries `liveSessionHolders` afresh, resolves moved paths, ignores stale/dead/reused-pid records, and excludes its own PID and worker threads. Live generation identities registered to the same endpoint are also excluded, preserving the daemon's `session_path_in_use` retry/reclaim protocol. Open is checked again after runtime holder publication, before attachment or success, with rollback on refusal. Retry after the other process exits; no restart is needed. An interactive CLI opening or resuming a held session warns with pid/cwd; lookup filesystem errors warn and continue.
  - **Mid-turn policy:** a turn admitted before the foreign holder appeared finishes and persists its results; subsequent writing RPCs are refused. Read/control requests, including abort, queue clearing, `extension_ui_response` and `extension_ui_progress`, remain available.
  - **Conservative admission:** `new_session`, `fork`, `clone`, and settings or account commands carrying this session's routing handle are also refused while its current file is held. Close the handle and open another session to leave a held file.
  - Holder records are admission evidence, not an exclusive filesystem lock. SessionManager's append API is synchronous and fresh process-identity checks are asynchronous; changing append to asynchronous admission would change the SDK contract and could discard results of already-executed tools.
- `session_path_in_use` (path held by an opening or quarantined owner; a fully-open current owner is attached instead, an owner whose teardown is already in flight is waited out on the in-process runtime, and a path a live owner has superseded is released rather than held). A path held by ANOTHER GENERATION of the daemon carries `errorData { owner: { instanceId, pid, processStartTime, sessionPath, current }, retry_after_ms: 2000 }`: that generation is still writing the file and is parking it, so the open is a retry, not a failure. An open that arrives while ANOTHER open of the same path is still taking that cross-generation claim waits for it - bounded by the close grace window - and then attaches to the session that open is building; a claim that does not settle in that window answers `errorData { reason: "claim_in_progress", retry_after_ms: 2000 }`. When the claim it waited on is refused, the next waiting open takes the claim itself and later ones wait on that, so no racing open answers a bare refusal; a path still reserved by a session past its teardown grace answers `errorData { reason: "path_still_held", retry_after_ms: 2000 }` (senpi#3485). Only a claim whose owner serves the socket (`current: true`) or still has a client attached refuses an open at all - a superseded, attachment-less claim is reclaimed instead
- `session_reservation_limit` (this worker already holds 64 live session paths; the open or session replacement was refused without disturbing the existing session)
- `missing_session_id` (session-scoped command without `sessionId` in multi mode)
- `multi_session_disabled` (`open_session` in classic mode)
- `host_stopping` (`open_session` refused by a supervised host that is shutting down or draining, including opens previously answered with `host_draining`; `errorData.instanceId` identifies the stopping generation. Re-resolve the public endpoint; a launch-owning caller may wait for this generation's exit within the stop budget and start a successor.)
- `host_draining` (`open_session` on a bare, unsupervised host, or `release_session` forwarded to a child whose generation is parking for a handoff; re-resolve the public path and open or release on the successor rather than retrying this connection)
- `turn_active` (`release_session` while a turn runs or is about to start - a prompt in preflight, an admitted delivery not yet written - without `interrupt: true`; `errorData { attachments, busy }`)
- `session_busy` (`release_session` while other session work runs - bash, compaction, barrier-held work, another request for the session - without `interrupt: true`; `errorData { attachments, busy }`)
- `attached` (`release_session` while OTHER connections are attached, without `force: true`; `errorData { attachments }` counts their holds)
- `session_identity_mismatch` (`attach_session` or `reclaim_session` selected a different durable identity or host instance)
- `session_busy_lifecycle` (`reclaim_session` found an opening or closing target, or `attach_session` / `reclaim_session` reached a draining or shutting-down host: then `errorData.reason` is `host_draining`)
- `attached_elsewhere` (`reclaim_session` found another connection's holds; `errorData.attachments` counts them)
- `invalid_release_reason` (`release_session` with a `reason` other than `takeover`)
- `release_unsupported` (`release_session` for a session this host cannot hand over; `errorData.detail` is `worker_runtime` - a worker isolate owns the runtime - or `no_session_file`)
- `release_failed` (`release_session` whose hand-over failed after it began - the release entry could not be written or the teardown threw; `errorData.detail` is the error message, plus `interrupted`/`dropped` after an interrupt)
- `invalid_path` (relative `sessionPath`/`cwd`)
- `open_failed: <detail>`. `open_failed: model_unavailable: <reason>` means the open named a model (`provider`/`modelId`) that could not be resolved, for example an unknown provider; the session is not opened, rather than running on the default model. The in-process runtime adds `errorData { reason: "model_unavailable", requestedModel }`; a worker runtime relays the same error text, so match on the prefix
- `invalid_session_context: <detail>` (`open_session.context` past a documented cap: more than 32 keys, a key that does not match `^[a-z][a-z0-9_]*$`, a non-string or >16 KiB value, or more than 32 KiB of JSON in total; the detail names the cap and its byte budget)
- `invalid_subscription: <reason>` (`subscribe_sessions` with a malformed `sessions`, `mirror` or flag; `errorData { reason, action }`)
- `unknown_subscription: <reason>` (`unsubscribe_sessions` naming a subscription this connection does not hold)
- `subscription_limit: <reason>` (`subscribe_sessions` on a connection that already holds the documented maximum of 64 subscriptions; `errorData { reason, action }`)
- `unsupported_transport: <reason>` (`subscribe_sessions` or `unsubscribe_sessions` on the stdio transport, which has no per-connection identity to deliver a subscription to; `errorData { reason, action }`)
- `invalid_session_context: <reason>` from `set_session_context` (a reserved host or lineage key, a bad key or value, or a patched context over 4096 bytes; `errorData { reason, action }`)
- `invalid_session_kind: <detail>` (`open_session.kind` other than `interactive` or `worker`)
- `invalid_launch_profile: <detail>` (`open_session.auto_title` present but not a boolean, `open_session.promptSurface` other than `terminal`, `app` or `chat`, `open_session.browserEngine` other than `connected`, `builtin` or `none`, a malformed `open_session.retryFallback`, an empty or non-string `open_session.expectedHostInstance`, or `open_session.provider` without `modelId` or the reverse)
- `host_memory_pressure` (sent only by hosts released before #2207, which declined to CREATE a `kind: "worker"` session above `SENPI_RPC_HOST_RSS_REFUSE_MB`; `errorData { rssMb, retry_after_ms }` says when to ask again. Current hosts never refuse an open for memory; a client talking to an older generation waits and retries, it never starts a second host or a per-child process)
- `warm_failed: <detail>` (`warm` could not load its profile, for example a `cwd` that does not exist; not remembered, so a retry loads again)
- `media_not_found` (`get_media` for an unknown `toolCallId`, or a `contentIndex` that does not point at an image block)

### Tagging

Every response/event/`extension_ui_request` belonging to a session carries a top-level `sessionId` (routing handle). `get_protocol_info`/`list_sessions` responses are untagged. Classic mode: nothing tagged (byte-identical).

### Ordering guarantee (D9)

Strict FIFO per session; one total stdout order; cross-session order unspecified; fair round-robin between sessions' queued complete records; NO cross-session batch coalescing (per-session event buffers; the process-wide single-array coalescer in `event-output-buffer.ts` must not merge records of different sessions into one write). Starvation freedom is NOT promised (single pipe); a giant tool record delays others — bounded only by record completion.

### Duplicate/idempotency

Duplicate `open_session` while a path reservation is held by a fully-open session → ATTACH (`attached: true`, same handle), including when that session is retained with zero attachments; while held by an `opening` entry (or an internally quarantined one) → `session_path_in_use`. A `closing` entry is a session that is ENDING, not one in use: on the in-process runtime (the `--listen` socket host default) the open WAITS for that teardown - bounded by the close grace window that bounds the teardown itself - and then opens the file fresh, so reopening a path after a close never depends on how long disposal takes. The worker runtime still answers `session_path_in_use` there, because a worker's teardown ends with an OS thread exit that no host deadline bounds. A path whose owner has already replaced it with another session file is no longer held: that open allocates a new worker and resumes the file. `close_session` releases one attachment; the runtime is disposed only when the last attachment closes. A close for an entry already `closing` joins its in-flight teardown. `close_session` on unknown/already-closed → `unknown_session` error, and so is a `close_session` from a connection that never attached to that handle — it releases nothing and leaves the session untouched. The grace window is configurable by the host through `SENPI_RPC_CLOSE_GRACE_MS`. Request `id`s are client-owned; the server echoes them without dedup.

## Protocol Overview

- **Commands**: JSON objects sent to stdin, one per line
- **Responses**: JSON objects with `type: "response"` indicating command success/failure
- **Events**: Agent events streamed to stdout as JSON lines

All commands support an optional `id` field for request/response correlation. If provided, the corresponding response will include the same `id`. `bash_execution_update` events also include the `id` of their originating `bash` command.

### Framing

RPC mode uses strict JSONL semantics with LF (`\n`) as the only record delimiter.

This matters for clients:
- Split records on `\n` only
- Accept optional `\r\n` input by stripping a trailing `\r`
- Do not use generic line readers that treat Unicode separators as newlines
- Send JSON objects only; valid JSON primitives and arrays receive a parse-style error response
- Keep each encoded input record at or below 16,777,216 characters. Oversized records receive one parse-style error,
  are discarded through the next LF, and do not desynchronize following records

In particular, Node `readline` is not protocol-compliant for RPC mode because it also splits on `U+2028` and `U+2029`, which are valid inside JSON strings.

## Commands

### Prompting

#### Durable client identity

Hosts advertising `durable_client_message_id` in `get_protocol_info` accept optional
`clientMessageId` and `clientTurnId` on `prompt`, `steer`, and `follow_up`. Each is a
non-empty string of at most 256 characters. Keep these IDs unchanged when retrying
after a disconnect; the transport `id` and routing `sessionId` may change.

```json
{"id":"request-2","type":"prompt","message":"Hello","clientMessageId":"message-1","clientTurnId":"turn-1"}
```

Admission is deduplicated by the durable session header ID and `clientMessageId`.
Repeating a delivery returns the existing admission without running input handlers,
appending another user message, or starting another answer. Changing the input kind,
text, images, prompt options, or `clientTurnId` under that key fails with
`errorCode: "client_message_id_conflict"`. Recovery `enqueueOrder` is not part of
payload identity; the first admission's order stays authoritative. When present it must
be a finite number; any other value is refused before admission.

Successful responses echo both IDs in `data` and, when `clientMessageId` is present,
include `data.admission`:

```json
{"durableSessionId":"session-id","clientMessageId":"message-1","clientTurnId":"turn-1","state":"running","disposition":"started"}
```

`state` is `queued`, `running`, or `completed`. Completed means the admission settled,
including handled or cleared input; it is not a claim that a provider answered
successfully. The existing `disposition` remains `started`, `queued`, or `handled`.
Preflight or storage rejection creates no accepted admission, so the same delivery
can be retried after the failure is repaired.

Accepted queues and their prepared content survive reopening the transcript. They
are restored in the original enqueue order without rerunning input transforms, and a
delivery that arrives while they are being restored is queued behind them. A prompt
that was acknowledged as `started` but displaced into the steering queue by a run that
began first is stored as queued input too, so it survives a host restart. A transcript
entry that does not parse as an admission is ignored rather than blocking the session.
Running or completed admissions are never replayed, and `clear_queue` retires its
admissions before returning. Native steering priority and drain behavior are unchanged.
Durability requires a persistent session; `--no-session` retains deduplication only
for that runtime's lifetime.

The IDs appear on persisted user messages, `turn_start`, message and tool execution
events, `turn_end`, and `agent_end`. A turn consuming several identified inputs adds
`clientMessages` with their identities; top-level IDs identify the most recently
consumed input. `turn_start` identifies the first consumed input. A turn whose input is a custom
message, such as a `send_custom_message` trigger turn, carries no client IDs. The `ordered`
records in `queue_update`, `get_state`, `clear_queue`, `get_steering_messages`, and
`get_follow_up_messages` carry IDs too. The legacy string `messages`, `steering`,
and `followUp` arrays remain available.

#### Effects and receipts

Hosts advertising `effect_ledger` give every effect on a session a durable receipt
written before the effect is applied, and answer for it by id. A receipt is never
execution truth: `get_state.isStreaming` says whether a turn runs now; the receipt's
`outcome` says how an effect ended.

| Kind | Commands | Id field |
| --- | --- | --- |
| `input` | `prompt`, `steer`, `follow_up` | `clientMessageId` (the effect id is the client message id) |
| `abort` | `abort` | `effectId` |
| `set_model` | `set_model` | `effectId` |
| `set_thinking_level` | `set_thinking_level` | `effectId` |

An `effectId` is a client-minted string of 1-256 characters. Keep it unchanged when
retrying: the transport `id` and the routing `sessionId` may change (a reopened session
gets a new handle), and neither is part of the effect's identity.

States: `accepted` (recorded, not yet applied), `applied` (dispatched), `done`, and
`failed`. Input admissions map `queued -> accepted`, `running -> applied`,
`completed -> done`. `failed` and every `outcome` other than `completed` carry
`reason`, plain-words `detail` and, when the caller can act, `action`.
An effect's actor is `by: { connectionId }`. Client names are not part of the
receipt contract.

- `abort { effectId }` on a streaming session answers `applied` and becomes `done` when
  the session reaches `agent_idle`; on an idle session it answers `done` with
  `disposition: "no_active_turn"`. An abort never fails.
- `set_model { effectId }` answers `done` once `model_changed` was emitted; the
  `model_change` transcript entry carries the `effectId`. A model the registry does not
  offer fails with `outcome.reason: "unknown_model"`; missing credentials fail with
  `provider_unavailable`, while a context-budget refusal fails with `context_budget`
  and an action to compact or select a larger model. The immediate budget refusal's
  `errorCode` is `"context_budget"` (`RPC_ERROR_CONTEXT_BUDGET` in the typed API);
  `errorData.effect` carries the failed receipt.
  A switch held for compaction answers `accepted` until the next send applies it.
  Overwriting the hold, selecting a fitting model directly, or cycling onto one fails
  the older receipt with `superseded`; a held target that still cannot fit after repair
  fails with `context_budget`. Replacing the session with `new_session`, `switch_session`
  or `fork` fails a held switch with `dropped_by_replace` in its outgoing transcript.
  Unexpected selection errors record `failed` with `outcome.kind: "error"`, the error detail,
  and an action before propagating the exception. Same-id retries replay those failures rather than switching.
  `set_thinking_level { effectId }` records its own kind and stamps its id on
  `thinking_level_change`, including when the level was already in force.
- An input's `done` receipt carries `outcome.kind`: `completed`, `aborted` (with
  `abortSource` and `abortedBy: { connectionId }` when a client's `abort` or matching `interrupt` reached the
  turn), or `error`. A queued input dropped because the session was replaced
  (`new_session`, `switch_session`, `fork`) reads `failed` with
  `outcome.kind: "dropped_by_replace"`. A host stop or an unload is not a replacement:
  a queued input keeps its `accepted` receipt and is restored when the session reopens.

Replay: the same id with the same request answers the stored status with
`replayed: true` and performs nothing. The same id with a different request is refused
with `errorCode: "effect_id_conflict"` and `errorData: { effectId, reason, action }`
(inputs keep `client_message_id_conflict`). The comparison covers only the semantic
fields: `abort { awaitIdle, clearQueue, graceMs }`, `set_model { provider, modelId }`,
`set_thinking_level { level, scope }`.

Reopen seal: a reopened session (or a restarted host) has no live turn and no pending
switch, so every unfinished receipt is sealed before any command reads it. A running
input becomes `done` with `outcome.kind: "interrupted_by_reopen"`; an abort becomes
`done` with `disposition: "no_active_turn"`; a `set_model` becomes `failed` with
`reason: "interrupted_by_reopen"` and `action: "send set_model again with a new
effectId"` unless its `model_change` entry is already in the transcript, in which case
it is `done`. The model a session runs is read from its transcript, never from a receipt.
An unfinished `set_thinking_level` similarly becomes `done` if its stamped
`thinking_level_change` exists, otherwise `failed` with an action to send
`set_thinking_level` again with a new effect id. An unfinished `dequeue` or `edit_queued`
becomes `failed` with `reason: "interrupted_by_reopen"` and an action to re-read
`queue_update.ordered` and retry with a new effect id.

An `abort` without `effectId` writes nothing and behaves as before.

The host never writes `uncertain`. A client whose request timed out, or whose
connection dropped before the response, treats the effect as uncertain locally and
resolves it with [get_effect_status](#get_effect_status): `found: false` means the
effect never landed and the same id can be sent again.

#### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With a session-only thinking level:
```json
{"id": "req-1", "type": "prompt", "message": "Solve this carefully", "thinkingLevel": "high"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message. A prompt without it is refused with `errorCode: "streaming"`:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.
Queued prompts cannot include `thinkingLevel`; wait for the current turn to complete before changing it.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `pi.sendMessage()`.

**Input expansion**: Leading skill tokens (`/skill:name`, `$name`, or `$skill:name`), inline explicit
desktop skill tokens (`$skill:name`), and prompt templates (`/template`) are expanded before
sending/queueing. Bare inline dollar text remains literal.

**Unknown commands**: When the message's first token looks like a command (`/name`, letters, digits,
`:`, `_`, `-`; a second `/` as in `/tmp/a.txt` makes it a path) and neither extension `input`
handlers nor expansion changed the text, a name that is not a registered extension command, prompt
template, or loaded `skill:<name>` is refused before the model sees it. The failure carries
`errorCode: "unknown_command"` and `errorData: {"command", "suggestions", "reason"}`: `command` and
`suggestions` (up to three close names) omit the leading `/`, and `reason` is `"unknown"` or
`"interactive_only"` for a TUI builtin such as `/model`. A message that starts with whitespace
(`" /foo bar"`) is sent as text, as in the TUI. The failure message names the confirm step; resend the
same message with `"unknownCommandAsText": true` to send it to the model unchanged:

```json
{"type": "prompt", "message": "/etc is where the config lives", "unknownCommandAsText": true}
```

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" }}
```

The prompt success response carries `data.disposition` (`"started"` | `"queued"` | `"handled"`), captured from the host session's own disposition callback so proxied clients can resolve optimistic-echo contracts exactly like the local path. Older hosts omit `data`; clients must then degrade to canonical-only rendering (treat the echo as rejected). The response is emitted before the user `message_start` event on the same connection, and disposition callbacks registered through the client run synchronously inside response-frame dispatch — never through the resolved promise's microtask.

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.
The `message` field for `prompt`, `steer`, and `follow_up` is limited to 1,000,000 characters;
image payloads are not counted toward this text limit.

**Tool barrier** (capability `tool_barrier`): a client that captures a pre-turn workspace checkpoint can send the prompt at once and hold the turn's workspace-changing tools until its capture is done. `toolBarrier: {"id", "deadlineMs"}` arms the barrier for the turn this prompt starts; `id` is 1-256 characters and `deadlineMs` a whole number in 1..600000.

```json
{"id": "req-1", "type": "prompt", "message": "Fix the bug", "toolBarrier": {"id": "turn-42", "deadlineMs": 35000}}
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": {"disposition": "started", "toolBarrier": "armed"}}
```

- While the barrier is armed, a tool whose definition is not `workspaceEffect: "read"` waits after its `tool_execution_start` and before it runs, and the session emits `tool_barrier_waiting` once per waiting call. The built-in read-only tools (`read`, `grep`, `find`, `glob`, `ls`, `todo`, `web_search`, `webfetch`, `tool_search`, and the ask-user question tools) run at once; everything else, MCP and extension tools included, waits.
- `data.toolBarrier` is `"armed"` when the prompt started its own turn (the barrier is armed before the response is written) and `"ignored"` when the prompt was queued into a running turn as steering or follow-up content, or handled by a command. Nothing is armed in the ignored case.
- The barrier opens on `release_tool_barrier`, when its turn ends (the run's final `agent_end`, or a queued follow-up starting the next turn), or when `deadlineMs` passes, which emits `tool_barrier_expired`. A Stop (`abort`) ends the wait and settles the turn as aborted.
- `steer` and `follow_up` never carry a barrier, and a prompt without `toolBarrier` behaves exactly as before.
- A malformed `toolBarrier` is refused before the prompt is accepted.

#### release_tool_barrier

Open the tool barrier armed under `barrierId` (capability `tool_barrier`). It is idempotent: an id that was never armed, was already released, belonged to a turn that ended, or expired answers `released: false` and still succeeds.

```json
{"id": "req-2", "type": "release_tool_barrier", "barrierId": "turn-42"}
{"id": "req-2", "type": "response", "command": "release_tool_barrier", "success": true, "data": {"released": true}}
```

#### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead). Like `prompt`, queued input runs extension `input` handlers with `source: "rpc"`.

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` is `"handled"` if an input handler consumed this steer, or `"queued"` if senpi queued it (including after a handler transformed it). It does not guarantee the message stays queued. Like the prompt response, `data` is optional: older hosts omit it.

On an idle session a plain `steer` only queues; it waits for the next turn. Pass `whenIdle: "start"` (capability `steer_when_idle`) to start a turn with the message when no turn is running or starting. The session decides atomically, through the same path as `prompt` with `streamingBehavior`: an idle session answers `"started"` (the admission records `started`), and a session that is running or already starting a turn answers `"queued"`. Two `whenIdle: "start"` inputs that arrive together start one turn; the other is queued into it. If the input that claimed the start never starts its turn (it is rejected, or an extension or command handles it), the input that joined it starts the turn instead, so nothing is left queued on an idle session. The message runs through `prompt` handling (input handlers, templates, slash and unknown-command handling); `enqueueOrder` is kept when it ends up queued. `whenIdle: "queue"` (the default) keeps today's behavior; any other value is refused with an error that names the valid values.

```json
{"type": "steer", "message": "Look at the failing test", "clientMessageId": "m-7", "whenIdle": "start"}
{"type": "response", "command": "steer", "success": true, "data": {"disposition": "started", "clientMessageId": "m-7"}}
```

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

#### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead). Extension `input` handlers run with `source: "rpc"`.

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` has the same optional `"handled"` or `"queued"` meaning as for `steer`, applied to this follow-up. `follow_up` accepts the same `whenIdle: "start"` (answering `"started"` on an idle session, `"queued"` otherwise).

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current operation. A plain `abort` is acknowledged once the abort is dispatched, before the
turn has stopped; pass `awaitIdle` to answer only once it has.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

With `effectId` (capability `effect_ledger`) the abort is recorded before it is
dispatched and the response carries the receipt; see
[Effects and receipts](#effects-and-receipts):

```json
{"type": "abort", "effectId": "stop-1"}
{"type": "response", "command": "abort", "success": true, "data": {"effectId": "stop-1", "state": "applied", "effect": {"effectId": "stop-1", "kind": "abort", "state": "applied", "durableSessionId": "session-id"}}}
```

Quiesce and queue options (both optional, combinable with `effectId`):

- `awaitIdle: true` answers once the session is idle or `graceMs` (integer, 0 to 60000, default 10000) has
  passed (`graceMs` is validated but has no effect without `awaitIdle`). The answer adds `stopped` and `idle`: both `true` only when idle was reached. On grace expiry they
  are `false`, the abort keeps going, and an `effectId` receipt stays `applied` until the turn ends (`done`).
  A `graceMs` outside the range is refused with `errorCode: "invalid_argument"` and `errorData`
  `{ reason: "invalid_grace_ms", action }`.
- `clearQueue: true` drains the steering and follow-up queues atomically before the abort, emits
  `queue_update`, and gives each drained input with a `clientMessageId` a `failed` receipt with outcome
  `cleared` (with `reason`, `detail` and `action`). 2026.10.16-2 wrote this outcome as `cleared_by_abort`;
  receipts stored under that name are still read and reported unchanged, so accept both. The answer's `cleared` counts the drained inputs.
  `clear_queue` and `unload_session { clearQueue: true }` close drained input with the same `cleared` outcome; a
  session release does not (its queued deliveries stay unwritten so the sender redelivers them).
  It also empties the queue of an idle session.

```json
{"type": "abort", "effectId": "stop-2", "awaitIdle": true, "clearQueue": true}
{"type": "response", "command": "abort", "success": true, "data": {"effectId": "stop-2", "state": "done", "effect": {"effectId": "stop-2", "kind": "abort", "state": "done", "durableSessionId": "session-id"}, "stopped": true, "idle": true, "cleared": 1}}
```

The typed `RpcClient` sends these with `abort({ effectId, awaitIdle, clearQueue, graceMs })` and returns the answer; `abort()` with no options keeps the old fire-and-forget contract. `getEffectStatus(effectId, { sessionPath? })` reads a receipt.

An aborted turn's `agent_end` carries `aborted: true`, `abortSource` and, when an RPC client aborted it,
`abortedBy: { connectionId, effectId? }`; a `session_abort` caused by a client carries the same `abortedBy`. `interrupt` records its caller the same way. An abort that reached no turn is forgotten once it settles, and a new turn starts with none, so a later system or extension abort never inherits an old client's `abortedBy`.
Every attached client sees it. `abortSource` is `user` for a client or user abort, `provider` when the
provider retry watchdog gave up, and `system` for a host-side stop such as a turn deadline.


#### interrupt

Stop the running turn and only that one, with the terminal control endpoint's contract (see "Interactive sessions
expose a control endpoint"). `turnId` (the `turn_epoch` of `get_state`) is optional.

```json
{"type": "interrupt", "turnId": "3"}
```

Response: `{ interrupted: true, turnId }` once the turn has stopped; `{ interrupted: false }` when the session is
idle; `{ interrupted: false, turnId }` (the running turn) when `turnId` names another turn. Unlike `abort`, it
answers after the turn settled.

```json
{"type": "response", "command": "interrupt", "success": true, "data": {"interrupted": true, "turnId": "3"}}
```

With `"intent": "stop"` (on `abort` or `interrupt`) the command is a user Stop: the session is paused before the
turn is stopped, and automatic wakes that arrive later (terminal and monitor notices, detached eval cells, goal
continuations, task and team deliveries) are kept as notices instead of starting a turn. Only a connection that
declared the `interactive_user` capability with `set_client_info` may send it; any other connection gets
`stop_requires_interactive_client`. The capability is fixed at its first declaration on a connection. `interrupt`
with `"intent": "stop"` also stops an automatic turn that started after the one `turnId` named, and pauses an
idle session. Human input (`prompt`, `steer`, `follow_up` on an `interactive_user` connection) or `resume_session` releases the pause. The same commands from any other connection are automatic: while a Stop or a run hold is live they answer `heldAsNotice: true` and are delivered as a notice when the session resumes (an `unattended` hold alone is released by any prompt, as before); `get_state`
reports `paused`, `pausedNoticeCount` and `pausedHeldInputCount`.

```json
{"type": "set_client_info", "width": 120, "capabilities": ["interactive_user"]}
{"type": "abort", "intent": "stop", "awaitIdle": true}
```

#### hold_input

Hold human input for a paused session and deliver it at the start of the turn that resumes it. An interactive
connection may hold input. A `task_parent` connection may relay a person's run guidance into the child it paused for
that run: it sends `parentSessionId` (the session that sent `pause_for_run`), and another parent is refused with
`wrong_parent`. `origin` is optional; when present it must be `"human"`. Any other connection is refused with
`hold_input_requires_interactive_client`. Idempotent by `inputId`: the same id and `revision` answers the existing
entry, an id that was already delivered answers `alreadyDelivered: true`, and the same id with another revision is
refused with `input_id_conflict`.

```json
{"type": "hold_input", "inputId": "g-1", "revision": 1, "text": "Use the staging database"}
```

```json
{"type": "response", "command": "hold_input", "success": true, "data": {"entryId": "a1b2c3", "duplicate": false}}
```

#### withdraw_held_input

Withdraw held input before it is delivered. Interactive connections only.

```json
{"type": "withdraw_held_input", "inputId": "g-1"}
```

```json
{"type": "response", "command": "withdraw_held_input", "success": true, "data": {"withdrawn": true}}
```

#### pause_for_run

Pause this session because its parent's run was paused (a task child of a stopped session). Only a connection that
declared the `task_parent` capability may send it. The child keeps every automatic wake as a notice and holds human
input instead of starting a turn; its own `resume_session` is refused until the parent resumes the run. A later call
with a higher `parentPauseSeq` raises the hold; a different `parentSessionId` is refused with `wrong_parent`.
`childSeq` is this session's own pause sequence, which the parent passes back as `childSeqCutoff` on resume.

```json
{"type": "pause_for_run", "parentSessionId": "s-parent", "parentPauseSeq": 2, "runRef": {"kind": "dag", "id": "r1"}}
```

```json
{"type": "response", "command": "pause_for_run", "success": true, "data": {"held": true, "childSeq": 4}}
```

#### resume_for_run

Release a run-owned pause and start this child's resumed turn: held human input first, then the notices held while
paused, then a directive about the interrupted turn. `task_parent` connections only. A `parentPauseSeq` other than
the newest one this child saw (older or newer) answers `released: false, reason: "stale"`. A Stop the user gave this
child directly is released only when its sequence is at or below `childSeqCutoff`; a newer one survives
(`otherHoldLive: true`) and no turn starts. `turnId` is absent when the resumed turn did not start (a Stop landed while
it was admitted). Held input and notices are consumed only by a resumed turn that no newer Stop aborted.

```json
{"type": "resume_for_run", "parentSessionId": "s-parent", "parentPauseSeq": 2, "resumeId": "rs-1", "childSeqCutoff": 4}
```

```json
{"type": "response", "command": "resume_for_run", "success": true, "data": {"released": true, "otherHoldLive": false, "turnId": "7"}}
```

#### dequeue_message

Every queued input carries a session-unique `queuedId` (`q_<n>`) in `get_state.ordered` and `queue_update.ordered`. `dequeue_message` removes one queued input before it reaches a turn. It acts on the visible lists (`steering`, `followUp`) and the queue the agent drains, so a removed input is never delivered. With `effectId` (capability `effect_ledger`) it is a ledger effect (`kind: "dequeue"`) and a same-id retry replays.

```json
{"type": "dequeue_message", "queuedId": "q_3", "effectId": "dq-1"}
{"type": "response", "command": "dequeue_message", "success": true, "data": {"queuedId": "q_3", "status": "removed", "effectId": "dq-1", "state": "done", "effect": {"effectId": "dq-1", "kind": "dequeue", "state": "done", "disposition": "removed"}}}
```

#### edit_queued_message

`edit_queued_message` replaces a queued input's text in place, keeping its order, mode and `clientMessageId`, in the visible lists and the queue the agent drains alike. With `effectId` it is a ledger effect (`kind: "edit_queued"`).

```json
{"type": "edit_queued_message", "queuedId": "q_4", "text": "use the staging database"}
```

A `steer` or `follow_up` sent **without** a `clientMessageId` is still recorded durably under a host-minted id (`host:<durableSessionId>:<uuid>`), so it survives a host restart and a reopen restores it exactly once. No client-facing record carries that id: the send response, `get_state.ordered`, `queue_update.ordered`, `get_steering_messages` / `get_follow_up_messages` and event correlation (`clientMessageId` / `clientMessages` on events) all leave it out, and it never switches on event correlation for a client that sends no ids, before or after a restart. It stays on the stored user message in the transcript, and `get_effect_status` / `effect_status` report it as the input's `effectId`. An edit of such an input survives a restart too. A queued `prompt` sent without an id (`streamingBehavior` while busy) is not durable.

For both commands, `status` is `removed` / `edited`, or `already_delivered` (the input was already handed to the agent) or `not_found` (no such id in this session); those two also carry `reason` and `action`, and an `effectId` receipt ends `failed` with that outcome. A missing or over-long `queuedId` is refused, and so is an edit whose `text` is empty or longer than `MAX_RPC_MESSAGE_CHARACTERS` (use `dequeue_message` to remove an input). An edited input that has a `clientMessageId` (its own or, for input sent without one, the host's) keeps the edit across a reopen, and a retry of its original send still replays.

**Expected revision** (capability `queued_message_revision`): every entry in `get_state.ordered` and `queue_update.ordered` also carries `revision`, 1 when queued and +1 on every successful edit. Both commands accept an optional `expectedRevision` (a whole number of at least 1). When it is present and the input's current revision is different, the answer is `status: "conflict"` with `currentRevision`, `reason` and `action`, and nothing is changed; the check and the change happen in one step, so no other client's edit or a delivery can land between them. With `effectId` the receipt ends `failed` with outcome `conflict`, and a same-id retry replays that conflict. An input that is gone answers `already_delivered` or `not_found` as above, never `conflict`. An `edited` answer carries the resulting `text` and `revision`. A same-id retry answers with exactly the fields the live call returned (the receipt stores them). Revisions, like `queuedId`, hold only for the session's current lifetime: a reopen restores queued inputs at revision 1 under new ids, so re-read `get_state` after a reopen.

```json
{"type": "edit_queued_message", "queuedId": "q_4", "text": "use the staging database", "expectedRevision": 1}
{"type": "response", "command": "edit_queued_message", "success": true, "data": {"queuedId": "q_4", "status": "conflict", "currentRevision": 2, "reason": "conflict", "action": "read the input's current text and revision from get_state or queue_update, then retry with that expectedRevision if the change still applies"}}
```

#### get_pending_inputs

What the engine holds for every pending input, and the outcome of each id a client sent, read in one consistent step (senpi#3549). `inputs` lists every input still queued, sending or failed, each as a projection: `clientMessageId`, `state` (`queued`, `edited`, `sending`, `failed`), `text`, `requestedMode`, `revision`, `statusCode`, `statusText`, `actions` and `pendingDecoration`. `knownClientMessageIds` (at most 64 non-empty ids of at most 256 characters) asks for an outcome per id: `admitted` with its projection, including `delivered` and `removed`, or `not_admitted`. Absence from `inputs` is never an outcome; read the id's outcome instead.

The answer is consistent through `throughCursor`. To follow changes without a gap, subscribe first, apply the snapshot, then apply only `pending_input_update` events whose `cursor` is later. Each event carries every input one committed change touched, under that change's single `cursor`, with the same `lifetimeId`. A different `lifetimeId` means the session reopened: read the snapshot again.

```json
{"type": "get_pending_inputs", "knownClientMessageIds": ["c-7"]}
{"type": "response", "command": "get_pending_inputs", "success": true, "data": {"lifetimeId": "5b0c…", "throughCursor": 4, "inputs": [{"clientMessageId": "c-7", "state": "queued", "text": "also run the tests", "requestedMode": "followUp", "revision": 1, "statusCode": "queued_follow_up", "statusText": "Queued - sent after this turn", "actions": ["edit", "remove", "copy"], "pendingDecoration": true, "supersededVersions": []}], "outcomes": [{"clientMessageId": "c-7", "status": "admitted", "projection": {"clientMessageId": "c-7", "state": "queued"}}]}}
{"type": "pending_input_update", "lifetimeId": "5b0c…", "cursor": 5, "changes": [{"clientMessageId": "c-7", "state": "sending"}]}
```

#### clear_queue

Remove queued steering and follow-up messages and return their text.

```json
{"type": "clear_queue"}
```

Response:
```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction"],
    "followUp": ["Summarize when finished"]
  }
}
```

To implement interactive Esc behavior, send `clear_queue` before `abort`, then restore the returned text in the client editor. `abort` continues queued messages when they remain in the session.

#### new_session

Start a fresh session. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.jsonl"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

### State

#### get_snapshot

Atomic snapshot cursor (capability `snapshot_cursor`). Subscribe with `mirror` before taking a snapshot to cut the live record stream at a source-issued cursor rather than at response arrival. Terminal control endpoints support the same command.

`get_snapshot {sessionId, tail?, maxBytes?, observe?: true}` returns `{state, entries, next_before, history_truncated, markerId}`. `state` uses the existing `get_state` projection, including `pendingDialogs` and `pendingQuestions`. `entries` is the newest tail, in chronological order. `tail` defaults to 100 and accepts non-negative integers; `maxBytes` defaults to 8 MiB and accepts positive integers, capped at 48 MiB. The byte bound applies to serialized history entries. An entry that does not fit ends the tail; it is never silently skipped. `history_truncated` reports omitted history; `next_before` is the oldest returned entry's id when older history remains, otherwise null (also null when no entry fits).

State capture, history capture, and enqueueing `{type: "snapshot_marker", sessionId, markerId}` are one synchronous operation. The marker goes only to the requesting connection, only when a matching subscription has `mirror` enabled (including a list of selected record types). Other subscribers never receive that marker. Apply the snapshot and then records after its marker; a post-marker record can arrive **before** the correlated response. A reader without a mirrored subscription receives the snapshot response but no marker record. `observe: true` does not attach or refresh activity.

#### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "thinkingLevelSource": "session",
    "sessionModelThinkingLevels": {"anthropic/<model>": "medium", "openai/<model>": "high"},
    "serviceTier": "priority",
    "fastMode": true,
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0,
    "pendingDialogs": []
  }
}
```

The `model` field is a full [Model](#model) object or `null`. `pendingModelSwitch` is always present: `null` means no held switch, while an object with `provider` and `id` identifies a switch that applies after the next compaction. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

`pendingDialogs` contains the live `extension_ui_request` frames for select, confirm, input and editor dialogs, or `[]` when none await an answer. Still-open dialogs remain listed after session replacement; resolved, cancelled and timed-out requests are removed. Use these frames to reconcile dialogs during event recovery, separately from `pendingQuestions`.

Each model keeps its own thinking level per session. `sessionModelThinkingLevels` maps `provider/id` to the level that model last ran at in this session, rebuilt from the session file on resume. A model switch (`set_model`, `cycle_model`, the TUI's `/model`) restores, in order: this session's level for the model, a favorite's `:level`, the model's last level in any session (`modelThinkingLevels` in settings), the model's own default, then the configured default, always clamped to the levels the model supports. `thinkingLevelSource` says which one applies: `explicit` (set directly), `session`, `global`, `model-default`, `default`, `fallback` (a retry fallback's temporary level) or `clamped` (a requested or restored level the model cannot run, replaced by the nearest one it can). Hosts before this change omit both fields.

`serviceTier` is the tier a request would carry right now (`"auto"`, `"flex"`, or `"priority"`), omitted when no tier applies. `fastMode` is `true` when the active model is served at the priority ("fast") tier — either because fast mode is on for this session or because the model selection itself pins `priority`. The two never disagree: whenever `fastMode` is `true`, `serviceTier` is `"priority"`.

`lastProviderDiagnostic` is present after a failed turn whose provider supplied structured evidence: `{"category": "rate_limit", "httpStatus": 429, "code": "rate_limit_error", "evidence": "structured_code"}`. `category` is one of `auth`, `rate_limit`, `quota`, `context_limit`, `invalid_request`, `provider_unavailable`, `network`, `unknown` (`network` comes from a structured transport error code such as `ECONNRESET`, with `"evidence": "structured_transport"`); `httpStatus` is absent for errors delivered inside a streamed response. It describes the same failure as the latest assistant `errorMessage` and is replaced or cleared with it. The failed assistant message in `message_end`, `agent_end`, `get_messages` and the session file carries the same object as `providerDiagnostic`. See [Provider failure diagnostics](sdk.md#provider-failure-diagnostics) for how it is derived.

#### get_subscription_limits

Every subscription account's latest limit windows (capability `subscription_limits`). In interactive and
RPC modes (not print mode or `--offline`) the engine polls each signed-in Claude and ChatGPT subscription
account's usage endpoint (Claude every 5 minutes, ChatGPT every 2.5, `Retry-After` honoured, one request
per account per interval across every senpi process on the machine), so an account's windows are known
before its first turn; responses and the Claude SDK update the same record between polls. An account
nothing has reported for is absent - unknown, never 0%. The command only reads and may be sent with
`observe: true`.

```json
{"type": "get_subscription_limits"}
{"type": "response", "command": "get_subscription_limits", "success": true, "data": {"accounts": [{"provider": "chatgpt-subscription", "account": "default", "windows": [{"id": "codex:primary", "label": "7d", "windowMinutes": 10080, "usedPercent": 99, "resetsAt": "2026-10-21T03:29:11.000Z"}], "reportedAt": "2026-10-15T02:58:10.412Z"}]}}
```

`account` is the credential slot that served the request: a stored account's name, `env` for an
environment key, `default` for a single credential; it never carries key material. Each window has an `id`
stable within the account (`<limit>:<slot>`, for example `codex:primary` or `claude:5h`), a `label`
(`5h`, `7d`, `7d opus`), the window length in minutes when the provider sent it, `usedPercent` (0-100) and
`resetsAt` (ISO) when known. ChatGPT subscriptions report them in `x-codex-primary-*`/`x-codex-secondary-*`
response headers (one family per metered limit); Claude subscriptions in `anthropic-ratelimit-unified-*`
headers, and through the Claude SDK lane in its `rate_limit_event` messages. A window the latest response did not mention keeps its last value. A poll answers with the account's whole window set and replaces it. `plan` is the plan the usage endpoint names (ChatGPT), when it names one; `error` says why the last poll failed (`auth stale - run /login`, `rate limited`, `HTTP <status>`, `timed out`, `unreachable`), and the windows beside it are the last ones reported. The next successful report clears it. Every connection also hears a
`subscription_limits` record (below) when an account's windows change.

#### get_effect_status

The newest receipt of one effect (capability `effect_ledger`). For inputs `effectId` is the
`clientMessageId`. The command only reads: it never resets a host's or session's idle window,
works on a session another process holds, and may be sent with `observe: true`.

With `sessionId` it answers from the loaded session. With `sessionPath` and no `sessionId` it
reads that transcript from disk, so a session that was unloaded or whose host restarted is
answered without being loaded again:

```json
{"type": "get_effect_status", "effectId": "stop-1", "sessionId": "rpc-1"}
{"type": "get_effect_status", "effectId": "stop-1", "sessionPath": "/path/to/session.jsonl"}
```

Response:
```json
{"type": "response", "command": "get_effect_status", "success": true, "data": {"found": true, "effect": {"effectId": "stop-1", "kind": "abort", "state": "done", "disposition": "no_active_turn", "durableSessionId": "session-id"}}}
{"type": "response", "command": "get_effect_status", "success": true, "data": {"found": false, "searched": "complete"}}
```

`found: false` is answered only after the whole transcript was searched (the read starts with
the last 4 MiB and continues to the header), so it is proof the effect never landed: send the
same id again. A transcript that cannot be read is refused with
`errorCode: "transcript_unreadable"` and `errorData: { path, reason, action }`, never with
`found: false`.

#### get_messages

Account-scoped usage failures are projected as recovery advice with `errorCause: {"type":"usage_limit","scope":"account"}` in `message_*`, `agent_end`, `entry_appended`, `get_messages`, `get_entries`, and `get_tree`. The engine message and session file retain the original provider error for diagnostics; these raw stored messages are not the user-facing RPC representation. Entry ids, parent links, timestamps, tree labels, and provider diagnostics are preserved by the projection.

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](#message-types)).

#### get_media

Fetch one media block that was omitted for a [`media_placeholders`](#media_placeholders) client. The
parameters are exactly the placeholder's `ref`.

```json
{"type": "get_media", "toolCallId": "call_abc123", "contentIndex": 1}
```

Response:
```json
{
  "type": "response",
  "command": "get_media",
  "success": true,
  "data": {
    "toolCallId": "call_abc123",
    "contentIndex": 1,
    "content": {"type": "image", "data": "<base64>", "mimeType": "image/png"}
  }
}
```

`content` is the original `ImageContent` block, byte-for-byte. `contentIndex` indexes the tool
result's `content` array. The host looks the tool call up in the durable session entries first (so a
block stays fetchable after the live message window moved on), then in the current messages for a
result that has not been persisted yet.

When the tool call is unknown, the index is out of range, or the index points at a non-image block,
the response fails with `error` and `errorCode` both set to `media_not_found`:

```json
{
  "type": "response",
  "command": "get_media",
  "success": false,
  "error": "media_not_found",
  "errorCode": "media_not_found"
}
```

The command is answered in classic and multi-session mode alike; in multi-session mode it takes the
usual `sessionId` envelope. It is answerable regardless of whether the connection advertised
`media_placeholders`.

### Model

#### set_model

Switch to a specific model. A provider/model pair the session's registry does not offer is refused with
`errorCode: "model_not_found"`.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

An optional `effectId` records the switch as an effect: the response adds `effectId`,
`state` and `effect` beside the model, a retry with the same id answers
`replayed: true` without switching again, and a refusal also records the receipt as
`failed`. See [Effects and receipts](#effects-and-receipts).

Response contains the full [Model](#model) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

#### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model) object.

#### get_available_models

List all configured models, refreshing credential availability on each request so credentials added or removed by another session take effect without reopening this session.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects with supported thinking levels. A row's `serviceTier` and `upstreamModelId` are the values the session resolves for that model, including ones declared only in `models.json` or by an extension provider, so a `-fast` priority alias names its base model there and a client can tell a child opened on the base model is the alias it asked for. Each row also carries `supportsAssistantPrefill`: whether the model accepts a request ending with an assistant message, given the session's current thinking level. It is `false` for every model today, so clients continue an edited answer with `continue_from_leaf`:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

### Thinking

#### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose both.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

Pass `"scope": "turn"` to change only the current session level without rewriting the model's remembered level. The
command returns an error when the active model cannot apply the requested level, and a rejected request leaves the
session level unchanged — a failed `set_thinking_level` never mutates state.

```json
{
  "type": "response",
  "command": "set_thinking_level",
  "success": false,
  "error": "Thinking level low is not supported by the active model."
}
```

#### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

#### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

#### get_model_thinking_level

The thinking level one model runs at in this session, without switching to it. For the active model it is the current level; for any other model it is the level `set_model` would restore (see `thinkingLevelSource` under [get_state](#get_state) for the order). A client shows a model's effort with it before the user sends anything, instead of keeping its own per-model copy. The command only reads and does not count as session activity.

```json
{"type": "get_model_thinking_level", "provider": "openai", "modelId": "<model>"}
```

Response:
```json
{
  "type": "response",
  "command": "get_model_thinking_level",
  "success": true,
  "data": {"level": "high", "source": "session", "availableLevels": ["off", "low", "medium", "high"]}
}
```

An unknown model answers `success: false` with `errorCode: "model_not_found"`; a missing `provider` or `modelId` answers `errorCode: "invalid_argument"`.

### Fast mode

#### set_fast_mode

Turn fast mode (the ChatGPT Subscription `priority` service tier) on or off for the active model. The choice is remembered
per model, so a later session on the same model starts the same way; `enabled: false` records an explicit `"auto"`
so it also overrides a tier inherited from the model catalog.

```json
{"type": "set_fast_mode", "enabled": true}
```

Response:
```json
{
  "type": "response",
  "command": "set_fast_mode",
  "success": true,
  "data": {
    "enabled": true,
    "serviceTier": "priority",
    "provider": "chatgpt-subscription",
    "modelId": "gpt-5.6-sol"
  }
}
```

`serviceTier` is the tier just recorded for the model (`"priority"` on, `"auto"` off). `provider`/`modelId` identify
the model the preference was stored under: a `-fast` catalog variant and its base model share one entry, so the
reported id can be the base model rather than the model that was active.

The command returns an error instead of a silent no-op when the request cannot be applied:

| Situation | `error` |
|-----------|---------|
| Active model is not a ChatGPT Subscription model | `Fast mode is only available for ChatGPT Subscription models.` |
| `enabled: false` while the model selection pins `:priority` | `Fast mode is fixed by the active model selection's priority tier.` |
| `enabled` is not a boolean | `set_fast_mode requires a boolean 'enabled' field.` |

A successful call emits a [`service_tier_changed`](#service_tier_changed) event.

#### get_fast_mode

Read the current fast-mode state.

```json
{"type": "get_fast_mode"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fast_mode",
  "success": true,
  "data": {"enabled": true, "serviceTier": "priority"}
}
```

`serviceTier` is `null` when no tier applies. It matches `get_state.serviceTier`.

### Queue Modes

#### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

#### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

### Compaction

#### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

#### set_auto_compaction

Enable or disable automatic compaction when context is nearly full for this session only. The persisted `compaction.enabled` setting is left untouched, and `get_state` reports the effective value. Disabling it stops proactive threshold compaction; a provider-rejected context overflow still triggers the one-shot compact-and-retry recovery.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

### Retry

#### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

#### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

#### set_retry_fallback

A single-session `--mode rpc` process has no `open_session`. A caller that spawns one process per session (e.g. a task
child that runs as its own process) gives it its fallback policy with `set_retry_fallback`:

```json
{"type": "set_retry_fallback", "retryFallback": {"modelFallback": true, "fallbackChains": {"provider/model": ["provider/spare"]}}}
```

Response:
```json
{"type": "response", "command": "set_retry_fallback", "success": true}
```

The profile is the same shape, with the same limits, as `open_session.retryFallback`, and it has the same effect. It
overrides the session's `retry.modelFallback` and `retry.fallbackChains` in memory only, it is never written to a
settings file, and the process's later sessions (`new_session`, `switch_session`, `fork`) keep it.

It is a launch-time setting:
- It is accepted only before the session's first turn. It is refused once this connection has asked for a turn
  (`prompt`, `steer`, `follow_up`, `continue_from_leaf`, `send_custom_message` with `triggerTurn`), even one that has
  not started yet, while a turn streams (an extension's included), and once the session holds turn history (a resumed
  session's). So a chain never changes under a provider request or a retry already in flight. Context messages added
  before the first turn (role `custom`, from an extension on `session_start` or a `send_custom_message` without
  `triggerTurn`) are not a turn and do not block it.
- Send it on its own and await its response: a `set_retry_fallback` pipelined while a `new_session`, `switch_session`
  or `fork` is still being created can answer success while the session being created runs without it.
- A malformed profile is refused with the `open_session` shape message, and nothing is applied.
- A multi-session host refuses the command on its session connections; a host session takes its policy from
  `open_session.retryFallback`.

Probe `retry_fallback_command` in `get_protocol_info` before sending it. Only a single-session process advertises it.
Unlike an environment variable, the profile reaches this process only, never what its tools spawn. Unlike argv, it has
no command-line length limit and is not visible in a process listing.

### Bash

#### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Include an `id` to associate streamed `bash_execution_update` events with this command.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, all messages (including `BashExecutionMessage`) are transformed before being sent to the LLM. The `BashExecutionMessage` is converted to a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Bash output is included in the LLM context on the **next prompt**, not immediately
2. Multiple bash commands can be executed before a prompt; all outputs will be included

#### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

### Session

#### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.jsonl",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    },
    "failures": {
      "requests": 6,
      "erroredRequests": 1,
      "abortedRequests": 0,
      "failureShare": 0.16666666666666666,
      "failedDurationMs": 4200,
      "postFailureRequests": 1,
      "postFailureFullMissRequests": 1,
      "postFailureFullMissInputTokens": 48000
    }
  }
}
```

`cost` sums the provider-reported cost of every turn. `costUnknown: true` appears when at least one turn ran on a model with no known price (senpi#3844): `cost` is then a lower bound, not the full spend. The field is absent otherwise.

`failures` reports what failed provider requests cost the session. Every assistant response is one request; `erroredRequests` and `abortedRequests` count responses that ended with stop reason `error` or `aborted`, and `failedDurationMs` sums their time from request start to the recorded response. `postFailureRequests` counts the first successful response after one or more failed ones within the same user turn (a user message resets it); `postFailureFullMissRequests` counts those that read nothing from the prompt cache on a prompt of at least 2048 tokens, and `postFailureFullMissInputTokens` sums their uncached prompt tokens (input plus cache writes). The token counts are the provider's usage report; attributing the cache miss to the preceding failure is an inference from the turn's sequence. Hosts older than this field omit it.

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

#### resolve_path

Resolve a path from a message to the file it means, with the same rule the TUI uses for links. A relative `path` is tried against the session's working directory first, then the project root (the nearest ancestor of the working directory holding `.git`, else the nearest project marker); the first candidate that exists wins. An absolute path or `~/...` is only resolved. The answer is the realpath (symlinks and `..` resolved). It says which file a link means, not whether a client may read it.

```json
{"type": "resolve_path", "path": "docs/plan.md"}
```

Response when a candidate exists (`kind` is `file` or `directory`; `base` is `cwd`, `project-root` or `absolute`):
```json
{
  "type": "response",
  "command": "resolve_path",
  "success": true,
  "data": {"status": "found", "realpath": "/repo/docs/plan.md", "kind": "file", "base": "project-root"}
}
```

When nothing is there, `tried` lists every candidate in order:
```json
{
  "type": "response",
  "command": "resolve_path",
  "success": true,
  "data": {"status": "not_found", "tried": ["/repo/packages/app/docs/plan.md", "/repo/docs/plan.md"]}
}
```

An empty `path` or one with a NUL byte answers `not_found` with no candidates; a non-string or longer than 4096 characters is a payload error.

#### memory_report

Write a per-layer memory report for this session on demand. Available only when the host process runs with `SENPI_MEMORY_REPORT=1`; without it nothing is installed and the request fails with `memory_report_disabled`. On POSIX the same report is also written when the process receives `SIGUSR2`, for every live session registered in that process: a TUI, print, or single-session RPC host, or a multi-session host with the in-process runtime (`--listen`, the shared daemon default), reports all of its sessions. On a worker-runtime multi-session host (the stdio default), sessions live in worker isolates the signalled main isolate cannot see, so the signal writes nothing; send the `memory_report` request to each session instead. Nothing runs on a timer.

```json
{"type": "memory_report"}
```

Response:
```json
{
  "type": "response",
  "command": "memory_report",
  "success": true,
  "data": { "path": "/path/to/session-artifacts/memory/2026-10-02T11-30-00.000Z.json" }
}
```

The file is written to `<session>-artifacts/memory/<iso>.json` beside the session file and holds:

- `main`: the process's main-thread memory: `jscHeapSize` (Bun only), `heapUsed`, `external`, and `footprint` (`bytes`, `measure`).
- `kernels`: every live eval kernel in the process with `language`, `measure` (`heap` or `footprint`), `lastLiveBytes`, and `stale: true` when a cell was running so the reading predates the cell.
- `residentStore`: `entries` and `approxBytes` of the session's in-memory resident strings.
- `tuiRenderCache` (terminal UI only): `components`, `cachedLines`, `images` across live tool cards.
- one object per extension memory reporter, under its registered name (for example `taskChildren`), and `reporterErrors` for reporters that threw.

With `SENPI_MEMORY_REPORT_SNAPSHOT=1` a heap snapshot of the main thread is written beside the report and `data.heapSnapshot` (and the report's `heapSnapshot`) names it. A report that cannot be written answers `memory_report_failed: <reason>`, logs one stderr line, and leaves the session running.

#### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

#### switch_session

Load a different session file. Can be cancelled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.jsonl", "cwdOverride": "/path/to/project"}
```

`cwdOverride` is optional. When supplied, the replacement session and its cwd-bound settings and runtime state are rebuilt for that directory instead of using the session file's stored cwd. The host also resolves `projectTrusted` from its saved project trust store for the replacement cwd; an absent or false decision keeps project-scoped settings and resources disabled.

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension cancelled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

#### fork

Create a new fork from a previous user message on the active branch. Can be cancelled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension cancelled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": true}
}
```

#### navigate_tree

Move the session leaf to another point in the tree without creating a new file: the RPC equivalent of `/tree` (see [Branching with `/tree`](sessions.md#branching-with-tree)). Nothing is deleted; the branch you leave stays in the file. Emits `session_before_tree` (cancellable) and `session_tree`.

The target is addressed in one of two ways. Send exactly one of them; a request with both, or neither, is refused.

**`entryId`: select like the TUI by default.** Unless `intent: "resume"` is supplied, the host applies the `/tree` selection rule from [Selection Behavior](sessions.md#selection-behavior), so a client never computes a parent id:

- A user or custom message moves the leaf to that entry's **parent** and returns the entry's text as `editorText`, the text the TUI would put back in the editor for you to edit and resubmit.
- Any other kind (assistant, tool, compaction, ...) moves the leaf **to** the entry. No `editorText`.
- The root user message resets the leaf to an empty conversation. `leafId` is `null` and `editorText` carries the original prompt.

```json
{"type": "navigate_tree", "entryId": "u2", "expectedLeafId": "a3"}
```

Response:

```json
{"type": "response", "command": "navigate_tree", "success": true, "data": {"outcome": "navigated", "leafId": "a1", "editorText": "Let's try approach A..."}}
```

Other outcome: `{"outcome": "cancelled", "leafId": "...", "aborted": true}` when an extension cancelled the navigation or the summary was aborted. With a summary, `summaryEntryId` names the new `branch_summary` entry.

**`targetId`: select with the legacy response.** The original spelling, kept for the TUI and every shipped client. It applies the same selection rule as `entryId`: user/custom messages select their parent and return `editorText`, other entries select themselves, and the root user message resets the leaf to `null`. The difference is the response shape, not where selection moves the leaf: `targetId` answers the legacy payload, while `entryId` answers the richer `outcome`-tagged payload.

```json
{"type": "navigate_tree", "targetId": "u2", "expectedLeafId": "a3"}
```

Response:

```json
{"type": "response", "command": "navigate_tree", "success": true, "data": {"cancelled": false, "leafId": "a1", "editorText": "Let's try approach A..."}}
```

`editorText`, `aborted` and `summaryEntry` (the full `branch_summary` entry) appear on this shape when they apply. With either spelling, selecting a user/custom message that is already the current leaf still moves to its parent and returns its text. In particular, retrying the most recent prompt removes it from the active context before resubmission; selecting a root prompt leaves an empty conversation.

**`intent: "resume"`: resume the exact leaf.** With either address, this explicitly moves the leaf **to the requested entry itself**, including a user, root user, or custom message. No `editorText` is returned: no prompt is being selected for editing. Use this to switch back to an edit-only branch whose tail is the edited user message. Resuming the current leaf keeps it in place. No turn starts, no entry is copied, and the abandoned branch remains intact. The address still determines only the response shape.

```json
{"type": "navigate_tree", "entryId": "edited-u2", "intent": "resume", "expectedLeafId": "a3"}
```

Response:

```json
{"type": "response", "command": "navigate_tree", "success": true, "data": {"outcome": "navigated", "leafId": "edited-u2"}}
```

Using `targetId` with the same intent instead returns `{"cancelled": false, "leafId": "edited-u2"}`. Omitting `intent`, or specifying `"select"`, preserves the released retry-selection behavior and payloads described above; changing address alone never requests resumption.

Resumption uses the same core navigation lifecycle, cancellation, streaming guard, and summary generation. When `summarize` or `label` is supplied, their entries are still recorded, but the active leaf stays on the requested entry rather than the generated metadata. A summary is stored as a child of that entry and returned through `summaryEntryId` / `summaryEntry`; it is not part of the resumed active context. Labels remain visible on the tree. Metadata appended by lifecycle handlers is preserved too, without replacing the exact leaf when navigation returns.

Options, common to both spellings:

- `intent` (optional): `"select"` (default) or `"resume"`. Any other value is refused before navigation rather than silently selecting a prompt.
- `expectedLeafId` (optional): the leaf you last observed (from `get_tree`, `get_entries`, or the `entry_appended` stream). Forwarded unchanged for either intent, including an empty string. When the session's current leaf differs, the command fails with `errorCode: "stale_leaf"` before anything is written, so a client with a stale view can't move a conversation another client already moved.
- `summarize` (optional): summarize the abandoned branch and attach the summary at the new position, as described under [Branch Summaries](sessions.md#branch-summaries). Requires a model.
- `customInstructions` (optional): extra guidance for the summary. With `replaceInstructions: true` it replaces the default summarization prompt instead of extending it.
- `label` (optional): a label to set on the new position.

`leafId` is present on every success payload of either spelling and is `null` when the session was left on an empty conversation. Read it back rather than predicting the leaf: one round trip resynchronizes a client.

Navigation failures for either address and either intent carry a typed `errorCode`:

| `errorCode` | Meaning |
|-------------|---------|
| `streaming` | A response is in flight; retry once the turn ends |
| `not_found` | No entry with that id |
| `stale_leaf` | `expectedLeafId` no longer matches the session leaf |

The human-readable `error` text is also retained for older clients. Malformed addressing or intent is refused with `error` text and the current `errorData.leafId`, without a typed `errorCode`.

#### edit_assistant_message

Replace an assistant response with an edited copy. The session leaf moves to the target entry's parent and the edited copy is appended there as the new leaf, so the original response and everything after it stay in the file on an abandoned branch. The copy keeps only the new text (tool calls and thinking blocks are dropped; `stopReason` is `stop`) and preserves the original's model, provider and usage. Emits `session_before_tree` (cancellable) and `session_tree` like tree navigation.

```json
{"type": "edit_assistant_message", "entryId": "abc123", "text": "The corrected answer.", "expectedLeafId": "def456"}
```

- `expectedLeafId` (optional): the leaf you last observed (from `get_tree`, `get_entries`, or the `entry_appended` stream). When the session's current leaf differs, the command fails with `errorCode: "stale_leaf"` before anything is written - this is how a client with a stale view is refused instead of overwriting a conversation another client moved. The check runs before the unchanged comparison, so identical text still reports `stale_leaf` from a stale client.
- `summarize` / `customInstructions` (optional): summarize the abandoned branch like `navigate_tree`. With a summary, the edited copy's parent is the new `branch_summary` entry (its id is returned as `summaryEntryId`).

Response:

```json
{"type": "response", "command": "edit_assistant_message", "success": true, "data": {"outcome": "edited", "entry": {"type": "message", "id": "ghi789", "parentId": "u1", "message": {"role": "assistant", "content": [{"type": "text", "text": "The corrected answer."}]}}, "leafId": "ghi789"}}
```

Other outcomes: `{"outcome": "unchanged", "leafId": "..."}` when the text matches the original (nothing written) and `{"outcome": "cancelled", "leafId": "...", "aborted": true}` when an extension cancelled the navigation or the summary was aborted.

Failures carry a typed `errorCode`:

| `errorCode` | Meaning |
|-------------|---------|
| `streaming` | A response is in flight; retry once the turn ends |
| `not_found` | No entry with that id |
| `not_assistant` | The entry is not an assistant message |
| `empty` | The replacement text is blank |
| `stale_leaf` | `expectedLeafId` no longer matches the session leaf |

Message identity: RPC mode emits `entry_appended` right after every persisted `message_end`, carrying the full session entry (`entry.id`, `entry.parentId`, `entry.message`). Clients should record `entry.id` from that stream as the identity of each rendered message instead of inferring it by position, and pass it as `entryId` here.

#### continue_from_leaf

Start a new turn from the session's current leaf without a new user prompt. A typical use is after `edit_assistant_message`: the agent carries on from the edited answer as if it were its own words. Default models do not accept a request that ends with an assistant message, so the turn is driven by a hidden custom message (`customType: "continue-from-leaf"`, `display: false`). It is persisted, but clients must never render it. Only hosts that advertise the `continue_from_leaf` capability in `get_protocol_info` accept this command.

```json
{"type": "continue_from_leaf"}
```

Response (the turn then streams like any other):

```json
{"type": "response", "command": "continue_from_leaf", "success": true}
```

Failures carry a typed `errorCode`:

| `errorCode` | Meaning |
|-------------|---------|
| `streaming` | A response is in flight; retry once the turn ends |
| `nothing_to_continue` | The session has no messages yet |
| `leaf_not_assistant` | The conversation ends on a user message (for example an edited prompt): there is no answer to continue. Send or retry it instead |

A provider error during the continued turn is reported through the usual turn events, as for a prompt.

#### edit_user_message

Replace a user message with an edited copy, in place. This is the `/tree` flow for selecting a prompt (see [Selection Behavior](sessions.md#selection-behavior)) with the edited text written into the session instead of into an editor: the leaf moves to the target's parent and the edited copy is appended there as the new leaf. The original prompt and every reply after it stay in the file on an abandoned branch. Nothing is deleted.

The copy keeps the new text, trimmed, and carries every non-text block of the original (images, attachments) over verbatim. Those are the user's own input and the model still needs them.

No turn starts. After the call the active tail is a prompt with no reply; send `prompt`, or continue however your client normally runs a turn, when you want one. Emits `session_before_tree` (cancellable) and `session_tree` like `navigate_tree`.

```json
{"type": "edit_user_message", "entryId": "u2", "text": "Let's try approach C instead.", "expectedLeafId": "a3"}
```

- `expectedLeafId` (optional): the leaf you last observed (from `get_tree`, `get_entries`, or the `entry_appended` stream). When the session's current leaf differs, the command fails with `errorCode: "stale_leaf"` before anything is written. The check runs before the unchanged comparison, so identical text still reports `stale_leaf` from a stale client.
- `summarize` / `customInstructions` (optional): summarize the abandoned branch like `navigate_tree`. With a summary, the edited copy's parent is the new `branch_summary` entry (its id is returned as `summaryEntryId`).

Response:

```json
{"type": "response", "command": "edit_user_message", "success": true, "data": {"outcome": "edited", "entry": {"type": "message", "id": "u4", "parentId": "a1", "message": {"role": "user", "content": [{"type": "text", "text": "Let's try approach C instead."}]}}, "leafId": "u4"}}
```

Other outcomes: `{"outcome": "unchanged", "leafId": "..."}` when the text matches the original (nothing written) and `{"outcome": "cancelled", "leafId": "...", "aborted": true}` when an extension cancelled the navigation or the summary was aborted. `leafId` is reported on every outcome and is `null` when the session was left on an empty conversation.

Failures carry a typed `errorCode`:

| `errorCode` | Meaning |
|-------------|---------|
| `streaming` | A response is in flight; retry once the turn ends |
| `not_found` | No entry with that id |
| `not_user` | The entry is not a user message |
| `empty` | The replacement text is blank |
| `stale_leaf` | `expectedLeafId` no longer matches the session leaf |

Message identity: as with `edit_assistant_message`, record `entry.id` from the `entry_appended` stream as the identity of each rendered message and pass it as `entryId` here. Don't infer it by position; after an edit the positions on screen no longer match the file.

#### clone

Duplicate the current active branch into a new session at the current position. Can be cancelled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension cancelled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

#### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

#### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor (an id that names no entry is refused with `errorCode: "not_found"`):
```json
{"type": "get_entries", "since": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456"
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

**Pages.** One answer travels as one line on the connection's event queue, which closes the connection past 64 MiB. Pass `limit` (entries) and/or `maxBytes` (serialized bytes, capped at 48 MiB; 8 MiB when only `limit` is given) to read a long history in pages. A paged answer carries `hasMore`, and `nextSince` (the last entry id it returned) while more entries follow; ask again with `since: nextSince` until `hasMore` is `false`. A page always holds at least one entry, so it always moves forward. Both bounds must be positive integers, otherwise the request fails with `errorCode: "invalid_argument"`.

```json
{"type": "get_entries", "limit": 500, "maxBytes": 8388608}
{"type": "get_entries", "limit": 500, "maxBytes": 8388608, "since": "<nextSince>"}
```

An unpaged request (neither bound) answers exactly as before while the whole history fits in 48 MiB. A longer history is refused with `errorCode: "response_too_large"` instead of an answer that would close the connection; read it in pages.

**Tail pages** (capability `entries_tail`). Pass `tail` (a positive integer) to read the NEWEST entries first: the answer holds the newest `tail` entries of the range, in append order, under the same `maxBytes` rule (8 MiB when only `tail` is given, capped at 48 MiB), and always at least the newest one. While older entries remain it carries `hasMore: true` and `next_before`, the id of the oldest entry it returned; ask again with `before: next_before` to walk back until `hasMore` is `false`. `before` (an entry id) limits any read to entries strictly before it; an id that names no entry is refused with `errorCode: "not_found"`. `since` is unchanged, and `since` and `before` may bound one range together. `tail` and `limit` cannot be combined (`invalid_argument`): `limit` pages forward from the range's start, `tail` backward from its end.

```json
{"type": "get_entries", "tail": 200, "observe": true}
{"type": "get_entries", "tail": 200, "before": "<next_before>", "observe": true}
```

`get_entries` and `get_state` may carry `observe: true`: on a host such a read never counts as an attachment (see the idle-exit window).

A single entry larger than 48 MiB cannot travel in any answer, so a read whose next entry is that large (paged or not) is refused with `response_too_large` naming the entry. While a walk has more pages, the host keeps the session's full history in memory for the next page; it lets it go 30 s after the last page request, so a client that stops mid-walk does not pin the history.

#### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. A well-formed session has a single root; orphaned entries (broken parent chain) also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

#### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

Returns `{"text": null}` if no assistant messages exist.

#### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `senpi --mode rpc` process.

#### record_user_activity

Reports that the user started typing a draft in this session's composer (capability `user_activity`). It feeds the same first-activity signal the interactive editor sends, so a session with prompt-cache keep-alive enabled and an eligible model warms the first turn's prefix once while the user is still typing. Repeated reports are no-ops after the first, and nothing is sent to a provider when keep-alive is disabled or the model is ineligible. Only `kind: "draft"` is accepted: prompt activity is recorded by the prompt itself, and any other kind is refused with `invalid_argument` and the fixed message `record_user_activity: kind must be "draft"` (the refusal never repeats the value the client sent). On a multi-session host the command is session-scoped and passes the session-writer guard, so a session held by another writer answers `session_held`. It requires the connection to be attached to the session, as every session command does (see Attachment admission).

```json
{"type": "record_user_activity", "sessionId": "rpc-1", "kind": "draft"}
```

Response:
```json
{
  "type": "response",
  "command": "record_user_activity",
  "success": true
}
```

#### wake

Runs the session's registered inbox drain once (multi-session hosts: session-scoped; terminal control endpoints: the endpoint's one session). See "Waking a host session (`wake`)".

```json
{"type": "wake", "sessionId": "rpc-1", "delivery_ids": ["d2"]}
```

Response:
```json
{
  "type": "response",
  "command": "wake",
  "success": true,
  "data": { "admitted": [{ "delivery_id": "d2", "kind": "started" }] }
}
```

`kind` is the admission outcome (`started`, `queued`, `steered`, `already_admitted`, `held_draft`, `turn_conflict`); `admitted` is `[]` when no drain is registered.

#### release_session

Multi-session hosts only. Hands the session to a runtime outside the host; see "Handing a session over (`release_session`)".

```json
{"type": "release_session", "sessionId": "rpc-1", "reason": "takeover"}
```

Response:
```json
{
  "type": "response",
  "command": "release_session",
  "success": true,
  "data": {
    "released": true,
    "session_path": "/path/to/session.jsonl",
    "attachments": 0,
    "dropped": { "deliveries": [], "user_messages": [] }
  }
}
```

`dropped` is non-empty only after `"interrupt": true` took queued input out of the session: redeliver the ids in `deliveries` to the next owner, and hand `user_messages` to the adopting client, which decides what to do with them (for example, resubmit them in order as queued prompts).

Refusals carry `error` = `turn_active` or `session_busy` with `errorData.busy` (pass `"interrupt": true` to abort the work first), `attached` with `errorData.attachments` (pass `"force": true`), `invalid_release_reason`, `release_unsupported`, `release_failed` (`errorData.detail`; the session stays hosted when its entry could not be written), `host_draining`, `session_closing` or `unknown_session`.

#### detach_connection

Multi-session hosts that advertise the `detach_connection` capability only. Meant as a connection's last request before it closes: the host releases every session attachment this connection holds and answers only after that, so another connection's next `list_sessions` no longer counts it. Closing the socket afterwards releases nothing more. The host does not refuse later requests on the connection; a later `open_session` attaches as usual.

```json
{"type": "detach_connection"}
```

Response:
```json
{"type": "response", "command": "detach_connection", "success": true, "data": {"deferred": []}}
```

`deferred` lists the sessions that still count this connection when the answer is sent:

- a session that is not retained, whose turn is still running, and of which this connection holds the last attachment. Releasing it would end the session and abort the turn, so the attachment is released when the turn settles.
- every session the connection holds while the host is draining; the drain releases them once their work settles.

While another attachment remains on a session, this connection's attachment is released before the answer, even mid-turn. The same applies when a connection simply closes.

`senpi host session` sends it before closing and waits at most 5 s; when no answer comes it prints one line and closes anyway. Against a host that does not advertise the capability it sends nothing and relies on the release at socket close.

### Commands

#### get_commands

Get the ordered command surface (extension commands, prompt templates, and skills). Extension and prompt rows are
invoked through `prompt` with `/name`; skill rows use `$name` or the compatibility form `/skill:name`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {"name": "session-name", "description": "Set or clear session name", "source": "extension", "syntax": "slash", "sourceInfo": {"path": "/home/user/.senpi/agent/extensions/session.ts", "source": "auto", "scope": "user", "origin": "top-level"}},
      {"name": "fix-tests", "description": "Fix failing tests", "source": "prompt", "syntax": "slash", "sourceInfo": {"path": "/home/user/myproject/.senpi/prompts/fix-tests.md", "source": "auto", "scope": "project", "origin": "top-level"}},
      {"name": "skill:brave-search", "description": "Web search via Brave API", "source": "skill", "syntax": "dollar", "sourceInfo": {"path": "/home/user/.senpi/agent/skills/brave-search/SKILL.md", "source": "auto", "scope": "user", "origin": "top-level"}}
    ]
  }
}
```

Each command has:
- `name`: Command identity without its leading invocation marker
- `description`: Human-readable description (optional for extension commands)
- `syntax`: Canonical marker clients should insert (`"slash"` for extension/prompt rows, `"dollar"` for skills)
- `source`: What kind of command:
  - `"extension"`: Registered via `pi.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `sourceInfo`: Provenance metadata for the owning resource (present for all sources, including extensions):
  - `path`: Absolute file path to the command source
  - `source`: Source identifier string (for example `"auto"` for auto-discovered locations, `"local"` for settings entries, `"cli"` for CLI paths, `"builtin"`, `"sdk"`, or a package source)
  - `scope`: `"user"`, `"project"`, `"temporary"`, or `"system"` (harness-provided: builtin and bundled extensions, command-line packages declaring `pi.system`, and what they contribute)
  - `origin`: `"package"` or `"top-level"`
  - `baseDir`: Base directory of the owning resource (optional)

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

#### get_loaded_surfaces

Get the extensions and MCP servers loaded by the active runtime. Skills remain available through `get_commands`, where each loaded skill is represented by one `source: "skill"` row.

An MCP server with a failed configuration reference reports `status: "degraded"`
and an optional `lastError` naming the field and failure reason, never the resolved
value. Other connection diagnostics also use `lastError` when present.
Every resolved reference value is treated as sensitive and redacted from outbound
text, even non-secret values such as paths and values from earlier rotations.
Values shorter than four characters are not redacted. Structured snapshots retain
their keys, numbers, booleans, nulls and array/object shape; redaction changes only
string values. For MCP secrets use `env.*` or `headers`, not `args[]`, whose
resolved values are visible in the server's process list.

```json
{"type": "get_loaded_surfaces"}
```

Response:

```json
{
  "type": "response",
  "command": "get_loaded_surfaces",
  "success": true,
  "data": {
    "extensions": [
      {
        "name": "my-extension",
        "path": "/home/user/.senpi/agent/extensions/my-extension.ts",
        "sourceInfo": {
          "path": "/home/user/.senpi/agent/extensions/my-extension.ts",
          "source": "auto",
          "scope": "user",
          "origin": "top-level"
        },
        "enabled": true
      }
    ],
    "mcpServers": [
      {
        "name": "filesystem",
        "toolCount": 12,
        "status": "connected",
        "authStatus": "unsupported"
      }
    ]
  }
}
```

Extension rows come directly from the session's loaded resource inventory, not from registered slash commands. A commandless extension therefore appears once, and an extension registering several commands is not duplicated. MCP rows come from the live session-owned MCP service and expose its current server state, listed tool count, and non-secret auth status.

In multi-session mode this is a session-scoped command and requires the routing `sessionId`.

### extension_request

Invoke a request handler registered by an extension through `pi.rpc.handle(name, handler)`:

```json
{
  "id": "req-42",
  "type": "extension_request",
  "name": "acme.job.cancel",
  "data": {
    "jobId": "job-42"
  }
}
```

Success returns the extension-owned structured value:

```json
{
  "id": "req-42",
  "type": "response",
  "command": "extension_request",
  "success": true,
  "data": {
    "cancelled": true
  }
}
```

The request `name` must resolve to exactly one handler in the active extension generation.
Unknown names, duplicate names, stale generations, handler failures, and empty names return the
normal `{ type: "response", success: false, error }` envelope. Senpi treats request and response
data as opaque; the owning extension and client must validate their payloads.

In multi-session mode this command requires the owning routing `sessionId`. The response receives
the same `sessionId`, and another session's extension handlers are never consulted.

## Events

Events are streamed to stdout as JSON lines during agent operation. Events do not generally include an `id` field; `bash_execution_update` includes the `id` of its originating `bash` command when one was provided.

### Event Types

| Event | Description |
|-------|-------------|
| `agent_start` | Agent begins processing |
| `agent_end` | One low-level agent run completes (may still be followed by retry, compaction, or queued continuations) |
| `agent_settled` | Agent run is fully settled; no automatic retry, compaction retry, or queued continuation remains |
| `turn_start` | New turn begins |
| `turn_end` | Turn completes (includes assistant message and tool results) |
| `message_start` | Message begins |
| `message_update` | Streaming update (text/thinking/toolcall deltas) |
| `message_end` | Message completes |
| `entry_appended` | A durable session entry was appended, including goal and engine self-stop custom entries |
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `tool_barrier_waiting` | A workspace-changing tool call started waiting on the turn's tool barrier (`id`, `toolCallId`, `toolName`) |
| `tool_barrier_expired` | The tool barrier's `deadlineMs` passed before a release; it opened by itself (`id`, `deadlineMs`) |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |
| `transcript_write_failed` | The session file refused a message of the running turn (`role`, `errorMessage`) |
| `extension_event` | Capability-gated extension-owned event (`extension_events` clients only) |
| `commands_changed` | Ordered command/skill candidate snapshot changed |
| `command_invocation` | Accepted extension-command or prompt-template invocation metadata |
| `skill_invocation` | Ordered explicit skill metadata after prompt expansion |
| `loaded_surfaces_changed` | Loaded skills, extensions, or MCP inventory changed; re-read `get_commands` and `get_loaded_surfaces` |
| `model_changed` | Active model changed (any source), with the thinking level in force afterwards |
| `model_change_cancelled` | A held model switch ended without applying: `origin` carries its source and optional `effectId`, `reason` is `superseded`, `context-budget` or `error`, and optional `detail` describes the failure |
| `service_tier_changed` | Effective service tier or fast-mode state changed |
| `session_closed` | Multi-session host: a routing handle ended. Optional `reason`: `client_close`, `idle_evicted`, `host_shutdown`, `replaced`, `handoff_parked`, `session_dir_removed`, `error` |
| `session_parked` | Multi-session host: a retained session was released to disk at the idle window (`sessionId`, `sessionPath`). Replaces `session_closed` for that handle |
| `host_stalled` | Multi-session host: the event loop was blocked past `SENPI_RPC_LOOP_LAG_ERROR_MS`, with the drift and the session/tool blamed for it |
| `host_memory_pressure` | Multi-session host: the memory footprint is above `SENPI_RPC_HOST_RSS_WARN_MB`, with RSS beside it and the live session count |
| `subscription_limits` | A subscription account reported new limit windows: `{ provider, account, windows, reportedAt }`, the same shape as one `get_subscription_limits` account; every connection hears it once per report |
| `host_trimmed` | Multi-session host: it collected (at zero sessions, or at 2 GB+ after a session-count drop), with the footprint before and after, the sessions still open and the pause |
| `session_opened` | Multi-session host: a session was created on this host (`sessionId`, `durableSessionId`, `sessionPath`, `kind`, `cwd`); a worker's reaches only attached connections and `subscribe_sessions` subscribers with `include_workers` |
| `session_status` | Multi-session host: a `subscribe_sessions` subscription's per-session status change; see [Session status stream](#session-status-stream-subscribe_sessions) |
| `session_closed` | Multi-session host: a routing handle ended, with an optional `reason` (`handoff_parked` = a generation handoff put the session back on disk; reopen it by `sessionPath`) |
| `session_parked` | Multi-session host: a retained session's handle was released while the session itself stays on disk (`{ sessionId, sessionPath }`); reopen it with `open_session { sessionPath }` |
| `session_replaced` | The live session was swapped by `new_session`, `switch_session` or `fork`, carrying the new `durableSessionId` |

Event types are additive: a client that does not recognise a type must ignore that record rather than fail. `model_changed`
and `service_tier_changed` were added after the initial protocol and are safe to ignore. `session_parked`, `host_stalled`,
`host_memory_pressure`, `host_trimmed` and `subscription_limits` are the same: ignore them if unknown. `session_closed.reason` is optional; ignore an unknown
value the same way.

### session_closed.reason

When a multi-session host ends a routing handle it may name why:

```json
{ "type": "session_closed", "sessionId": "rpc-1", "reason": "client_close" }
```

| `reason` | When |
| --- | --- |
| `client_close` | An attached client sent `close_session` |
| `idle_evicted` | The idle sweep ended a session that was not retained |
| `session_dir_removed` | The session's transcript directory was deleted and nothing can reopen it: the idle sweep ended it because no client held it (whatever the idle window), or a generation handoff drain ended it instead of parking it. No `sessionPath` |
| `host_shutdown` | The host process is exiting (SIGTERM, idle-exit, empty-host). A retained session is closed, not parked |
| `replaced` | The routing handle ended because the live session behind it was replaced |
| `handoff_parked` | A generation handoff drained this host; reopen with `open_session { sessionPath }` |
| `released` | `release_session` handed the session to a runtime outside this host. Carries `sessionPath`, the file that runtime now writes: do NOT reopen it here |
| `error` | The session failed (worker death, output overflow) and the host sealed it |

The field is absent on older hosts and on older records. Decoders must not require it. A retained session that hits the
idle window emits `session_parked` instead of `session_closed`.

### session_parked

```json
{ "type": "session_parked", "sessionId": "rpc-1", "sessionPath": "/path/to/session.jsonl" }
```

The routing handle is gone; the session file is not. `open_session { sessionPath }` opens it as a new handle.

### host_stalled

```json
{ "type": "host_stalled", "driftMs": 6120, "sessionId": "rpc-1", "tool": "bash" }
```

Informational. The host does not abort or refuse anything because of a stall. `sessionId` and `tool` are omitted when
the stall cannot be attributed to a session.

### host_memory_pressure

```json
{ "type": "host_memory_pressure", "rssMb": 4910, "footprintMb": 4608, "measure": "phys_footprint", "sessions": 12 }
```

Informational. Capacity is memory, never a refusal: the host reports the pressure and parks idle sessions sooner.
`footprintMb` is the number compared with the threshold and `measure` names its kernel counter (`phys_footprint`,
`rss_anon`, `private_usage`, or `rss` where none is readable); `rssMb` is what `ps` shows and can stay high after
the memory was returned. Hosts released before senpi#2261 send `rssMb` and `sessions` only.

### host_trimmed

```json
{ "type": "host_trimmed", "footprintBeforeMb": 442, "footprintAfterMb": 237, "measure": "phys_footprint", "collected": true, "sessions": 0, "pauseMs": 41 }
```

Informational, at most once a minute: the host's last session closed, or a 2 GB+ host's session count dropped
(`sessions` above 0), and it ran one full collection that blocked the loop for `pauseMs`. `collected` is
`false` where the runtime exposes none (Node without `--expose-gc`); the record is still sent, with the two readings.

### model_changed

Emitted after the session's active model changed, whatever caused it: a `set_model` or `cycle_model` command, a slash
command, a retry fallback, or a session restore.

```json
{
  "type": "model_changed",
  "model": {"provider": "chatgpt-subscription", "id": "gpt-5.6-sol", "...": "..."},
  "thinkingLevel": "xhigh",
  "source": "cycle"
}
```

`model` is a full [Model](#model) object. `thinkingLevel` is the level in force **after** the switch — each model
remembers its own level, so this is that model's restored level (clamped to what it supports), not the level the
previous model was using. `source` is one of `"set"`, `"cycle"`, `"restore"`, `"fallback"`, or `"fallback-revert"`.

Clients that previously inferred the active model from `entry_appended` records can consume this instead.

### service_tier_changed

Emitted when the tier requests would carry, or the fast-mode indicator, changes — a `set_fast_mode` command, the
`/fast` slash command, or a model switch that resolves a different tier.

```json
{"type": "service_tier_changed", "tier": "priority", "fastMode": true}
```

`tier` is omitted when no tier applies. The pair matches `get_state.serviceTier` / `get_state.fastMode`.

### extension_event

Emitted when an extension calls `pi.rpc.emit(name, data)` and the client advertised
`extension_events`:

```json
{
  "type": "extension_event",
  "name": "acme.job.updated",
  "data": {
    "jobId": "job-42",
    "status": "running"
  }
}
```

`name` is extension-owned and `data` is opaque to Senpi. Consumers should validate the payload for
the specific event name before applying it. In multi-session mode the record also includes the
routing `sessionId`; delivery preserves the owning session and per-session event order.

The terminal builtin emits `terminal_monitor_state` on this path whenever the active monitor set
changes. `data` is `{ activeCount, monitors }`, where each monitor entry has `id`, `description`,
`paused`, and `startedAtMs`. The matching in-process `pi.events` channel is unchanged and is not
forwarded. Clients receive the wire record only when they advertise the `extension_events`
capability:

```json
{
  "type": "extension_event",
  "name": "terminal_monitor_state",
  "data": {
    "activeCount": 1,
    "monitors": [
      {
        "id": "bash_1",
        "description": "watch checks",
        "paused": false,
        "startedAtMs": 1710000000000
      }
    ]
  }
}
```

### agent_start

Emitted when the agent begins processing a prompt.

```json
{"type": "agent_start"}
```

### agent_end

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow. A run stopped because its session was replaced also carries `abortCause: { kind: "session_replaced", reason, targetSessionFile?, targetSessionId? }` (see `session_replaced`); extensions' own `agent_end` does not carry it, they learn of the replacement from `session_shutdown`.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

When the run ended with a provider error (the last assistant message has `stopReason: "error"`), `agent_end` also carries `failure`; it is absent on success and on abort:

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false,
  "failure": {
    "category": "rate_limit",
    "provider": "anthropic",
    "httpStatus": 429,
    "code": "rate_limit_error",
    "reason": "the provider is rate limiting requests",
    "action": "retry later or set a fallback model"
  }
}
```

`failure` is built only from the failed message's structured `providerDiagnostic`, never from `errorMessage` text. `httpStatus` and `code` are copied from it when present. Every category carries a `reason` and an `action`:

| `category` | `action` |
| --- | --- |
| `auth` | re-authenticate the provider |
| `rate_limit` | retry later or set a fallback model |
| `quota` | check the plan or credits |
| `context_limit` | compact or shorten the conversation |
| `invalid_request` | report it with the code |
| `provider_unavailable` | retry or switch provider |
| `network` | check connectivity |
| `unknown` | retry once; if it repeats, switch the model or report the code |

`unknown` is used when the error carries no diagnostic or its metadata matches no row; its `reason` names the provider and the code or status, for example `the provider returned an error that could not be classified (openai, status 429)`. A bare 429 stays `unknown` because status alone cannot tell a rate limit from exhausted quota. Retry and fallback decisions do not read `failure`.

### agent_settled

Emitted after the full session-level run settles. At this point senpi will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

A multi-session host that closes, parks or releases a session mid-turn first publishes the settle that turn will now
never write, with `"reason": "session_closed"`, on the same broadcast as every `agent_settled`: whoever counted the
`agent_start` (the supervisor's idle-exit observer included) sees it end. Older hosts never send `reason`.

### entry_appended: goal and engine stops

`entry_appended` carries the full durable session entry in `entry`. For `entry.type: "custom"`, self-stops use these `entry.customType` values:

- `goal-continuation-stopped`: `entry.data` contains `goalId`, `reason` (`stale`, `repetition`, `cap`, `no-progress`, `length-exhausted`, or `context-overflow`; older sessions may carry the retired `unattended`), `consecutiveContinuations`, `unattendedContinuations`, `noProgressContinuations`, and `at`.
- `engine-paused`: `entry.data` contains `reason` (`repetition`, `goal-repeat`, `cap-per-message`, `cap-per-minute`, or `goal-stale`), `at`, and optional `rule`, `customType`, and `count`.

`at` is epoch milliseconds. These records survive session reopen and are available through the session-entry history. A goal stop is historical: accepted user input or `/goal resume` resets the stop, rather than deleting the entry. See [Session File Format](session-format.md#goal-and-engine-self-stop-entries) for the reason mapping and stale measurement-window behavior. Existing limit/rule entries and UI notices are preserved.

### turn_start / turn_end

A turn consists of one assistant response plus any resulting tool calls and results.

```json
{"type": "turn_start"}
```

```json
{
  "type": "turn_end",
  "message": {...},
  "toolResults": [...]
}
```

### message_start / message_end

Emitted when a message begins and completes. The `message` field contains an `AgentMessage`.

```json
{"type": "message_start", "message": {...}}
{"type": "message_end", "message": {...}}
```

### message_update (Streaming)

Emitted during streaming of assistant messages. Contains a delta event without a cumulative message snapshot.

```json
{
  "type": "message_update",
  "usage": {
    "input": 100,
    "output": 1,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 101,
    "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}
  },
  "assistantMessageEvent": {
    "type": "text_delta",
    "contentIndex": 0,
    "delta": "Hello "
  }
}
```

The `assistantMessageEvent` field contains one of these delta types:

| Type | Description |
|------|-------------|
| `text_start` | Text content block started |
| `text_delta` | Text content chunk |
| `text_end` | Text content block ended |
| `thinking_start` | Thinking block started |
| `thinking_delta` | Thinking content chunk |
| `thinking_end` | Thinking block ended |
| `toolcall_start` | Tool call started (includes `id` and `toolName`) |
| `toolcall_delta` | Tool call arguments chunk |
| `toolcall_end` | Tool call ended (includes full `toolCall` object) |

Example streaming a text response:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_start","contentIndex":0}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":" world"}}
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world"}}
```

The top-level `usage` field contains the latest cumulative provider-reported usage. It may remain
zero until completion when a provider does not report usage during streaming.

Example starting a tool call:
```json
{"type":"message_update","usage":{...},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_abc123","toolName":"write"},"resolvedToolName":"write"}
```

`toolcall_start` and `toolcall_end` records carry a top-level `resolvedToolName`: the tool the call
will run, by the same rule the agent applies before executing it. A gateway-namespaced or recased
call such as `mcp__1a2b__Edit` streams with `toolName: "mcp__1a2b__Edit"` and `resolvedToolName: "edit"`;
an exact or unresolvable name reports itself. Title and render the call by `resolvedToolName`, which is
also the `toolName` of its `tool_execution_*` events.

`message_update` intentionally omits the former cumulative `message` field and
`assistantMessageEvent.partial`. Clients that need a live partial message must assemble it
from `message_start` and subsequent events using `contentIndex`. Treat `message_end.message`
as authoritative. For tool calls, `toolcall_start` provides the call `id` and `toolName`;
buffer `toolcall_delta.delta` for arguments. `toolcall_end.toolCall` contains the completed
call.

### bash_execution_update

Emitted once for each output chunk from a direct `bash` command. `id` matches the command's `id`, allowing clients to associate output with the correct command.

Events stream all output while the command runs, even if the final `bash` response's `output` is truncated.

```json
{
  "type": "bash_execution_update",
  "id": "req-1",
  "delta": "total 48\n"
}
```

### tool_execution_start / tool_execution_update / tool_execution_end

Emitted when a tool begins, streams progress, and completes execution.

```json
{
  "type": "tool_execution_start",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"}
}
```

During execution, `tool_execution_update` events stream partial results (e.g., bash output as it arrives):

```json
{
  "type": "tool_execution_update",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "args": {"command": "ls -la"},
  "partialResult": {
    "content": [{"type": "text", "text": "partial output so far..."}],
    "details": {"truncation": null, "fullOutputPath": null}
  }
}
```

When complete:

```json
{
  "type": "tool_execution_end",
  "toolCallId": "call_abc123",
  "toolName": "bash",
  "result": {
    "content": [{"type": "text", "text": "total 48\n..."}],
    "details": {...}
  },
  "isError": false
}
```

Use `toolCallId` to correlate events. The `partialResult` in `tool_execution_update` contains the accumulated output so far (not just the delta), allowing clients to simply replace their display on each update.

### queue_update

Emitted whenever the pending steering or follow-up queue changes.

```json
{
  "type": "queue_update",
  "steering": ["Focus on error handling"],
  "followUp": ["After that, summarize the result"]
}
```

### compaction_start / compaction_end

Emitted when compaction runs, whether manual or automatic.

```json
{"type": "compaction_start", "reason": "threshold"}
```

The `reason` field is `"manual"`, `"threshold"`, or `"overflow"`.

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

If `reason` was `"overflow"` and compaction succeeds, `willRetry` is `true` and the agent will automatically retry the prompt.

If compaction was aborted, `result` is `null` and `aborted` is `true`.

If compaction failed (e.g., API quota exceeded), `result` is `null`, `aborted` is `false`, and `errorMessage` contains the error description.

### auto_retry_start / auto_retry_end

Emitted when automatic retry is triggered after a transient error (overloaded, rate limit, 5xx).

```json
{
  "type": "auto_retry_start",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}"
}
```

```json
{
  "type": "auto_retry_end",
  "success": true,
  "attempt": 2
}
```

On final failure (max retries exceeded):
```json
{
  "type": "auto_retry_end",
  "success": false,
  "attempt": 3,
  "finalError": "529 overloaded_error: Overloaded"
}
```

### summarization_retry_scheduled / summarization_retry_attempt_start / summarization_retry_finished

Emitted when compaction or branch-summary summarization retries after a transient provider error. These events use the same retry settings as automatic assistant-turn retries.

```json
{
  "type": "summarization_retry_scheduled",
  "attempt": 1,
  "maxAttempts": 3,
  "delayMs": 2000,
  "errorMessage": "terminated"
}
```

```json
{
  "type": "summarization_retry_attempt_start",
  "source": "compaction",
  "reason": "threshold"
}
```

For branch summaries, `source` is `"branchSummary"` and no `reason` is present.

```json
{
  "type": "summarization_retry_finished"
}
```

### skill_invocation

Emitted once after one or more explicit skill tokens are expanded. `skills` preserves invocation order.
`syntax` reports the token form that selected the skill; `path` is the resolved `SKILL.md` path.

```json
{
  "type": "skill_invocation",
  "skills": [
    {
      "name": "debugging",
      "path": "/project/.agents/skills/debugging/SKILL.md",
      "syntax": "dollar"
    },
    {
      "name": "review",
      "path": "/project/.agents/skills/review/SKILL.md",
      "syntax": "slash"
    }
  ]
}
```

In multi-session mode the normal routing `sessionId` is added. This event does not mutate loaded
surfaces; clients continue to use `loaded_surfaces_changed` plus `get_loaded_surfaces` for MCP reveal.

### commands_changed

Emitted whenever a post-bind runtime reload changes the ordered command surface. The initial surface is available
through `get_commands` and does not emit this invalidation event. The `commands` payload has the same shape and
ordering as `get_commands`; identical snapshots are not re-emitted.

```json
{
  "type": "commands_changed",
  "commands": [
    {"name": "session-name", "source": "extension", "syntax": "slash", "sourceInfo": {"path": "/project/extensions/session.ts", "source": "auto", "scope": "project", "origin": "top-level"}},
    {"name": "skill:debugging", "source": "skill", "syntax": "dollar", "sourceInfo": {"path": "/project/.agents/skills/debugging/SKILL.md", "source": "auto", "scope": "project", "origin": "top-level"}}
  ]
}
```

### command_invocation

Emitted exactly once after the session resolves an extension command, or after a prompt template survives extension
input interception and prompt acceptance. Unknown, transformed, or rejected commands do not produce this event;
skills continue to use `skill_invocation`.

```json
{
  "type": "command_invocation",
  "command": {
    "name": "session-name",
    "source": "extension",
    "syntax": "slash",
    "sourceInfo": {"path": "/project/extensions/session.ts", "source": "auto", "scope": "project", "origin": "top-level"}
  }
}
```

### loaded_surfaces_changed

Emitted without a request id when the loaded skill, extension, or MCP inventory changes. A multi-session host sends one per connection per inventory change on either session runtime (in-process or worker isolate), tagged with the first session that reported that transition: sessions moving from the same digest to the same new one share a single event, while a session converging from a different start still announces its own change, because `get_commands` and `get_loaded_surfaces` are read per session. The event carries no inventory payload; clients re-read `get_commands` for skills and `get_loaded_surfaces` for extensions/MCP.

```json
{"type": "loaded_surfaces_changed"}
```

### transcript_write_failed

Emitted when the session file refuses to save a message of the running turn (permission denied, a full disk, a removed
session directory). The message is not in the transcript and will not be in a reloaded session. The next prompt that starts a run while the
session is idle leaves it out of the model context too; a steer or follow-up queued (`streamingBehavior`) during the
refused run still sends it to the model on its turn. A prompt accepted with `success: true` reports this failure only
through this event.

```json
{
  "type": "transcript_write_failed",
  "role": "assistant",
  "errorMessage": "EACCES: permission denied, open '/path/to/session.jsonl'"
}
```

### extension_error

Emitted when an extension throws an error.

```json
{
  "type": "extension_error",
  "extensionPath": "/path/to/extension.ts",
  "event": "tool_call",
  "error": "Error message..."
}
```

## OAuth login

Logins are fire-command-then-subscribe: the command answers as soon as the flow has started, and the URL plus the terminal result arrive as events.

- `login_start` `{provider}`: responds immediately with `success: true` (flow started). A second `login_start` for the same provider aborts the earlier attempt.
- `auth_login_url` `{provider, url}`: the URL (or device-code verification URL) the user must open.
- `auth_login_end` `{provider, success, error?, replaced?, backupPath?}`: exactly one per login; `error` is a non-secret message. When a successful login replaced the provider's credential of the other kind (an OAuth login over a stored API key), `replaced` names that kind (`"api_key"` or `"oauth"`) and `backupPath` is the copy of `auth.json` taken before it (absent when the credential store is not a file). A login of the same kind adds an account and carries neither field.
- `login_cancel` `{provider}`: aborts the in-flight login; the client then sees `auth_login_end` with `success: false`.

Some providers need input mid-flow (a pasted authorization code, a text or secret value, a choice between accounts). Those prompts reuse the extension UI dialog channel described in the next section:

- `text`, `secret`, and `manual_code` prompts arrive as an `extension_ui_request` with `method: "input"`. `title` is the provider's prompt message and `placeholder` is present when the provider supplied one.
- `select` prompts arrive with `method: "select"`; `options` holds the option labels.

Answer with `extension_ui_response` `{id, value}`. For `select`, `value` is the chosen label and is mapped back to the option id in-process. Sending `{id, cancelled: true}` cancels the login, and `auth_login_end` reports `success: false` with `error: "Login cancelled"`.

A client that never answers loses nothing. The browser/callback completion path still finishes the login, and the pending request is released when the login ends or is cancelled, so an open dialog never blocks completion. Secrets don't cross the wire in either direction: only the prompt message, placeholder, and labels are emitted, and the answer is consumed in-process and never echoed.

Example exchange (Anthropic, user pastes the code instead of finishing in the browser):

```jsonl
{"id": "login-1", "type": "login_start", "provider": "anthropic"}
{"id": "login-1", "type": "response", "command": "login_start", "success": true}
{"type": "auth_login_url", "provider": "anthropic", "url": "https://claude.ai/oauth/authorize?..."}
{"type": "extension_ui_request", "id": "uuid-7", "method": "input", "title": "Complete login in your browser, or paste the authorization code / redirect URL here:", "placeholder": "http://localhost:53692/callback"}
{"type": "extension_ui_response", "id": "uuid-7", "value": "<pasted code>"}
{"type": "auth_login_end", "provider": "anthropic", "success": true}
```

If the user completes the flow in the browser instead, the same `extension_ui_request` is emitted, no response is needed, and `auth_login_end` arrives on its own.

#### verify_api_key

Checks an API key with its provider before a client saves it. The key is used for one authenticated read of the provider's model list and is never stored, logged, or echoed. Hosts that support it advertise `auth_key_verify`.

```json
{"type": "verify_api_key", "provider": "openai", "key": "<key>"}
```

Response `data` is `{ok: true}` or `{ok: false, reason, status?}`:

- `rejected`: the provider answered 401 or 403.
- `unreachable`: no answer, a timeout, or a 5xx.
- `unsupported`: the key cannot be checked this way. Either the provider's API has no probe, the list is not where it was expected (another 4xx or 3xx), or the list answers any key (OpenRouter, keyless local servers). In that last case a 200 proves nothing, so the host also asks with a made-up key and reports `ok` only when that one is refused.
- `unknown-provider`: no model is configured for the provider.

#### login_api_key

Stores an API key for a provider. The response comes after the model registry has seen the key, so a client that re-reads `get_auth_providers` on it gets the new state.

```json
{"type": "login_api_key", "provider": "openrouter", "key": "<key>"}
```

A provider holds logins of one kind. If it had an OAuth login, the key replaces it: `auth.json` is backed up first, and the response `data` is `{replaced: "oauth", backupPath?}`, where `backupPath` is absent when the credential store is not a file (a failed backup fails the login instead). A key added over another key has no `data`.

`get_auth_providers` API-key rows carry `keyHint`, the last four characters of a literal key the app stored when it is at least 12 characters long. OAuth rows, `!command` and `$ENV` references, and short keys have none.

## Extension UI Protocol

Without presenter enforcement, MCP 2026-07-28 multi-round-trip form answering is terminal-only in v1.
RPC-originated modern requests advertise no elicitation and terminate locally
if input is required; they never fabricate a decline or retry incomplete input.
Client roles and capability declarations do not enable this form channel.
Existing legacy MCP dialogs and their RPC request/response shapes remain unchanged.

### Opt-in private MCP forms

A multi-session RPC host or interactive terminal can opt in with `--mcp-presenter-enforcement`. This is a
deployment option, not a project setting. It defaults to off; existing desktop and
gateway clients keep their current behavior until they implement the private
presenter protocol. Without this option, terminal forms retain their existing queue,
legacy origin rules, and legacy stderr diagnostics. Enforced terminal forms also
queue, and a collector failure ends only its own form, not the terminal's grant.
All UI contexts in one terminal session binding share its presenter authority.
Without enforcement, each real select/input answer retains its existing human
admission timing; the form collector does not add a second final admission.
Ephemeral selects also keep the scheduled `requestRender()` path without enforcement.
With enforcement, only the authority's winning whole-form action admits once.
The host advertises `mcp_form_presenter_v1` only when enforcement is enabled;
the capability reports protocol support, not authority to present or answer a form.

The public `host ensure` and `host handoff` commands accept the same deployment option,
separately from `--launch-spec`. Add `--mcp-presenter-fd 4` with a live inherited duplex
channel to enroll the launch owner of a new host. The runtime-selecting CLI re-exec,
supervisor and host child preserve that channel. The option alone enables enforcement,
not a presenter; fd 4 alone does not enable enforcement.

An enforcing predecessor keeps enforcement in its successor, including when an older
handoff caller omits the option. Conditional `handoff --when idle` carries the non-secret
`mcp_presenter_enforcement` boolean in `begin_handover`, independently of the launch
specification and environment. It uses only the existing authenticated owner's channel
for fresh successor enrollment; the CLI cannot enroll itself into the predecessor.
Reuse and already-current handover answers report the serving host's actual capabilities.
Neither a successful CLI exit nor an equal `runtimeBuildId` proves enforcement or
enrollment. A deployment requesting enforcement against an unenforced existing host must
coordinate a replacement, not force-restart another owner's busy host.

The native launch owner enrolls an Ed25519 public key through an inherited private
bootstrap channel. Descriptor 4 is reserved for this channel; descriptor 3 remains
the separate owner-lifetime channel. Enrollment and management proofs sign the
host's exact returned transcript. No secret is passed in an argument, environment
variable, launch specification, or session state. Reusing a host does not enroll the
caller, and a successor requires fresh enrollment and fresh grants.
An invalid or lost bootstrap channel leaves the host without a presenter; it does
not terminate the shared daemon or its lifetime channel. The helper remains lazy
to preserve the supervisor's startup import budget, with import and relay failures
contained at that boundary. Conditional idle handover
is owned by the running host after the CLI returns: that host relays the successor's
fresh challenge over the existing authenticated launch-owner channel. The CLI's
bootstrap stream is never serialized into `begin_handover`.

`mcp_presenter_context` returns the caller's current connection nonce and attachment
context. These identifiers confer no authority. Acquisition and revocation use the
separate authenticated management endpoint, with a fresh challenge for each
`mcp_presenter_assign`, `mcp_presenter_acquire`, or `mcp_presenter_revoke` command.
Enrollment alone assigns no sessions. Before acquisition, the trusted native
supervisor signs `mcp_presenter_assign` with `sessionId`, the current `bindingEpoch`,
and `purpose: "mcp_form"` for a session it opened, or one the user explicitly adopted
through the trusted host-owner UI. Ordinary RPC attachment cannot assign a session.
Assignment belongs only to that enrolled principal and live binding; re-enrollment
or binding replacement requires a new assignment. It is not persisted.
An acquisition also requires the connection's `interactive_user` and
`mcp_form_presenter_v1` capabilities, and binds the
current host, session, binding epoch, connection nonce, attachment ID and epoch, and
`purpose: "mcp_form"`. Only one holder is active for a session binding.
Concurrent forms, including worker-origin forms, wait in the host's abort-aware
FIFO for that holder. Waiting consumes the original deadline; timeout, cancellation,
or revocation before display never fabricates a human response.
Enforced legacy connections observe presenter readiness and reconnect when their
negotiated form capability becomes stale, including a grant issued after connect.
Revoking the last ready holder removes the capability on the new connection.
A shared physical connection advertises forms when at least one attached owner is
ready; each request still requires its own origin's grant. An ungranted owner cannot
borrow another owner's presenter. Readiness changes during initialization are
rechecked before the connection is published. Modern MRTR connections do not
reconnect for this purpose because their capability metadata is per request.

Legacy elicitation has no reliable parent tool-call identifier in the received SDK
handler metadata. With multiple `tools/call` operations in flight on one physical
legacy client, enforced elicitation fails closed with the same fixed JSON-RPC
processing error as an unavailable presenter: code `-32603`, message
`Elicitation processing unavailable`, and no `data`.
No form is displayed and no human answer is admitted. Without enforcement, legacy
clients keep the SDK request method, origin handling, and concurrent-call behavior.

Worker binding waits at most five seconds for the host's acknowledgement; expiry
fails with `private_form_unavailable`, removes the pending waiter, and releases any
late host binding. Worker readiness events feed the same legacy renegotiation path.
Under enforcement, server stderr remains available as redacted diagnostic records
with allowlisted system error codes. Arbitrary text is omitted because a server can
echo private messages, schema labels, or answers; ordinary legacy stderr is unchanged.

The granted connection receives `mcp_form_request` privately. Its envelope contains
`sessionId`, `bindingEpoch`, `attachmentEpoch`, `grantId`, `dialogId`, `dialogToken`,
and `formRevision`; the request also carries `server` (`label` and `source`),
`message`, `schema`, and `deadlineAtMs`. The presenter returns that exact envelope
with `mcp_form_presented` only after rendering, then `mcp_form_response` with
`action: "accept" | "decline" | "cancel"` and accepted `content` when applicable.
`mcp_form_sync` uses the current session, binding epoch, attachment epoch, and grant
to recover the holder's still-live form. It is not a public replay API.

Unknown and stolen-dialog submissions from a non-holder both return
`presenter_not_authorized` before private dialog lookup. The host validates a whole
form before admitting a human answer, and a synchronous terminal latch accepts only
one outcome. `mcp_form_resolved` carries the session, grant, dialog, and a reason:
`answered`, `declined`, `cancelled`, `processing_failed`, or `operation_aborted`.

No presenter, or loss before actual presentation, is a processing failure. Only
explicit human refusal produces decline. Dismissal after presentation is cancel;
host timeout or presentation loss after presentation also cancels, without human
admission. Operation abort terminates the operation. Private records, schemas,
tokens, drafts, and answers never enter general extension UI events, session
snapshots, replay, or ordinary output queues. Native desktop registration, WSL
relay, and a gateway form page require separate client implementation.

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`, `question`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The host owns the timer and clients mirror the `remainingMs` value from each request or update event.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setEditorComponent()`, `setToolsExpanded()`, `setHeader()`, and `setFooter()` are no-ops
- `setWidget()` forwards string-array widgets only; a component factory emits nothing
- `getEditorText()` returns `""`
- `getToolsExpanded()` returns `false`
- `pasteToEditor()` delegates to `setEditorText()` (no paste/collapse handling)
- `getAllThemes()` returns `[]`
- `getTheme()` returns `undefined`
- `setTheme()` returns `{ success: false, error: "..." }`

Note: `ctx.mode` is `"rpc"` and `ctx.hasUI` is `true` in RPC mode because the dialog and fire-and-forget methods are functional via the extension UI sub-protocol. Use `ctx.mode === "tui"` to guard TUI-specific features like `custom()` that require a real terminal.

### Extension UI Requests (stdout)

All requests have `type: "extension_ui_request"`, a unique `id`, and a `method` field.

#### select

Prompt the user to choose from a list. Dialog methods with a `timeout` field include the timeout in milliseconds; the agent auto-resolves with `undefined` if the client doesn't respond in time.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-1",
  "method": "select",
  "title": "Allow dangerous command?",
  "options": ["Allow", "Block"],
  "timeout": 10000
}
```

Expected response: `extension_ui_response` with `value` (the selected option string) or `cancelled: true`.

A permission prompt (title `Permission required: <permission>`) also carries `toolCallId`, the id of the tool call it approves, and `parentToolCallId` when another tool (for example a codemode script) issued that call. Clients bind the prompt to that call by id: the engine raises the prompts for every call of a message before any of them runs, so the order of `tool_execution_start` events does not say which call a prompt belongs to. The `input` that follows a "Deny with feedback" choice carries the same fields.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "select",
  "title": "Permission required: read\n\nPath: /project/a.txt\n\nPatterns:\n  - /project/a.txt",
  "options": ["Allow once", "Allow always", "Deny", "Deny with feedback"],
  "toolCallId": "call-a"
}
```

#### confirm

Prompt the user for yes/no confirmation.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-2",
  "method": "confirm",
  "title": "Clear session?",
  "message": "All messages will be lost.",
  "timeout": 5000
}
```

Expected response: `extension_ui_response` with `confirmed: true/false` or `cancelled: true`.

#### input

Prompt the user for free-form text.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-3",
  "method": "input",
  "title": "Enter a value",
  "placeholder": "type something..."
}
```

Expected response: `extension_ui_response` with `value` (the entered text) or `cancelled: true`.

#### editor

Open a multi-line text editor with optional prefilled content.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-4",
  "method": "editor",
  "title": "Edit some text",
  "prefill": "Line 1\nLine 2\nLine 3"
}
```

Expected response: `extension_ui_response` with `value` (the edited text) or `cancelled: true`.

#### notify

Display a notification. Fire-and-forget, no response expected.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-5",
  "method": "notify",
  "message": "Command blocked by user",
  "notifyType": "warning"
}
```

The `notifyType` field is `"info"`, `"warning"`, or `"error"`. Defaults to `"info"` if omitted.

#### setStatus

Set or clear a status entry in the footer/status bar. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-6",
  "method": "setStatus",
  "statusKey": "my-ext",
  "statusText": "Turn 3 running..."
}
```

Send `statusText: undefined` (or omit it) to clear the status entry for that key.

#### setSubagentCost

Report the USD the subagent tree under this session has spent, which the TUI footer shows after the session's own cost as `$0.380 (+1.270)`. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setSubagentCost",
  "costUsd": 1.27
}
```

`costUsd: undefined` (or omitted) clears it. A negative or non-finite figure is sent as `undefined`.

#### setWidget

Set or clear a widget (block of text lines) displayed above or below the editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-7",
  "method": "setWidget",
  "widgetKey": "my-ext",
  "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"],
  "widgetPlacement": "aboveEditor"
}
```

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Only string-array widgets are sent; a component factory needs a terminal to render into and produces no record.

A widget may carry `widgetActions`, a list of `{ "label", "command" }` choices (for example the handoff hint's `{ "label": "Start fresh with a handoff", "command": "/handoff" }`). A client that renders a choice as a button sends its `command` text as an ordinary `prompt` when the user picks it, so the choice runs the same command handler the terminal user types. The field is omitted when the widget has no choices and on a clear.

#### setTitle

Set the terminal window/tab title. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-8",
  "method": "setTitle",
  "title": "senpi - my project"
}
```

#### set_editor_text

Set the text in the input editor. Fire-and-forget.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-9",
  "method": "set_editor_text",
  "text": "prefilled text for the user"
}
```

#### question

Present one or more questions to the user. Requires the `question` client capability (advertised in `set_client_info`). Questions are broadcast to all attached connections, not just the requester. Pending questions survive the assistant message and are replayed to connections that attach later via `open_session` state.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-q1",
  "method": "question",
  "requestId": "ask-user-1",
  "toolCallId": "call_abc123",
  "waitForAnswer": true,
  "questions": [
    {
      "id": "q1",
      "header": "Database",
      "question": "Which database should I use?",
      "options": [
        { "label": "PostgreSQL", "description": "Relational" },
        { "label": "SQLite", "description": "Embedded" }
      ],
      "multiSelect": false
    }
  ],
  "timeout": 1800000,
  "askedAtMs": 1718000000000,
  "deadlineAtMs": 1718001800000,
  "remainingMs": 1799500
}
```

Expected response: `extension_ui_response` with `answers` (a map of question id to `{ selected: string[], text?: string }`) and an optional `comment`. Partial answers are allowed: the model is told which questions went unanswered, by header. Send `cancelled: true` to dismiss.

A multi-session host and a terminal control endpoint settle a `question` answer by one rule, so the same frame reaches the model as the same message on either surface:

- `cancelled: true` dismisses the question.
- Otherwise `answers` and `comment` are read; a `value` or `confirmed` in the same frame belongs to the other dialog methods and is ignored.
- A non-blank `comment` settles it `comment-submitted`: the model receives `The user responded: (see [The user's comment for question <id>] below)`, then any answered questions and the headers of the unanswered ones (`Unanswered: <header>, ...`), and the comment itself as a text block of its own after that. A frame that carries its text only as `comment` with `answers: {}` is a complete answer.
- The user's own words - the comment and any typed answer that is not one of the offered labels - never reach the model inside the tool result or beside the `[Answer to question <id>]` label: the text refers to each by its label (`(see [The user's comment for question <id>] below)`, `(see [The user's answer to <header> for question <id>] below)`), and each word follows as a text block after a block holding that label - after the batch's tool results for a blocking call (rebuilt from the persisted result's `details.userWords` on every request), or after the frame block of a later answer.
- Without a comment, any entry in `answers` settles it `answered`.
- Neither a non-blank comment nor an answer is refused `question_incomplete`, and the question stays pending.

A terminal refuses a frame whose `answers` is missing or malformed with `invalid_response`.

While the question is open, the client may send `extension_ui_progress` frames with draft `answers` and `comment`. Each progress frame resets the idle timer; the host emits `question_updated` with the refreshed `deadlineAtMs` and `remainingMs`.

When the question resolves (answered, comment-submitted, timed_out, or cancelled), the host broadcasts `question_resolved` to all connections:

```json
{
  "type": "question_resolved",
  "id": "uuid-q1",
  "requestId": "ask-user-1",
  "toolCallId": "call_abc123",
  "outcome": "answered",
  "resolvedBy": "rpc_connection",
  "answers": { "q1": { "selected": ["PostgreSQL"] } },
  "comment": "",
  "unanswered": []
}
```

A late answer after resolution receives a `question_already_resolved` error.

`resolvedBy` identifies the surface that submitted the winning answer: `local_ui` for the terminal
widget or composer, `rpc_connection` for an RPC client (including the sequential dialog fallback),
and `control_endpoint` for an answer received through the session's terminal control endpoint.
It is omitted for `timed_out` and `cancelled`, the frame's outcomes with no answering surface.
Restart orphaning and unavailable UI never reach `question_resolved` with their own status: an
extension that aborts the dialog for either is reported to connections as `cancelled`, and only the
tool result and the `ask-user:closed` extension event carry the true status. Clients do not supply
this field; the answering bridge sets it. Competing or late answers do not change the winner's surface.

The built-in `ask_user_question` and `request_user_input` tools retain the field in blocking
`tool_execution_end` result details and in the `response` of `ask-user:settled`. Extensions can
subscribe to `pi.events.on("ask-user:closed", handler)` for `{ requestId, status, resolvedBy? }`,
emitted once for every terminal outcome, including silent cancellations. `ask-user:settled`
continues to skip cancellation. A reload that preserves a pending question does not close it;
a terminal outcome while detached is published once through the next bound extension runner.

`RpcSessionState.pendingQuestions` (returned by `open_session` and `get_state`) lists any questions still waiting for an answer. Connections that attach after the question was asked receive the pending record immediately.

`RpcSessionState.pendingDialogs` lists the still-open select, confirm, input and editor request frames, including requests that remain live across `new_session`, `switch_session`, `fork`, `clone` and `import_jsonl`. The array is empty once all dialogs are resolved, cancelled or timed out. Clients recovering from a gap can restore these dialogs and remove dialogs absent from this authoritative snapshot.

Clients without the `question` capability get a sequential fallback: one `select` per question (options plus "Other (type an answer)", which asks one `input` for that question's typed answer). No comment prompt follows the last question. The result maps back to the same `QuestionResponse` without a `comment`: `answered` when at least one question was answered (the others listed in `unanswered`), `cancelled` when none was. An abort of the question's signal opens no further dialog and settles `cancelled` (or `timed_out` when the abort reason is `"timed_out"`), never `answered`, keeping the answers given before it.

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`, `question`).

A response carries two ids:

- `uiRequestId` names the `extension_ui_request` being answered (its `id`).
- `id` is the response frame's own correlation id; the reply echoes it.

Without `uiRequestId`, `id` names the request too. That short form is what the examples below use and
what every older client sends; it keeps working unchanged.

Every response a multi-session host or a terminal control endpoint settles gets exactly one reply,
carrying the frame's `id`:

```json
{"id": "answer-1", "type": "response", "command": "extension_ui_response", "success": true}
```

`success: true` means the answer resolved a pending request. A refusal carries the same `id` and an
`error`: on a host `question_incomplete` (a `question` answer with neither answers nor a comment),
`question_already_resolved` (a late answer) or `unknown_extension_ui_request` (no request of that
session has that id); on a terminal `unknown_request`, `question_incomplete` or `invalid_response`. A single-session stdio
connection answers every response it resolves the same way, and ignores one that matches none of its
requests. A client may still fire and forget: the reply is an ordinary `response` record.

```json
{"type": "extension_ui_response", "id": "answer-1", "uiRequestId": "uuid-1", "value": "Allow"}
```

#### Value response (select, input, editor)

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

#### Confirmation response (confirm)

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

#### Cancellation response (any dialog)

Dismiss any dialog method. The extension receives `undefined` (for select/input/editor) or `false` (for confirm).

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

### UI-answer receipts and dialog observation

With capability `ui_answer_ledger`, `extension_ui_response` accepts an optional `answerId` string of 1-256 characters. The response preserves the frame's correlation `id` and adds `disposition`:

- `applied`: success; the pending request was settled once.
- `replay`: success; this `(uiRequestId, answerId)` pair was already applied, with no repeated delivery.
- `already_answered`: failure; the request was already settled with a different answer id.
- `unknown`: failure; no pending request or receipt exists (`unknown_extension_ui_request`).

A malformed answer (for example `invalid_answer_id` or `question_incomplete`) is refused without a `disposition` and leaves its request pending. A single-session stdio connection still ignores an unnamed response that matches no request; a named response always gets a reply.

`get_state.answeredUiRequests` contains the latest 64 receipts, oldest first, as `{uiRequestId, answerId?}`. Receipts are session-local and memory-only, retained for that session's life in the host generation. The ledger evicts FIFO beyond 1,024 requests; replay does not extend retention. Omitting `answerId` keeps the short-form answer contract but provides no named replay identity. A restart, unloaded session, or evicted receipt is not proof of non-execution.

With capability `dialog_observer`, `subscribe_sessions` accepts `dialogs?: boolean` (default false). A matching `dialogs: true` subscription must also enable `mirror`. It receives these new records on its connection FIFO:

`{type: "ui_request_pending", sessionId, uiRequestId, method, request}` when a dialog or question is registered, with its original request frame; `{type: "ui_request_settled", sessionId, uiRequestId, disposition: "answered" | "cancelled"}` when it settles. Timeout and lifecycle teardown count as cancellation. The feed survives the command connection's departure while the session remains loaded. A dialog already present in the snapshot is not emitted again.

The subscription remains observing: it creates no attachment and carries no correlated `response` records. The original select, confirm, input, and editor `extension_ui_request` records remain targeted, not mirrored. Use a separate attached command connection for answers; dialog observation grants no answering authority.

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model",
  "errorCode": "model_not_found"
}
```

Parse errors:

```json
{
  "type": "response",
  "command": "parse",
  "success": false,
  "error": "Failed to parse command: Unexpected token..."
}
```

## Types

Source files:
- [`packages/ai/src/types.ts`](../../ai/src/types.ts) - `Model`, `UserMessage`, `AssistantMessage`, `ToolResultMessage`
- [`packages/agent/src/types.ts`](../../agent/src/types.ts) - `AgentMessage`, `AgentEvent`
- [`src/core/messages.ts`](../src/core/messages.ts) - `BashExecutionMessage`
- [`src/modes/json-event.ts`](../src/modes/json-event.ts) - `JsonAgentSessionEvent`
- [`src/modes/rpc/rpc-types.ts`](../src/modes/rpc/rpc-types.ts) - RPC command/response types, extension UI request/response types

### Model

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
	  "supportedThinkingLevels": ["off", "minimal", "low", "medium", "high"],
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

| Field | Description |
| --- | --- |
| `supportedThinkingLevels` | Thinking levels accepted by this model. Non-reasoning models expose only `"off"`. |

### UserMessage

```json
{
  "role": "user",
  "content": "Hello!",
  "timestamp": 1733234567890,
  "attachments": []
}
```

The `content` field can be a string or an array of `TextContent`/`ImageContent` blocks.

### AssistantMessage

```json
{
  "role": "assistant",
  "content": [
    {"type": "text", "text": "Hello! How can I help?"},
    {"type": "thinking", "thinking": "User is greeting me..."},
    {"type": "toolCall", "id": "call_123", "name": "bash", "arguments": {"command": "ls"}}
  ],
  "api": "anthropic-messages",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "stopReason": "stop",
  "timestamp": 1733234567890
}
```

Stop reasons: `"stop"`, `"length"`, `"toolUse"`, `"error"`, `"aborted"`

### ToolResultMessage

```json
{
  "role": "toolResult",
  "toolCallId": "call_123",
  "toolName": "bash",
  "content": [{"type": "text", "text": "total 48\ndrwxr-xr-x ..."}],
  "usage": {
    "input": 100,
    "output": 50,
    "cacheRead": 0,
    "cacheWrite": 0,
    "totalTokens": 150,
    "cost": {"input": 0.0003, "output": 0.00075, "cacheRead": 0, "cacheWrite": 0, "total": 0.00105}
  },
  "isError": false,
  "timestamp": 1733234567890
}
```

`usage` is optional and reports nested LLM work performed by the tool. When present, it contributes to session token and cost totals.

### BashExecutionMessage

Created by the `bash` RPC command (not by LLM tool calls):

```json
{
  "role": "bashExecution",
  "command": "ls -la",
  "output": "total 48\ndrwxr-xr-x ...",
  "exitCode": 0,
  "cancelled": false,
  "truncated": false,
  "fullOutputPath": null,
  "timestamp": 1733234567890
}
```

### Attachment

```json
{
  "id": "img1",
  "type": "image",
  "fileName": "photo.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "content": "base64-encoded-data...",
  "extractedText": null,
  "preview": null
}
```

## Example: Basic Client (Python)

```python
import subprocess
import json

proc = subprocess.Popen(
    ["senpi", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    text=True
)

def send(cmd):
    proc.stdin.write(json.dumps(cmd) + "\n")
    proc.stdin.flush()

def read_events():
    for line in proc.stdout:
        yield json.loads(line)

# Send prompt
send({"type": "prompt", "message": "Hello!"})

# Process events
for event in read_events():
    if event.get("type") == "message_update":
        delta = event.get("assistantMessageEvent", {})
        if delta.get("type") == "text_delta":
            print(delta["delta"], end="", flush=True)
    
    if event.get("type") == "agent_end":
        print()
        break
```

## Example: Interactive Client (Node.js)

See [`test/rpc-example.ts`](../test/rpc-example.ts) for a complete interactive example, or [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts) for a typed client implementation.

For a complete example of handling the extension UI protocol, see [`examples/rpc-extension-ui.ts`](../examples/rpc-extension-ui.ts) which pairs with the [`examples/extensions/rpc-demo.ts`](../examples/extensions/rpc-demo.ts) extension.

```javascript
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const agent = spawn("senpi", ["--mode", "rpc", "--no-session"]);

function attachJsonlReader(stream, onLine) {
    const decoder = new StringDecoder("utf8");
    let buffer = "";

    stream.on("data", (chunk) => {
        buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

        while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex === -1) break;

            let line = buffer.slice(0, newlineIndex);
            buffer = buffer.slice(newlineIndex + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            onLine(line);
        }
    });

    stream.on("end", () => {
        buffer += decoder.end();
        if (buffer.length > 0) {
            onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
        }
    });
}

attachJsonlReader(agent.stdout, (line) => {
    const event = JSON.parse(line);

    if (event.type === "message_update") {
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent.type === "text_delta") {
            process.stdout.write(assistantMessageEvent.delta);
        }
    }
});

// Send prompt
agent.stdin.write(JSON.stringify({ type: "prompt", message: "Hello" }) + "\n");

// Abort on Ctrl+C
process.on("SIGINT", () => {
    agent.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
});
```
