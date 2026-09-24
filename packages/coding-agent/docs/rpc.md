# RPC Mode

Shared-host clients may advertise the `rendered_components` capability to receive factory-rendered widget, header, and footer records. In a shared session, component rendering uses the minimum width reported by currently attached connections, defaulting to 80 when none report a width; disconnected connections no longer contribute.

When the last client disconnects from a retained in-process session, extensions receive
`session_parked`; the first reattachment to that still-open session emits
`session_resumed`. File-monitor polling and prompt-cache keepalive pause between these
events. Active turns and idle eviction keep their existing behavior. These extension
hooks are not the `session_parked` wire record emitted when eviction or handoff releases
a runtime. Worker-runtime sessions currently do not dispatch the extension hooks.

The shared Unix socket host keeps its ownership state in a PER-SOCKET daemon directory, `<agentDir>/rpc-host-daemon/<sha256(canonical socket)[:16]>/` (see [Daemon state directory](#daemon-state-directory-layout-2)). Clients attach to a compatible existing host regardless of which client surface started it; only incompatible unmanaged owners are refused.

RPC mode enables headless operation of the coding agent via a JSON protocol over stdin/stdout. This is useful for embedding the agent in other applications, IDEs, or custom UIs.

**Note for Node.js/TypeScript users**: If you're building a Node.js application, consider using `AgentSession` directly from `@code-yeongyu/senpi` instead of spawning a subprocess. See [`src/core/agent-session.ts`](../src/core/agent-session.ts) for the API. For a subprocess-based TypeScript client, see [`src/modes/rpc/rpc-client.ts`](../src/modes/rpc/rpc-client.ts).

## Account display names

`get_provider_accounts` returns secret-free descriptors containing `name`, `source`, `blocked`, `pinned`, and optional `displayName`. Render a named account as `displayName (name)`; keep using the immutable `name` for `account_pin`, `account_remove`, and comparisons. Legacy accounts omit `displayName`.

Use `/account <provider> rename <id> <display name...>` or the corresponding `/gpt-account` and `/claude-account` commands to name saved accounts; `clear-name <id>` removes only the label. `/gpt-account add` offers optional naming after login is saved, and only when Senpi generated the account ID itself; the Claude lane names accounts through its own login prompt and never asks twice. Blank input or cancellation keeps that login usable. Environment accounts cannot be renamed.

A label is stored NFC-normalized with internal whitespace collapsed, must contain at least one visible character, and may not exceed 32 terminal columns (measured in grapheme clusters, so CJK and emoji count two columns each). Uniqueness within a provider folds case, Unicode compatibility forms, invisible code points, and Cyrillic lookalikes, so two labels that render identically are refused.

## Starting RPC Mode

### RPC client lifecycle

`RpcClient` accepts an `onDisconnect` callback for an established socket and rejects subsequent transport operations with the typed `RpcTransportGoneError` (also detectable with `isTransportGoneError`). Callers should use the callback to begin recovery and keep the error text out of user-facing output.

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

A connection that does not advertise the capability receives byte-identical output to before. The
capability is advertised by the host in `get_protocol_info.capabilities` in both classic and
multi-session mode, but the transform itself is applied only by the multi-session host: classic
single-connection stdio mode never rewrites its output, so a stdio client always receives inline
media even if it names the capability. `get_media` is answered in both modes.

## Multi-session mode (D1 wire protocol)

Multi-session mode lets one `senpi --mode rpc` process serve several independent conversations concurrently over the same stdio JSONL stream. Classic single-session mode is byte-identical to today; the only additive classic-mode behavior is that `get_protocol_info` is answered.

### Starting multi-session mode

```bash
# Shared JSONL over stdio (legacy multi-session host)
senpi --mode rpc --multi-session [options]

# One shared host over a local socket; each accepted connection has its own JSONL feed
senpi --mode rpc --listen unix:///tmp/senpi-rpc.sock [options]
senpi --mode rpc --listen /tmp/senpi-rpc.sock [options]
```

`--listen unix://` selects the default per-agent socket path. Unix abstract socket names may be supplied as
`unix://@name` where supported by the host platform. Socket mode accepts concurrent connections while retaining one
process-global session registry.

### Session runtime (`--session-runtime in-process|worker`)

`--session-runtime` selects where a multi-session host runs its sessions:

- `in-process` - every session runs IN the host process, sharing its event loop. No worker isolate is allocated and
  no session cap applies (capacity is memory, never a refusal). This is the DEFAULT for a `--listen` socket host,
  i.e. for the shared host clients attach to.
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

### Host identity (`get_protocol_info`)

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
  }
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

Compatibility is decided from `protocolVersion` + `capabilities`, and "is my build newer?" from `engineOrdinal`.
A `serverVersion` string comparison is never a compatibility test: two hosts with different version strings can
speak the same protocol, and a host whose ordinal is uncomparable is attached to, never replaced.

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

Four invariants govern every client of a shared host, and every client is expected to keep all four. The first two
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
- **I2 - compatibility is protocol version + capabilities, never semver equality.** An ordinal that cannot be
  compared (a build without git metadata, a host that reports none) is EQUAL, and since a handoff requires
  STRICTLY greater, such a pair attaches instead of upgrading.
- **I3 - only the generation that owns the daemon state writes it; every other client reads.** A running host's
  pidfile, settings, reservations and socket belong to that generation. A client that cannot use what it finds
  fails CLOSED - it reports the refusal, or starts its own private host on its own endpoint - and never edits a
  shared host's state files, unlinks its socket, or removes its pidfile to "clean up". A handoff is the one
  exception and it still writes only its OWN generation directory before repointing the pointer (see
  [Daemon state directory](#daemon-state-directory-layout-2)); the drained predecessor keeps its registration until
  it exits, because it is still serving.
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

Two guards decide whether a handoff is attempted at all, and both fail closed:

- The running host must advertise `generation_handoff`. SIGUSR1 TERMINATES a process that installed no
  handler for it, so a host from before the drain existed is never signalled - `handoffHost` answers
  `{ action: "refuse", reason: "handoff_unsupported" }` and `decideHostAction` reports `upgradeable: false`.
- The registration must prove which process serves the socket (pid + start time, and the record's `socket`
  must be this endpoint). An unprovable owner refuses with `unknown_owner` rather than signalling a
  stranger (I1).

On win32 a named pipe can be neither renamed nor drained: `handoffHost` refuses with `upgrade_unsupported`
and `decideHostAction` never yields `handoff` there. Upgrades apply after `stopHost({ drain: true })` or an
idle exit.

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

`stopHost({ socket, agentDir, drain?, force? })` ends a generation: `drain: true` is always permitted (it
ends no work, it only stops the host from taking new work), while a hard stop requires a host that reports
no open sessions, or `force: true`. A hard stop also drops that generation's registration (the pointer and
its `generations/<instanceId>/` directory); a draining host keeps its registration until it exits, because
it is still serving. `probeHost({ socket })` returns the running host's `get_protocol_info`
answer, or `undefined` when nothing is serving the endpoint.

A host that reports memory pressure (`SENPI_RPC_HOST_RSS_WARN_MB`, 4096 by default) while holding NO session
logs one line naming its RSS, and drains when it is also superseded: memory a daemon cannot attribute to a
session is memory nothing will return, and a generation nobody can reach is pure cost.

#### Daemon state directory (layout 2)

Every endpoint gets its own directory, named by the socket it serves, so two sockets in one agent
directory can never read each other's state:

```
<agentDir>/rpc-host-daemon/                    flat directory (shared; also a legacy host's own state)
  layout.json                                  { "layout": 2, "dir": "<sha256(canonical socket)[:16]>" }
  <sha256(canonical socket)[:16]>/             0700
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

Directories are `0700` and every state file is `0600`. The canonical socket is the socket path on POSIX
and the normalized lower-cased path on win32, so a client recomputes the directory name from the socket
alone. `generation_dir` is relative to the directory holding the pointer (`generations/<instanceId>`), and
`instance_id` is the same id the host reports as `instanceId` in `get_protocol_info` - so a pointer that
names a different id than the socket answers describes a generation that is no longer serving.

The flat directory is deliberately missing a flat `host.pid`: layout 2 writes `layout.json` there and
NOTHING else. A flat pidfile holding `{ pid, processStartTime }` is what arms every DEPLOYED client's kill
path (a desktop reader that finds one takes the host over; a `senpi` from before layout 2 stops it through
`stopManagedHost`), so writing one would let an un-updated client replace this daemon and end every other
client's sessions. Without it those clients fail CLOSED - they find no host of their own, refuse, and leave
the daemon alone. Nothing here ever writes a legacy-shaped file, and nothing here ever REMOVES one: a flat
`host.pid` that does exist belongs to a legacy host, is read-only to this build, and while the process it
names is alive an ensure refuses (`legacy_host`) rather than starting a second host beside it.

`ensureHost` fails with a typed `HostDaemonStateError` naming the directory it could not create or write,
and starts no host in that case.

The directory is PRUNED of what is no longer running on every registration write and on every `host status`:
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
senpi host ensure  [--json] [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
senpi host status  [--json] [--include-workers] [--socket <path>]
senpi host stop    [--json] [--drain] [--force] [--socket <path>]
senpi host handoff [--json] [--launch-spec <file>] [--socket <path>]
```

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
symmetry with other commands; the answer is always JSON.

- `ensure` prints `{ action, socket, pid, instanceId, generation, engineVersion, engineOrdinal,
  capabilities, launchProfileId, reused, upgradeable }`. `--policy upgrade` (the default) allows a
  generation handoff, `never` only attaches or starts, and `fallback` answers exit 4 rather than attaching
  to a host this build disagrees with. `action` is `handoff` exactly when the socket was already served and
  the process behind it changed.
- `status` prints `{ reachable, socket, pid, instanceId, generation, engineVersion, capabilities,
  launchProfile, sessions: { total, interactive, worker, retained, foreign_attached, foreign_retained },
  zombies, rss_mb, open_fds, env_keys, generations }` and exits 3 when nothing answers - with the same
  field set, so a caller parses one shape and branches on one boolean. `sessions` is what `list_sessions`
  reports under the same flag, so `worker` stays `0` without `--include-workers`; `foreign_*` is the same
  count from the point of view of a client holding none of those sessions itself. `rss_mb`, `open_fds` and
  `zombies` describe the daemon's whole process tree (supervisor plus host) and are `null` where the
  platform does not publish them (`open_fds` is `/proc`-only). `generations` lists every ALIVE generation of
  this daemon as `{ instanceId, generation, pid, engineVersion, rss_mb, sessions, current, alive }`, newest
  ordinal last: `rss_mb` is that generation's own process tree, and `sessions` counts the session files it
  still claims in `reservations/` - the one occupancy number that is observable for a generation which no
  longer answers on the socket. Records of generations that ended are pruned by the read itself, so a status
  never lists a dead pid.
- `stop` is the I1 carve-out: a plain stop needs a validated pidfile AND `foreign_attached +
  foreign_retained == 0`, or it refuses with exit 3 and prints the counts it refused on; `--force`
  overrides after printing the same counts; `--drain` (SIGUSR1) is always permitted, because it ends no
  work.
- `handoff` forces a generation handoff from THIS binary. A host that cannot drain and a platform that
  cannot rename answer alike: exit 3 `{ reason: "upgrade_unsupported", detail }`.

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

#### Verifying a daemon build (live QA drivers)

Two POSIX-only drivers in this repository exercise the whole daemon against real processes in a sandbox agent
directory, printing one JSON line per step (written synchronously, so a step that hangs has still printed every step
before it) and a final cleanup receipt. They are how a build is checked before it is trusted with other clients'
sessions:

| Driver | What it proves |
|---|---|
| `node scripts/qa-rpc-socket/inprocess-daemon-qa.mjs` | Two COMPILED binaries of the tree differing only in build epoch; `host ensure --json` run from the older one; per-session `context` isolation (each session's extension sees only its own); `list_sessions` with and without `include_workers`; 50 sessions with the measured thread cost and no refusal; a retained session re-attached across a dropped connection; 200 bash calls leaving zero zombies; and a generation handoff by the newer binary while a client stays connected. |
| `node scripts/qa-rpc-socket/generation-handoff.mjs` | The handoff alone, against the source supervisor: `ensureHost` -> generation 0, `handoffHost` -> generation 1 on a new pid, `session_path_in_use` naming the owner while the held session is parking, `session_closed { reason: "handoff_parked" }`, the predecessor exiting, the transcript reopening intact in the new generation, and `stopHost({ drain: true })` draining to exit. |

Both exit non-zero if a daemon, a fixture host or the sandbox survives the run: a shared host outliving its QA is
exactly the failure they exist to catch.

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

### Client information and rendered components

Clients may send `set_client_info` with `{ sessionId, width, capabilities? }`. Advertising `rendered_components` registers
that connection to receive factory-rendered `setWidget`, `setHeader`, and `setFooter` records. Those records are filtered
per connection; array/undefined widget records and dialog requests retain their existing delivery semantics. Width is
shared per session using the minimum of attached clients, and a closed or dropped connection no longer contributes its
width or capability registration. Snapshot replay preserves rendered-component provenance and applies the same capability
filter to late joiners; a client that registers `rendered_components` while a snapshot is active receives its retained
factory-rendered records. On a shared socket host, `rendered_components` is registration-only: it is never inherited from the host environment and must be sent in `set_client_info` for each client connection. Registration applies to the sessions attached by that connection; closing one session removes only that session's width and capability association, while socket disposal removes all associations. Clients must re-register `width` and `capabilities` after every reconnect. When the last
capable connection leaves a still-attached binding, live component renderers and footer data providers are disposed but
their factories are retained; a later capable connection recreates and re-renders them.

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

One shared host therefore loads ONE extension set and still lets an extension recognize the session it was loaded for
(`pi.sessionKind`, `pi.sessionContext` - see
[ExtensionAPI session identity](extensions.md#pisessionkind--pisessioncontext--pisharedhostenabled)). Probe
`session_kind` and `session_context` in `get_protocol_info` capabilities before relying on either: an older host
ignores both fields and lists every session.

Default-invisible worker sessions are invariant **I4** above: a client that does not pass `include_workers: true`
sees the daemon exactly as it saw a host serving only that client.

### Session auto-titling

Auto-generated session titles are on by default only for interactive launches. A shared host decides titling per
`open_session`: `auto_title: true` titles that session, `auto_title: false` leaves it untitled, and an omitted field
keeps the host-wide default (`--auto-title-sessions` or the `auto_title_sessions` client capability). Probe
`auto_title_per_session` in `get_protocol_info` before relying on the field; an older host ignores it. A non-boolean is
refused with `invalid_launch_profile`. Sessions resumed with existing context messages are never retitled.

`--auto-title-sessions` still opts every session on that host into titling when `auto_title` is omitted. It is
deprecated for shared hosts — prefer per-session `open_session.auto_title` so two clients on one daemon do not collide
over a launch-profile flag:

```bash
senpi --mode rpc --multi-session --auto-title-sessions
```

Startup: `senpi --mode rpc --multi-session` → NO default session is constructed (no default `AgentSessionRuntime`, no default extension/watcher load). Classic `senpi --mode rpc` is byte-identical to today. Mode is fixed at process start; there is no runtime transition.

### Interactive sessions and shared-host opt-out

Interactive launches use the shared RPC host by default when a persisted session is available. A cold start takes approximately 1.3 seconds on the first launch; warm attachment to an existing compatible host is fast. To use the local runtime directly for a launch, set `SENPI_DISABLE_SHARED_HOST=1`. This uses the same local fallback runtime and does not change RPC socket behavior for other clients.

### Session replacement

A replacement (`new_session`, `switch_session`, `fork`) responds as soon as the swap is committed; the derived-surface refresh that rebinds extensions continues afterwards. That refresh does not disturb work the client starts against the committed session: tool activation performed while extensions are still binding no longer cancels an in-flight compaction or invalidates its context. `loaded_surfaces_changed` is emitted only when the surface digest actually changes, so it is NOT a settle barrier clients can wait on.

#### Replacement identity event

When `new_session`, `switch_session`, or `fork` swaps the live session - including replacements an extension drives, which a client never issued - every attached connection receives:

```json
{ "type": "session_replaced", "durableSessionId": "…", "sessionFile": "…", "cwd": "…", "sessionName": "…" }
```

The command response reports only `{ cancelled }`, so this event is the only push channel carrying the new identity. The identity is `durableSessionId`, never `sessionId`: top-level `sessionId` is reserved for the per-connection routing handle that multi-session hosts tag every record with, and that tag is applied last, so reusing the key would overwrite the identity the event exists to deliver. Classic mode emits the event untagged.

### Shared host lifecycle (cold start + idle exit)

The lifecycle supervisor is also available to bundled/rebranded runtimes through the hidden internal launch route `--internal-rpc-host-supervisor`. This route is wire-invisible and intended only for desktop launchers: it receives the public socket, ownership directory, and the runtime command/arguments to wrap, then runs the same `host-lifecycle.ts` implementation used by `ensureHost()`. Normal CLI modes do not use or advertise this route. Compiled standalone binaries also re-enter themselves through this route automatically: a bun executable always boots its embedded entrypoint, so the script-path re-entry used under a JS runtime would be parsed as CLI arguments (`Unknown option: --socket`) and the host could never start.

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
Any connection or agent turn resets the window, so a busy host never exits. The supervisor learns about turns through
its observer connection to the host; while that connection is unhealthy it cannot see turns, so it treats activity as
unknown and keeps the host open as if a turn were running — but only for one idle window, during which it keeps
reconnecting. An observer that stays unhealthy for longer than the window stops counting as busy, and the connection
count alone decides from there. A `persistent` host has an infinite window and so keeps its infinite benefit of the
doubt. The exit itself is clean: the RPC host
receives SIGTERM first, flushes pending output, removes its socket, and the supervisor then removes `host.pid` and
`settings.json` (the stderr log stays for diagnostics). After an idle exit, the next `ensureHost()` transparently
starts a fresh host. `get_protocol_info` over the public socket behaves exactly as before; the supervisor is
wire-transparent.

The RPC host can never outlive its supervisor. It is spawned with an extra inherited pipe on fd 3 whose write end the
supervisor holds and never writes to; the kernel closes that end whenever the supervisor dies — including `SIGKILL`, an
OOM kill, or a crash, where no signal handler runs — so the host reads EOF, shuts down cleanly and removes its private
internal directory. The supervisor also exports `SENPI_RPC_HOST_WATCH_PPID` as a polling fallback. Both bindings are
set only by the supervisor: a host started any other way (plain `senpi --mode rpc --listen …`, embedders, hand-started
hosts) sees neither variable and is unaffected. A host whose supervisor is alive is never touched by this binding.

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
   draining connection are refused with `host_draining`.
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

### Shared host occupancy (idle eviction, retention, empty-host exit)

**The daemon does not cap sessions.** On the in-process runtime - the default for a `--listen` socket host, i.e. the
shared daemon clients attach to - there is no session limit, no admission counter, and no eviction of a live session
to make room for another: capacity is memory, and `open_session` is never refused for occupancy. `too_many_sessions`
exists only on the worker runtime described below. On that runtime every session owns a worker isolate and a complete
runtime; on the in-process runtime each session is a runtime in the host process. Memory depends on a session's
extensions and contents; neither runtime provides process-fatal OOM containment.

What the host does enforce are lifecycle windows, and they only ever return memory from work nobody is doing:

- **Idle eviction**: a session with no routed command and no session-owned work for
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
  parks it — announced as `session_parked { sessionId, sessionPath }`, after which the file reopens by path like any
  evicted session, and the parked session counts as gone for the empty-host exit below. It is also bounded by the empty-host exit
  and the supervisor's idle-exit window below: retention survives a client, not the host. Any attach may turn retention
  on for a live session; no attach turns it off for clients that already rely on it. Omitting the flag is byte-identical
  to the previous behavior — the session is closed with its last connection. Probe `retain_on_disconnect` in
  `get_protocol_info` capabilities before relying on it: an older host silently ignores the field.
- **Empty-host exit**: when the registry holds zero sessions AND no client is connected, continuously for
  `SENPI_RPC_HOST_EMPTY_EXIT_MS` (default 15 minutes), the host exits through its clean shutdown path (flush, socket
  removal), for stdio and `--listen` hosts alike. A connected client counts as occupancy even with no session open,
  so the host never drops a live socket under itself. Supervised hosts stay clean either way: a supervisor reads a
  child exit of 0 without a signal as an intentional idle stop and exits 0 with the same cleanup, not as a crash.

Values are positive integers; invalid values fall through to the defaults. These lifecycle windows run inside the host process,
so they hold even for embedders and hand-started hosts that have no supervisor.

### Host self-observation (event-loop stalls and memory pressure)

Every in-process session shares the host's event loop, so a session that blocks it freezes every other session and the
transport with it. A multi-session host therefore watches itself. Both observers run on unref'd timers, and both only
REPORT: nothing here aborts a turn, kills a session, or refuses an `open_session`.

- **Event-loop stalls**: a 200 ms timer measures how late it is actually invoked; that lateness is the time the loop
  could serve nobody. Drift above `SENPI_RPC_LOOP_LAG_WARN_MS` (default 500) writes one stderr line per 10 seconds,
  `senpi rpc host stall: event loop blocked <drift>ms (sessionId=<handle> tool=<tool>)`. Drift above
- On accepting an `open_session`, the host sends that connection a `queued` record
  (`{ type, for_request, position, in_flight }`) before the open enters the session loop.
  `position` is 1-based and `in_flight` counts opens already accepted across the whole host,
  since every session shares one loop. It is addressed to the opener only, carries the request
  id under `for_request` rather than the response-id field, and is dropped if that connection
  has disconnected. A client that later times out can report where it was queued instead of a
  bare deadline.
  `SENPI_RPC_LOOP_LAG_ERROR_MS` (default 5000) additionally broadcasts a `host_stalled` record
  (`{ type, driftMs, sessionId?, tool? }`) to every connection, like the other content-free lifecycle records.
- **Stall attribution**: each routed command is dispatched inside an `AsyncLocalStorage` scope carrying its routing
  `sessionId`, and an in-process session's tool executions open a span carrying `{ sessionId, tool }` for as long as
  the tool runs. A stall is blamed on the synchronous work that finished inside the measured window, or on the tool
  still executing when it ended; when neither exists the record and the log line carry no session, because the stall
  belongs to the host itself. Worker-runtime sessions block their own isolate rather than the host loop and
  deliberately have no tool spans.
- **Memory pressure**: a 30-second sampler reads the host's RSS. Above `SENPI_RPC_HOST_RSS_WARN_MB` (default 4096) it
  broadcasts `host_memory_pressure` (`{ type, rssMb, sessions }`) on every sample, writes one stderr line per five
  minutes, and HALVES the idle-eviction window above while the host stays above the threshold, so idle sessions return
  their memory sooner. It is released as soon as RSS falls back under the threshold. Above the REFUSE watermark
  (`SENPI_RPC_HOST_RSS_REFUSE_MB`, default twice the warning threshold) the host is CRITICAL: an `open_session` that
  would CREATE a `kind: "worker"` session is refused with the stable code `host_memory_pressure` and
  `errorData { rssMb, retry_after_ms }`, until the next sample reads under the watermark. Nothing else changes: every
  session the host already holds is served, an attach to a live path succeeds, interactive opens succeed, and nothing is
  killed. This is the one memory-driven refusal on the in-process path; there is still no occupancy cap and no kill
  policy. It exists because unbounded growth ended in a runtime crash that took every session with it (#1905).
- **Stall-proof dead-peer detection**: the socket dead-peer budget (30 s, `socket-event-fanout.ts`) counts only time
  the host loop actually SERVED. The loop-lag watchdog deposits each measured drift into a process-wide ledger
  (`loop-blocked-time.ts`) and the deadline re-arms for whatever blocked time landed inside its window, so a host that
  blocked for longer than the budget cannot cut every live peer on unblock (#1905). A peer that drains nothing for a
  fully-served 30 s window is still cut.
- **Teardown order**: a session's provider scope closes only after its runtime disposal settles, on the graceful path
  and at the close grace deadline alike; a config-reload watcher callback bound to a closed scope is a no-op (#1905).

`host_stalled` and `host_memory_pressure` are additive records: a client that does not know them ignores them.

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
  `host_stalled { driftMs, sessionId, tool }` and the matching stderr line are how a blocking call in a session or a
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
Display updates coalesce to one pending update and one latest value; UI cancellation and close have separate control
messages. IPC output and snapshots are limited to 16 MiB per record, with one acknowledged record at a time. Over a
socket host, credit returns as soon as every destination of that session has ACCEPTED the record into its own bounded
queue (64 MiB per connection), not when the peer's kernel has drained it: a client that is merely busy cannot withhold
the producing worker's credit. On the shared stdio lane credit still waits for stdout backpressure. A five-second credit
failure closes that session visibly (`session_error` followed by `session_closed`), rather than retaining an
unbounded queue. Socket queues keep their independent overflow/disconnect behavior: a connection whose queue would
exceed 64 MiB is cut immediately, and a peer that has not accepted a single pending write within 30 seconds
(`DEFAULT_STALL_MS`) is cut as a dead peer. That budget is a transport liveness bound and is deliberately independent
of the 5-second worker control deadline — a busy client is not a dead one. A cut connection receives one `overflow`
record (`error: "overflow, resync required"` or `"stalled, resync required"`); the host then half-closes the socket
instead of destroying it, so a peer that resumes reading within a 5-second grace (`SOCKET_CUT_GRACE_MS`) still receives
that notice, and everything already written to it, before EOF. A peer that is still silent when the grace expires has
its socket destroyed. A cut peer must reconnect and resynchronize, while the session keeps running and its other
destinations keep receiving output. A failed or cut connection never withholds a session's credit and never fails the
shared host writer; only the stdio lane can. Because credit no longer paces a session against its slowest reader, a
session that outruns a peer fills that peer's 64 MiB queue instead of slowing down, and that peer is then cut on
overflow. The default stdio
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

The classic handler, extension UI bridge, renderer callbacks and provider scope run inside the owning worker; only
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

| Command | Params | Success data | Notes |
| --- | --- | --- | --- |
| `get_protocol_info` | - | `{ protocolVersion: 1, serverVersion: string, capabilities: string[], mode: "classic"\|"multi", instanceId: string, generation: number, engineVersion: string, engineOrdinal: [y, m, d, n, epoch], launch_profile: { profile_id, core } }` | Answered in BOTH modes; side-effect-free; the capability probe. Multi-session hosts include `multi_session`, `retain_on_disconnect`, `session_kind`, `session_context` and `auto_title_per_session` plus the negotiated launch capabilities. Those are HOST capabilities (a client never sends them) and are advertised only in multi-session mode, where the host owns the attachment refcount and the per-session launch profile. The identity fields are described under "Host identity" above; compatibility is decided from `protocolVersion`, `capabilities` and `engineOrdinal`, NEVER from `serverVersion`. |
| `open_session` | `sessionPath?`, `cwd?`, `provider?`, `modelId?`, `thinkingLevel?`, `permissionPreset?`, `retain_on_disconnect?`, `kind?`, `context?`, `auto_title?` (all optional; paths MUST be absolute) | `{ sessionId, state: RpcSessionState, attached?: true }` | `sessionPath` = today's `--session` semantics (open-if-exists else create persisting there, `session-manager.ts:926-940`); `provider`/`modelId` applied only on create (resume restores the session's model — mirrors `SenpiSessionRuntime.ts:198-200`); params form the immutable launch profile (D8). When the path is already held by a fully-open session, the open ATTACHES to it: same routing handle, `attached: true`, one more attachment counted; the runtime is torn down only when the last attachment closes. Idle sessions past the eviction window are closed by the host itself. `retain_on_disconnect: true` (default false) makes a dropped connection DETACH from this session instead of closing it — see "Retained sessions" below. `kind` (default `interactive`) and the opaque `context` map are described under "Session kind and context" above; both are stored frozen for the session's life and never influence auth, model or resource resolution. |
| `close_session` | `sessionId` | `{}` | Refused with `unknown_session` when the requesting connection never attached to that handle (a close releases the CALLER's attachment, and `list_sessions` publishes every handle). Otherwise aborts active work, awaits agent idle + settled persistence for up to the host grace window (default 10s), then quarantines any worker that has not exited without releasing its path reservation; its response is the LAST record tagged with that handle for the first closer — no events after (test-pinned). An admitted concurrent close joins the same teardown and receives its own successful response; output saturation rejects admission with the bounded close-overflow/resync notice described above. |
| `list_sessions` | `include_workers?` (default false) | `{ sessions: [{ sessionId, durableSessionId, sessionPath, cwd, name, status, attachments, kind, context? }] }` | Includes `opening`/`closing` entries. Internally quarantined workers remain externally `closing` until exit. `attachments` is the session's live client attachment count; `0` on an `open` row is a retained session with no client attached. Every row carries `kind`. Rows with `kind: "worker"` are omitted unless `include_workers: true`, and `context` is published ONLY on that listing — a default listing carries no `context` at all. |
| every existing command | + `sessionId` (REQUIRED in multi mode) | unchanged | Routed to that session. |

### Identities (D6)

Response-level `sessionId` = opaque **routing handle**, unique per process epoch, ephemeral (dies with the child). `state.sessionId` = **durable** JSONL session identity (what a resume cursor stores today). `list_sessions` exposes both. Clients store both, discard routing handles on child exit, and verify only durable ids against cursors.

### Stable error codes

In the response `error` field, machine-matchable:

- `unknown_session`
- `session_closing` (an entry whose owner is tearing down). A worker that FAILS while its session is being opened is not that case and reports `open_failed` carrying the worker's own reason, so the code a client matches on always names what actually happened.
- `session_path_in_use` (path held by an opening or quarantined owner; a fully-open current owner is attached instead, an owner whose teardown is already in flight is waited out on the in-process runtime, and a path a live owner has superseded is released rather than held). A path held by ANOTHER GENERATION of the daemon carries `errorData { owner: { instanceId, pid, processStartTime, sessionPath, current }, retry_after_ms: 2000 }`: that generation is still writing the file and is parking it, so the open is a retry, not a failure. Only a claim whose owner serves the socket (`current: true`) or still has a client attached refuses an open at all - a superseded, attachment-less claim is reclaimed instead
- `session_reservation_limit` (this worker already holds 64 live session paths; the open or session replacement was refused without disturbing the existing session)
- `missing_session_id` (session-scoped command without `sessionId` in multi mode)
- `multi_session_disabled` (`open_session` in classic mode)
- `host_draining` (`open_session` on a connection whose generation is parking for a handoff; the successor already owns the public path, so re-resolve it and open there rather than retrying this connection)
- `invalid_path` (relative `sessionPath`/`cwd`)
- `open_failed: <detail>`
- `invalid_session_context: <detail>` (`open_session.context` past a documented cap: more than 32 keys, a key that does not match `^[a-z][a-z0-9_]*$`, a non-string or >16 KiB value, or more than 32 KiB of JSON in total; the detail names the cap and its byte budget)
- `invalid_session_kind: <detail>` (`open_session.kind` other than `interactive` or `worker`)
- `invalid_launch_profile: <detail>` (`open_session.auto_title` present but not a boolean)
- `host_memory_pressure` (the in-process host is above `SENPI_RPC_HOST_RSS_REFUSE_MB`, default twice `SENPI_RPC_HOST_RSS_WARN_MB`, and declined to CREATE a `kind: "worker"` session; `errorData { rssMb, retry_after_ms }` says when to ask again. An attach to a live path, an interactive open, and every command on an existing session are never refused for memory - the client waits and retries, it never starts a second host or a per-child process)
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

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

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

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": { "disposition": "started" }}
```

The prompt success response carries `data.disposition` (`"started"` | `"queued"` | `"handled"`), captured from the host session's own disposition callback so proxied clients can resolve optimistic-echo contracts exactly like the local path. Older hosts omit `data`; clients must then degrade to canonical-only rendering (treat the echo as rejected). The response is emitted before the user `message_start` event on the same connection, and disposition callbacks registered through the client run synchronously inside response-frame dispatch — never through the resolved promise's microtask.

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.
The `message` field for `prompt`, `steer`, and `follow_up` is limited to 1,000,000 characters;
image payloads are not counted toward this text limit.

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
{"type": "response", "command": "steer", "success": true}
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
{"type": "response", "command": "follow_up", "success": true}
```

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

#### abort

Abort the current operation and wait for the session to become idle before responding.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
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
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model) object or `null`. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

`serviceTier` is the tier a request would carry right now (`"auto"`, `"flex"`, or `"priority"`), omitted when no tier applies. `fastMode` is `true` when the active model is served at the priority ("fast") tier — either because fast mode is on for this session or because the model selection itself pins `priority`. The two never disagree: whenever `fastMode` is `true`, `serviceTier` is `"priority"`.

#### get_messages

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

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

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

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model) objects with supported thinking levels:
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
    }
  }
}
```

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

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

With a cursor:
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
| `bash_execution_update` | Direct RPC bash command output chunk |
| `tool_execution_start` | Tool begins execution |
| `tool_execution_update` | Tool execution progress (streaming output) |
| `tool_execution_end` | Tool completes |
| `queue_update` | Pending steering/follow-up queue changed |
| `compaction_start` | Compaction begins |
| `compaction_end` | Compaction completes |
| `auto_retry_start` | Auto-retry begins (after transient error) |
| `auto_retry_end` | Auto-retry completes (success or final failure) |
| `summarization_retry_scheduled` | Retry scheduled for a transient compaction or branch-summary summarization error |
| `summarization_retry_attempt_start` | Retried summarization request starts |
| `summarization_retry_finished` | Summarization retry loop completes |
| `extension_error` | Extension threw an error |
| `extension_event` | Capability-gated extension-owned event (`extension_events` clients only) |
| `commands_changed` | Ordered command/skill candidate snapshot changed |
| `command_invocation` | Accepted extension-command or prompt-template invocation metadata |
| `skill_invocation` | Ordered explicit skill metadata after prompt expansion |
| `loaded_surfaces_changed` | Loaded skills, extensions, or MCP inventory changed; re-read `get_commands` and `get_loaded_surfaces` |
| `model_changed` | Active model changed (any source), with the thinking level in force afterwards |
| `service_tier_changed` | Effective service tier or fast-mode state changed |
| `session_closed` | Multi-session host: a routing handle ended. Optional `reason`: `client_close`, `idle_evicted`, `host_shutdown`, `replaced`, `handoff_parked`, `error` |
| `session_parked` | Multi-session host: a retained session was released to disk at the idle window (`sessionId`, `sessionPath`). Replaces `session_closed` for that handle |
| `host_stalled` | Multi-session host: the event loop was blocked past `SENPI_RPC_LOOP_LAG_ERROR_MS`, with the drift and the session/tool blamed for it |
| `host_memory_pressure` | Multi-session host: RSS is above `SENPI_RPC_HOST_RSS_WARN_MB`, with the live session count |
| `session_opened` | Multi-session host: a session was opened on this host (content-free lifecycle record) |
| `session_closed` | Multi-session host: a routing handle ended, with an optional `reason` (`handoff_parked` = a generation handoff put the session back on disk; reopen it by `sessionPath`) |
| `session_parked` | Multi-session host: a retained session's handle was released while the session itself stays on disk (`{ sessionId, sessionPath }`); reopen it with `open_session { sessionPath }` |
| `session_replaced` | The live session was swapped by `new_session`, `switch_session` or `fork`, carrying the new `durableSessionId` |

Event types are additive: a client that does not recognise a type must ignore that record rather than fail. `model_changed`
and `service_tier_changed` were added after the initial protocol and are safe to ignore. `session_parked`, `host_stalled`,
and `host_memory_pressure` are the same: ignore them if unknown. `session_closed.reason` is optional; ignore an unknown
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
| `host_shutdown` | The host process is exiting (SIGTERM, idle-exit, empty-host). A retained session is closed, not parked |
| `replaced` | The routing handle ended because the live session behind it was replaced |
| `handoff_parked` | A generation handoff drained this host; reopen with `open_session { sessionPath }` |
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
{ "type": "host_memory_pressure", "rssMb": 4608, "sessions": 12 }
```

Informational. Capacity is memory, never a refusal: the host reports the pressure and parks idle sessions sooner.

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

Emitted when one low-level agent run completes. Contains all messages generated during this run. If `willRetry` is true, an automatic retry will follow.

```json
{
  "type": "agent_end",
  "messages": [...],
  "willRetry": false
}
```

### agent_settled

Emitted after the full session-level run settles. At this point senpi will not continue automatically through retry, compaction retry, or queued follow-up messages.

```json
{"type": "agent_settled"}
```

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

Emitted without a request id when the loaded skill, extension, or MCP inventory changes. The event carries no inventory payload; clients re-read `get_commands` for skills and `get_loaded_surfaces` for extensions/MCP, mirroring the app-server `skills/changed` invalidation model.

```json
{"type": "loaded_surfaces_changed"}
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
- `auth_login_end` `{provider, success, error?}`: exactly one per login; `error` is a non-secret message.
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

## Extension UI Protocol

Extensions can request user interaction via `ctx.ui.select()`, `ctx.ui.confirm()`, etc. In RPC mode, these are translated into a request/response sub-protocol on top of the base command/event flow.

There are two categories of extension UI methods:

- **Dialog methods** (`select`, `confirm`, `input`, `editor`, `question`): emit an `extension_ui_request` on stdout and block until the client sends back an `extension_ui_response` on stdin with the matching `id`.
- **Fire-and-forget methods** (`notify`, `setStatus`, `setWidget`, `setHeader`, `setFooter`, `setTitle`, `set_editor_text`): emit an `extension_ui_request` on stdout but do not expect a response. The client can display the information or ignore it.

If a dialog method includes a `timeout` field, the agent-side will auto-resolve with a default value when the timeout expires. The host owns the timer and clients mirror the `remainingMs` value from each request or update event.

Some `ExtensionUIContext` methods are not supported or degraded in RPC mode because they require direct TUI access:
- `custom()` returns `undefined`
- `setWorkingMessage()`, `setWorkingIndicator()`, `setEditorComponent()`, `setToolsExpanded()` are no-ops. `setFooter()` and `setHeader()` render factory components for clients advertising `rendered_components`.
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

Send `widgetLines: undefined` (or omit it) to clear the widget. The `widgetPlacement` field is `"aboveEditor"` (default) or `"belowEditor"`. Component factories are rendered by the host using the attached client's terminal width.

#### setHeader / setFooter

Set or clear the extension header or footer using rendered text lines. Clients that do not understand these additive methods ignore them.

```json
{
  "type": "extension_ui_request",
  "id": "uuid-10",
  "method": "setHeader",
  "widgetLines": ["Header line"]
}
```

Omit `widgetLines` to restore the built-in surface. Attached clients send `set_client_info` with their terminal width after attach and on resize; hosts default to width 80 when no width is supplied.

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

Expected response: `extension_ui_response` with `answers` (a map of question id to `{ selected: string[], text?: string }`) and an optional `comment`. Partial answers are allowed: unanswered question ids are reported back to the model. Send `cancelled: true` to dismiss.

While the question is open, the client may send `extension_ui_progress` frames with draft `answers` and `comment`. Each progress frame resets the idle timer; the host emits `question_updated` with the refreshed `deadlineAtMs` and `remainingMs`.

When the question resolves (answered, comment-submitted, timed_out, or cancelled), the host broadcasts `question_resolved` to all connections:

```json
{
  "type": "question_resolved",
  "id": "uuid-q1",
  "requestId": "ask-user-1",
  "toolCallId": "call_abc123",
  "outcome": "answered",
  "answers": { "q1": { "selected": ["PostgreSQL"] } },
  "comment": "",
  "unanswered": []
}
```

A late answer after resolution receives a `question_already_resolved` error.

`RpcSessionState.pendingQuestions` (returned by `open_session` and `get_state`) lists any questions still waiting for an answer. Connections that attach after the question was asked receive the pending record immediately.

Clients without the `question` capability get a sequential fallback: one `select` per question (options plus "Other (type an answer)"), then one `input` for a comment. The result maps back to the same `QuestionResponse`.

### Extension UI Responses (stdin)

Responses are sent for dialog methods only (`select`, `confirm`, `input`, `editor`). The `id` must match the request.

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

## Error Handling

Failed commands return a response with `success: false`:

```json
{
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: invalid/model"
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
