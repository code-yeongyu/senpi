<!-- changes-log: packages/coding-agent/src/modes/rpc/changes.md -->
## 2026-11-17 - read_user_skill_file / write_user_skill_file: user-global skills through the one trust gate (omo-desktop-app#7981)

### What changed

- `packages/coding-agent/src/modes/rpc/user-skill-commands.ts`: new. `read_user_skill_file` / `write_user_skill_file` read and edit the file of a user-global skill the engine lists for the session, by name: one under the agent dir's `skills` root or `~/.agents/skills`. The file is taken relative to the root's real path and resolved segment by segment with `lstat`, so a link, a `..` path or a file outside every root is refused (`user_skill_file_not_allowed`). Writes are etag-guarded and serialized per file. A write from this device's own connection commits at once.
- `packages/coding-agent/src/modes/rpc/user-skill-approval.ts`: new. A write from a connection that speaks for another device (`connectionRoles.originOf`: a delegated principal or a declared `remoteOrigin`) commits only once THIS device approves it through the session's local grant presentation, which only a local attached client registers. The question names the origin device, the real path and the unified diff (the whole content for a new file; a diff over 20,000 characters is cut and says so). Choices are "Allow this change" / "Deny", with no "always". No presenter or no answer refuses with `user_skill_write_unconfirmed`, a denial with `user_skill_write_declined`. Every remote attempt appends one line to `<agentDir>/audit/user-skill-writes.jsonl` (`at`, origin device, `path`, `sha256Before`, `sha256After`, `decision`).
- `packages/coding-agent/src/modes/rpc/connection-handler.ts`: dispatches both verbs; the write passes the connection's origin.
- `packages/coding-agent/src/modes/rpc/method-classes.ts`, `method-classes-schema-session.ts`, `rpc-session-command-types.ts`, `rpc-read-response-types.ts`, `rpc-mutation-response-types.ts`: both verbs are `device_admin`, with their schemas and response types.
- `packages/coding-agent/src/modes/rpc/session-attachment-gate.ts`, `session-command-activity.ts`: `read_user_skill_file` is an observing read, like `read_project_skill_file`.
- `packages/coding-agent/src/modes/rpc/rpc-error-types.ts`: `user_skill_not_listed`, `user_skill_file_not_allowed`, `user_skill_write_declined`, `user_skill_write_unconfirmed`.

### Why

- Duty ruling on omo-desktop-app#7981: remote clients may write user-global skill files through the same single trust gate as #6127. A write whose origin is this device is pre-trusted; one from another device needs confirmation naming the origin device and the target path. LEAD conditions: the confirmation is answered only on the target device (the requester can never answer it, no "always allow"), containment by real path with link and `..` escapes refused, the prompt shows the diff, and one local audit entry per remote write.

### Why an extension could not handle it

- RPC verbs, their method classes and the connection's origin live in the RPC host; an extension cannot add a classed RPC verb or read which device a connection speaks for.

### Expected merge conflict zones

- MEDIUM: the method tables (`method-classes.ts`, `method-classes-schema-session.ts`, the command/response unions) when another verb lands at the same time; the `connection-handler.ts` switch next to the project skill cases.

<!-- changes-log: packages/coding-agent/src/core/changes.md -->
## 2026-11-17 - selectLocalGrant: the bounded local grant select with caller-named choices (omo-desktop-app#7981)

### What changed

- `packages/coding-agent/src/core/mcp-grant-presentations.ts`: `selectLocalGrant(select, title, [grant, decline], signal?)` is the bounded select `selectMcpGrant` ran, returning the answer (or nothing on abort, timeout or a disconnected presentation). `selectMcpGrant` keeps its contract on top of it.

### Why

- `write_user_skill_file` asks the same local-only presentation with its own choices.

### Why an extension could not handle it

- The grant presentation registry is core engine state the RPC host fills.

### Expected merge conflict zones

- LOW: `selectMcpGrant` in `mcp-grant-presentations.ts`.

<!-- changes-log: packages/coding-agent/CHANGELOG.md -->
### Added

- RPC `read_user_skill_file` / `write_user_skill_file` read and edit a user-global skill's file by name. A write from another device of the account commits only after it is approved on this machine (the prompt names the device, the path and the diff), and each such write is recorded in `<agentDir>/audit/user-skill-writes.jsonl`.
