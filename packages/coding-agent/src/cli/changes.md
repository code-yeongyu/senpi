## 2026-10-10 - Session control CLI over the shared host (senpi#3073)

### What changed

- `packages/coding-agent/src/cli/host-command.ts`: `resolveHostSocket` is exported (no behavior change) and the usage text gains one `session <open|close|model|prompt|steer|abort|read|state|list|wait> ...` line.
- `packages/coding-agent/src/cli/deferred-commands.ts`: `dispatchHostCommand` routes `senpi host session <sub>` to a lazily-imported `host-session-command.ts` before falling into the existing `host-command.ts` path, keeping the RPC client graph out of every other `host` subcommand's module load.

### Why

An orchestrating agent or script that drives senpi sessions had to write its own RPC client against `packages/coding-agent/src/modes/rpc/rpc-client.ts` and scrape terminal panes; `senpi host session <sub>` gives it one process-level command per operation with one JSON line of output.

### Why an extension could not handle it

Command routing, process exit codes and the lazy-import boundary that keeps `senpi host status` from loading the RPC client graph are CLI dispatch concerns that run before any extension loads.

### Expected merge conflict zones

- LOW: the `session` dispatch branch in `deferred-commands.ts` and the one `session` USAGE line plus the `resolveHostSocket` export in `host-command.ts`.

## 2026-10-08 - Selected-session startup warning (senpi#2951)

### What changed

- `packages/coding-agent/src/cli/session-opening.ts`: warns interactive users about live foreign session holders after the runtime publishes its own hold; lookup errors warn and continue. Naming remains in `main.ts`.

### Why

A resumed session was opened silently even when another process already held its JSONL.

### Why an extension could not handle it

The warning belongs to CLI startup and must work with extensions disabled.

### Expected merge conflict zones

- Fork-only file; the startup warning.

## 2026-10-08 - Scheduled session delivery does not replay an eval caller (senpi#2599)

### What changed

- `packages/coding-agent/src/cli/schedule-watch.ts`: default session delivery applies `runtimeExecArgv()` before the CLI entry. Operator `--exec` delivery is unchanged.

### Why

An embedding `node -p` or `node -e` process must resume the scheduled session instead of executing its embedding code in the child.

### Why an extension could not handle it

The schedule runner constructs the child command before the child's extension dispatch.

### Expected merge conflict zones

- LOW: the default `sessionResumeDelivery()` launch in `resolveDelivery()`.

## 2026-10-08 - Schedule delivery follows paths the OmO desktop moved (senpi#2898)

### What changed

- `packages/coding-agent/src/cli/schedule-delivery.ts`: new `movedJobPaths(job)` maps a job's `sessionFile` and `cwd` through `resolveMovedPath`.
- `packages/coding-agent/src/cli/schedule-runner.ts`: the defer probe and the delivered `scheduled_prompt` event take the job's paths from `movedJobPaths`. The job file itself, its re-arm and its settlement keep the stored paths.

### Why

A job created in a desktop thread before the desktop moved its data home (omo-desktop-app#1829) stores the old session file and working directory; it must fire against the moved ones instead of failing with "session file no longer exists", and the "session is open elsewhere" probe must look at the moved file's holders.

### Why an extension could not handle it

`senpi schedule run` delivers out of process, with no session or extension loaded.

### Expected merge conflict zones

- Fork-only files. `fireOne` (the defer probe call) and the event built in `deliverClaimed`; the helper block above `deferWhileSessionOpen`.

## 2026-10-02 - `host handoff --when idle` flags (desktop #1364)

### What changed

- `packages/coding-agent/src/cli/host-command.ts`: `host handoff` parses `--when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <id>` (all five together, else a usage error) into the conditional idle handover terms of `HostRequest`.

### Why

The desktop asks the engine to replace a host on another runtime at its next idle point (see `src/modes/rpc/changes.md`, same date).

### Why an extension could not handle it

`senpi host` is the core host lifecycle command.

### Expected merge conflict zones

- Fork-only file. The handoff case of `hostRequest` and the flag loop of `parseHostArgs`.

## 2026-09-30 - Sync with upstream v0.99.1 (6a4af07d6): settings, entrypoints and resource loading

### What changed

- `packages/coding-agent/src/cli/args.ts`: `packages/coding-agent/src/cli/args.ts`: upstream `--mode` validation diagnostics (#9045), `builtin:<name>` help text, `META_API_KEY` (D-8) adopted; upstream `mcp <command>` help lines removed (no fork `mcp` subcommand).
- `packages/coding-agent/src/cli/startup-ui.ts`: Silent rows read and accepted as merged: `cli/startup-ui.ts` (system theme startup, D-14), `core/keybindings.ts` (descriptions), `core/prompt-templates.ts` (diagnostics result), `core/trust-manager.ts` (adds `mcp.json`; the fork MCP reads project `.senpi/mcp.json`; the `.pi` legacy-trust fix is untouched), `experimental/process.ts` (`--import` URL), `package-manager-cli.ts` (builtin names into config), tests `args`, `package-manager`, `stdout-cleanliness`, `5943-session-start-notify`.

### Why

Upstream v0.99.1 settings/resource-loading features are adopted where they carry no excluded subsystem; D-2/D-5/D-6 exclusions remove codemode, MCP, tool-search, cache-warming and /bug surfaces; fork runtime contracts (tool defaults, loader ordering, global-default shims, session profiles) win on conflict.

### Why an extension could not handle it

Settings layering, resource/extension resolution, the package barrel and CLI entrypoints are core loader/bootstrap code that runs before any extension loads.

### Expected merge conflict zones

`settings-manager.ts` Settings interface + deepMergeSettings + getDefaultTools; `resource-loader.ts` constructor, loadCurrentExtensionSet, loadExtensionPaths, loadFinalExtensionSet; `index.ts` extension type export block; `main.ts` createCliRuntimeFactory diagnostics; upstream re-adding cacheWarming/codemode/mcp settings or exports.

## 2026-09-29 - Help-flag extension loading drops `sharedHostEnabled` (senpi#2328)

### What changed

- `packages/coding-agent/src/cli/help-extension-flags.ts`: `resolveHelpExtensionFlags` no longer passes `sharedHostEnabled: false` to `DefaultResourceLoader`; the option is removed (`src/core/changes.md`, same date).

### Why

- `pi.sharedHostEnabled` is removed from the extension API with the interactive shared-host join (senpi#2328).

### Why an extension could not handle it

- The help path constructs the resource loader before any extension loads.

### Expected merge conflict zones

- LOW: the `DefaultResourceLoader` options literal in `help-extension-flags.ts`.

## 2026-09-28 - `app-server --extension` in the help text (omo#9117)

### What changed

- `packages/coding-agent/src/cli/args.ts`: the `app-server` and `app-server daemon` lines of `printHelp` list `[--extension <path>]...`.

### Why

- `app-server` now loads `--extension` sources into every thread (`src/modes/app-server/changes.md`, same date); the command list should show the flag.

### Why an extension could not handle it

- The command list is printed by the CLI parser before any extension loads.

### Expected merge conflict zones

- LOW: the two `app-server` help lines in `args.ts`.

## 2026-09-27 - `senpi schedule` command for durable scheduled prompts

### What changed

- `packages/coding-agent/src/cli/schedule-command.ts` (new): `senpi schedule list [--json]`, `cancel <id>`, and `run [--watch] [--exec <command>] [--poll-seconds <n>] [--timeout-seconds <n>] [--concurrency <n>]` over the job files of the builtin `schedule` extension (`core/extensions/builtin/schedule/`). Every runner holds a lease with a 30s heartbeat (`schedule/runners/<pid>.json`); `--watch` is woken by new jobs through a `pending/` watch and stops cleanly on SIGTERM/SIGINT. `run` prints one JSON line per event; usage errors exit 2; a failed one-shot delivery exits 1.
- `packages/coding-agent/src/cli/schedule-watch.ts` (new): the runner process - lease, heartbeat (a failing refresh prints one `lease_error`), `pending/` watch, signal handling, event lines.
- `packages/coding-agent/src/cli/schedule-delivery.ts` (new): the `--exec` hook and `senpi -p --session` deliveries (on POSIX each waits on an fd-3 gate until its pid is recorded in the session lock and leads its own process group; a timeout kills the group, or the tree via `taskkill /T` on Windows, and is reported only after the process exits) and the open-session deferral.
- `packages/coding-agent/src/cli/schedule-runner.ts` (new): one runner pass - each job is delivered under its session's cross-process delivery lock - - recover occurrences whose runner died (to `failed/`, never retried), then claim and deliver due jobs concurrently across sessions and one at a time within a session, re-arming recurring jobs before delivery. Deliveries: `--exec` hook (event JSON on stdin) or `senpi -p --session` resume, which defers while `liveSessionHolders` reports another process on the session file.
- `packages/coding-agent/src/cli/deferred-commands.ts`: `SCHEDULE_COMMAND_ARGV` plus `dispatchScheduleCommand(args)`, an exit-code dispatch shaped like `dispatchHostCommand`.
- `packages/coding-agent/src/cli/args.ts`: one `Commands:` line in `printHelp` for `schedule`, beside `host`.

### Why

- `/loop` keeps its timers in the session process and refuses `--print`, so a headless run (a chat bridge that runs one `senpi -p` per message) could not schedule anything. Scheduled prompts are now files, and this command is the out-of-process runner that fires them.

### Why an extension could not handle it

- The runner has to outlive every session process, and CLI commands are routed before extensions load.

### Expected merge conflict zones

- LOW: one help line in `args.ts`; the tail of `deferred-commands.ts`.

## 2026-09-28 - `host shard-path|gc` in the help text (senpi#2245)

### What changed

- `packages/coding-agent/src/cli/args.ts`: the `host` line in the Commands section lists `<ensure|status|stop|handoff|shard-path|gc>`, matching the subcommands `senpi host` accepts.

### Why

- `shard-path` and `gc` are commands clients are told to call, so `--help` has to name them like the `host` usage text does.

### Why an extension could not handle it

- The help text is built by the CLI before any extension is loaded.

### Expected merge conflict zones

- `packages/coding-agent/src/cli/args.ts`: the `host` line of the Commands help block, beside `app-server daemon`.

## 2026-09-27 - `models discover` in the help text (senpi#2196)

### What changed

- `packages/coding-agent/src/cli/args.ts`: the Commands section lists `senpi models discover <provider>` after `config`.

### Why

- The new subcommand has to be discoverable from `--help`.

### Why an extension could not handle it

- The help text is built by the CLI before any extension is loaded.

### Expected merge conflict zones

- `packages/coding-agent/src/cli/args.ts`: the Commands help block after the `config` line.

## 2026-09-27 - --rebind <path|id> (senpi#2181)

### What changed

- `packages/coding-agent/src/cli/args.ts`: parses `--rebind <path|id>` into `Args.rebind` and lists it in the help text beside `--fork`.

### Why

- Scripts need a non-interactive way to move a session of a moved or re-cloned repository into the current directory; the interactive prompt alone cannot serve them.

### Why an extension could not handle it

- CLI argument parsing and session resolution run before any extension is loaded.

### Expected merge conflict zones

- `packages/coding-agent/src/cli/args.ts`: `Args` (after `fork`), the `--fork` parse branch, and the `--fork` help line.

## 2026-09-22 - --provider rejects a typed legacy provider id (senpi#1989)

### What changed

- `packages/coding-agent/src/cli/args.ts`: the `--provider` branch rejects a legacy provider id at parse time with a message naming the id it was renamed to, instead of letting it fail later as a generic unknown provider.

### Why

A user who types a renamed id must learn the new one. This is the counterpart to the read-boundary normalization: ids read from disk are normalized and never rejected, while ids the user TYPES are rejected by name. Both are driven by the same legacy map so they cannot drift apart.

### Why an extension could not handle it

CLI argument parsing runs before any extension is loaded.

### Expected merge conflict zones

- `packages/coding-agent/src/cli/args.ts` the `--provider` branch.

## 2026-09-22 - chatgpt-subscription provider id in CLI help (senpi#1989)

### What changed

- `packages/coding-agent/src/cli/args.ts`: the `--provider` usage example names `chatgpt-subscription` instead of the renamed id.

### Why

The OpenAI subscription provider id was renamed from `openai-codex` to `chatgpt-subscription` (senpi#1989): the old id named a CLI rather than the thing a user signs in with. These modules name that provider id in user-visible text or resolve it at runtime, so they move with it. The wire api id `openai-codex-responses` is deliberately NOT renamed - it names the dialect, not the provider - and neither are file names or module paths.

### Why an extension could not handle it

The provider id is resolved and rendered inside the package before any extension loads; an extension cannot rewrite an id the package has already used to build its own help text and requests.

### Expected merge conflict zones

- `packages/coding-agent/src/cli/args.ts`, against any other flag-help change.

# changes

## 2026-09-17 - `senpi host` command surface and its dispatch (senpi#1782)

### What changed

- `packages/coding-agent/src/cli/host-command.ts` (new): the command line of `senpi host ensure|status|stop|handoff` - argv into a typed `HostRequest` (`--launch-spec`, `--policy upgrade|fallback|never`, `--socket`, `--include-workers`, `--drain`, `--force`, and `--json` accepted as a no-op because the answer is always JSON), the usage text, and the ONE JSON line the contract promises. The line is written with a synchronous `writeSync(1, ...)`: `console.log` to a pipe is asynchronous, and the `process.exit` that follows would truncate the only thing the caller parses. An unknown subcommand or flag prints usage on stderr, NOTHING on stdout, and exits 2. What each request DOES lives in `src/modes/rpc/host-runner.ts` (see that tracker).
- `packages/coding-agent/src/cli/deferred-commands.ts`: `HOST_COMMAND_ARGV` plus `dispatchHostCommand(args)`, which answers an exit CODE rather than a boolean (the command classifies its outcome in that code) and `undefined` when argv selects something else. The implementation stays behind an `await import(...)`, so `dist/main.js` still does not statically reach the RPC host graph.
- `packages/coding-agent/src/main.ts`: the dispatch runs beside the app-server route, BEFORE `parseArgs`, and exits with the code it returns - so `host` never falls through into argument parsing or the interactive path.
- `packages/coding-agent/src/cli/args.ts`: one `Commands:` line in `printHelp`, beside `app-server`, because a command a client is told to call has to be discoverable from `--help`. No flag parsing changes: `host` is routed before `parseArgs` ever runs.

### Why

- Every client of the shared daemon (terminal, desktop, omo launcher, task runner) needs the same answer to "is there a host, may I use it, may I replace it", and that decision has invariants no fourth implementation should re-derive. The CLI is the one surface they all reach it through, so its contract is machine-first: one JSON line, diagnostics on stderr, an exit code that classifies the outcome without parsing the line.
- The route is a single argv[0] comparison for the same reason the package/config/app-server routes are: the module graph behind it must not be evaluated by an interactive launch.

### Why an extension could not handle it

- Command routing and process exit codes run before any extension is loaded.

### Expected merge conflict zones

- LOW: one import block and one dispatch branch in `main.ts`, and the tail of `deferred-commands.ts`.

## 2026-09-17 - `--auto-title-sessions` deprecated for shared hosts (senpi#1782)

### What changed

- `packages/coding-agent/src/cli/args.ts`: JSDoc and help for `--auto-title-sessions` mark it deprecated for shared hosts in favor of per-session `open_session.auto_title`. The flag still parses and still opts every session on that process into titling when `auto_title` is omitted.

### Why

- A host-wide flag is a launch-profile collision once two clients share one daemon. The flag stays for one release so existing hosts keep working; the help has to say so.

### Why an extension could not handle it

- CLI help and argument docs run before any extension is loaded.

### Expected merge conflict zones

- LOW: the `autoTitleSessions` JSDoc on `Args` and the `--auto-title-sessions` help row in `printHelp`.

## 2026-09-17 - `--session-runtime in-process|worker` for multi-session hosts (senpi#1782)

### What changed

- `packages/coding-agent/src/cli/args.ts`: new `SessionRuntimeKind` (`"in-process" | "worker"`), its `isSessionRuntimeKind` guard, the `Args.sessionRuntime` field, one parse branch for `--session-runtime <kind>` (an unknown value pushes a parse error diagnostic and sets nothing), one help line, and `resolveSessionRuntime(parsed)` - the single place the DEFAULT lives: `in-process` for a `--listen` socket host, `worker` for a stdio host (`--multi-session` alone, `--listen stdio://`) and for embedders. An explicit flag always wins.

### Why

- The shared socket host is one machine-wide daemon for every client, so its sessions must run in the host process with no isolate budget, while stdio hosts and embedders keep the worker runtime. Both hosts are started through the same argv, so the selection belongs in the argument layer, and a pure resolver keeps the default testable without booting a host.

### Why an extension could not handle it

- CLI argument parsing runs before any extension is loaded.

### Expected merge conflict zones

- LOW: the flag list in `Args`, the `--multi-session`/`--auto-title-sessions`/`--listen` parse branches, and the RPC block of `printHelp`.

## 2026-09-17 - One-shot command dispatch owns its own module (senpi#1781)

### What changed

- New `packages/coding-agent/src/cli/deferred-commands.ts` holds the dispatch for the commands that exit before a session exists (package manager, config, app-server, list-models, list-tips, credential print, export), each loading its implementation with `await import(...)` at its own branch.

### Why

- `main.ts` imported every one of those trees at module load, so an interactive run paid for command code it never reached; extracting the dispatch also keeps `main.ts` from growing while the imports move.

### Why an extension could not handle it

- Command dispatch happens before the extension host is constructed.

### Expected merge conflict zones

- LOW: the new module; MEDIUM where `main.ts` calls into it.

## 2026-09-16 - Startup spinner draws its first frame synchronously (oh-my-openagent#8371)

### What changed

- `packages/coding-agent/src/cli/startup-loading-indicator.ts`: `start()` writes the first frame itself (hidden cursor + label + phase) and the 120ms grace delay now gates only the animation interval; `resume()` redraws the same way before its grace timer. `setPhase()` therefore renders before any timer fires.

### Why

- The work the indicator covers is synchronous module loading (extension imports through jiti), which starves every timer until it finishes. Measured on a real pty during oh-my-openagent#8371: first spinner byte at 2.27s, a single frame before the TUI replaced it, the whole extension load on a blank terminal. A timer-driven first frame announces work that already ended.

### Why an extension could not handle it

- The indicator runs in the host before any extension is loaded; it is the thing extensions' own load time hides.

### Expected merge conflict zones

- LOW: `start()`, `resume()` and `beginAnimation()` bodies plus the class docstring; `test/startup-loading-indicator.test.ts` grace-delay cases.

## 2026-09-10 - VENICE_API_KEY in the help output

### What changed

- `packages/coding-agent/src/cli/args.ts` adds a `VENICE_API_KEY` row to the Environment Variables help block.

### Why

- The help block is where users discover which API-key providers are supported; a provider registered in `packages/ai` but absent here reads as unsupported, which is exactly how the gap was reported.

### Why an extension could not handle it

- The `--help` text is emitted by the CLI arg parser before extensions load.

### Expected merge conflict zones

- LOW: the Environment Variables list in `args.ts` when upstream adds env rows.

## 2026-09-04 - Apply terminal capability overrides to the startup TUI

### What changed

- `packages/coding-agent/src/cli/startup-ui.ts`: `createStartupTui` calls `setCapabilityOverrides` with the settings manager's resolved terminal capability overrides before registering themes, so the first painted frames honor explicit settings (and the fork's `SENPI_*` env bridge with `PI_*` fallback) instead of raw auto-detection.

### Why

- Capability auto-detection defaults conservatively (hyperlinks stay off on unknown terminals); the startup banner and theme rendering would otherwise flash the wrong link and image behavior before interactive mode applies overrides.

### Why an extension could not handle it

- The startup TUI is constructed before extensions load; capability detection and theme registration are host-owned boot steps.

### Expected merge conflict zones

- LOW: `packages/coding-agent/src/cli/startup-ui.ts` ordering inside `createStartupTui` during upstream syncs.

## Opt-in session auto-titling flag (2026-08-28)

### What changed

- `packages/coding-agent/src/cli/args.ts` adds `--auto-title-sessions` (`Args.autoTitleSessions`) and a help row for it, so non-interactive launches can request engine-side session titles.

### Why

- RPC hosts (the desktop app spawns `--mode rpc --multi-session`) had no way to enable session auto-titling, which was hardcoded to interactive mode only.

### Why an extension could not handle it

- Flag parsing happens in the entrypoint before extension flags are registered, and the value is consumed while the first session is constructed.

### Expected merge conflict zones

- LOW: the `Args` fields, the parse branch beside `--multi-session`, and the help rows in `args.ts`.

## CLI argument surface re-diverges from upstream dcd4619 (2026-08-25)

### What changed

- `packages/coding-agent/src/cli/args.ts` keeps the fork flags on top of upstream's parser:
  `--list-tips`, the gated `--grok-neo` chrome switch (via `grok-neo-gate.ts`), and
  `--multi-session` for independently routed plain-RPC sessions over one stdio process.

### Why

These are fork-owned product surfaces (senpi branding, provider wire behavior, fork runtime features) that upstream does not carry; the sync must re-assert them on top of upstream's tree.

### Why this lives in the fork

The divergence lives in core wiring, package identity, or build plumbing that executes before any extension loads, so no extension hook can express it.

### Expected merge conflict zones

- The `Args` interface and the `parseArgs` flag chain in `packages/coding-agent/src/cli/args.ts`.

## RPC Unix-socket listener flag (2026-08-23)

### What changed

- `packages/coding-agent/src/cli/args.ts` recognizes `--listen` when `--mode rpc` is active, records the listener address, and enables the multi-session host; the help surface documents stdio, Unix URL, and direct path forms.

### Why

- The multi-connection RPC host needs a first-class CLI listener address without stealing `--listen` from unrelated root/experimental command parsing.

### Why an extension could not handle it

- RPC mode selection and listener startup occur before extension flags are loaded.

### Expected merge conflict zones

- LOW: the `Args` fields, parse branch, and help rows in `args.ts`.


## Fork CLI flags and branded help retained over upstream 59a71b23 (2026-08-19)

### What changed

- `packages/coding-agent/src/cli/args.ts` stays divergent from upstream
  `59a71b235dadb4ad0d67557a8abb0aaa093e68b4` after the pin advance: `parseArgs()` keeps the fork flags
  `--list-tips`, `--multi-session`, and the gated `--grok-neo` (accepted only when `isGrokNeoEnabled()` from
  `grok-neo-gate.ts` allows it, with the matching help row emitted conditionally), and `printHelp()` takes the
  `grokNeoEnabled` parameter that drives that row.
- `args.ts` help text remains branded and fork-scoped: commands render through `APP_NAME` (including
  `senpi update [source|self|senpi]`), the `list`/`config` rows carry the fork's `--approve`/`--no-approve`
  arguments, the `app-server` command and daemon rows plus their usage examples are listed, `--theme` documents
  register-not-select semantics, and the environment block keeps `OLLAMA_API_KEY`, `OPENGATEWAY_API_KEY`,
  `ALIBABA_TOKEN_PLAN_API_KEY`, and the `PI_RULES_*` caps.

### Why

- The flags and help rows describe fork-only runtime surfaces (tips catalog, grok chrome, multi-session RPC host,
  app-server transport, fork-only providers, rules limits) that the new upstream tree has no equivalent for, so
  taking upstream's parser and help template verbatim would silently drop working CLI entry points.

### Why an extension could not handle it

- Argument parsing and the top-level help surface run before extension flags are registered; extension-provided
  flags are appended to this template, not able to replace it.

### Expected merge conflict zones

- MEDIUM: the `printHelp()` template literal (upstream edits command/option/environment rows frequently);
  LOW: the `Args` interface fields and the flag branches in the `parseArgs()` scan loop.

## Repository audit baseline for the CLI tracker (2026-08-17)

### What changed

- This entry is the canonical inventory for the repository-wide changes.md audit (`scripts/audit-changes-md.mjs`, pin
  `914cf1472e715297caa30db4b9535d534a9eb718`, tag v0.84.2). It assigns every audited production path whose exact
  nearest tracker is this file, summarizing each fork delta; the dated history below it remains authoritative for the
  feature narrative.
- `packages/coding-agent/src/cli/args.ts`: `--list-tips`, the gated `--grok-neo` flag and help row (via
  `grok-neo-gate.ts`), `--multi-session`, app-server command/usage/example rows, the `--theme` register-not-select
  wording, and environment-help rows for `OLLAMA_API_KEY`, `OPENGATEWAY_API_KEY`, `ALIBABA_TOKEN_PLAN_API_KEY`, and
  the `PI_RULES_*` limits.
- `packages/coding-agent/src/cli/config-selector.ts` and `packages/coding-agent/src/cli/startup-ui.ts`: startup TUIs
  construct `TUI` over `ProcessTerminal` with the external-stdout guard so stray startup `console.log` output is
  hidden and redacted into the debug log (2026-07-04 entry below).
- `packages/coding-agent/src/cli/project-trust.ts`: `toExtensionMode()` maps the `app-server` app mode to the `print`
  extension mode instead of falling through.
- `packages/coding-agent/src/cli/list-models.ts`: returns early when the listing signal already aborted and reads the
  registry snapshot via `getModels()` instead of an async availability expansion.
- `packages/coding-agent/src/cli/initial-message.ts`: `initialTitlePrompt` extraction (own entry below).

### Why

- The pre-backfill audit reported these paths as uncovered because the entries that describe them predate the
  canonical four-section format (their conflict-zone headings carried suffixes) or never named the exact path. This
  inventory closes that gap without rewriting accurate history below.

### Why an extension could not handle it

- Tracker coverage is repository policy enforced by repository scripts before any extension loader exists; the paths
  themselves are pre-extension CLI surfaces.

### Expected merge conflict zones

- NONE for this inventory: the tracker merges to `ours` and the path list is pin-relative.

## First-prompt session title capture in initial-message assembly (2026-08-17)

### What changed

- `packages/coding-agent/src/cli/initial-message.ts`: `InitialMessageResult` gained `initialTitlePrompt`.
  `buildInitialMessage()` keeps the first CLI message available as the title prompt when the initial prompt has no
  private context — no piped stdin, no `@file` text, no attached images — while still folding that message into the
  initial prompt it returns. `main.ts` threads the value into interactive mode's `sessionTitlePrompt`.

### Why

- Auto title generation previously had no clean candidate for a plain one-message launch; reusing the first prompt
  gives the session a meaningful title without exposing stdin or file context that may be private.

### Why an extension could not handle it

- The initial message is assembled before the session and its extension runner exist; the title prompt must ride the
  same pre-session result object.

### Expected merge conflict zones

- LOW: the `InitialMessageResult` interface and the title-prompt derivation in `buildInitialMessage()`.

## `OPENGATEWAY_API_KEY` in `--help` environment list (2026-08-12)

### What changed

- `args.ts`: the `Environment Variables:` help block lists `OPENGATEWAY_API_KEY` (with the
  https://opengateway.ai/api-keys issuance URL) next to the other provider keys.

### Why

- The new `opengateway` built-in provider authenticates with this variable; the help block is the
  in-CLI discovery surface and stays exhaustive per provider-add convention.

### Expected merge conflict zones

- LOW: `args.ts` environment-variable help rows.

## PI_RULES environment settings in top-level help (2026-08-03)

### What changed

- `args.ts`: the Environment Variables section now lists `PI_RULES_DISABLED`,
  `PI_RULES_MAX_RULE_CHARS`, and `PI_RULES_MAX_RESULT_CHARS` with their accepted values and defaults.

### Why

- The settings added in #670 were documented in the README but omitted from `senpi --help`, leaving the two
  environment-only character limits undiscoverable from the CLI.

### Why extension system couldn't handle this

- The static Environment Variables section belongs to `printHelp()` and extensions can register flags, not help
  entries for environment settings.

### Expected merge conflict zones on next upstream sync

- LOW: `args.ts` Environment Variables rows.

## `senpi --list-tips` prints the tip catalog as JSON (2026-07-29)

### What changed

- `args.ts`: added the `--list-tips` boolean flag next to `--list-models`, with a help row.
- `list-tips.ts` (new): `collectTips()` renders every `TIP_DEFINITIONS` entry through the default
  `KeybindingsManager` (the same construction the tips tests use for live keys) into
  `{id, text, requiresCommand?}` records; `listTips()` prints the array as 2-space-indented JSON.
- `main.ts`: mirrors every `--list-models` dispatch branch for the new flag - plain runtime metadata
  command, in-memory session manager, early exit before first-time setup, and print-mode project
  trust - except the flag needs no model runtime, so it prints and exits without creating
  agent-session services.
- Coverage: `test/suite/list-tips.test.ts` pins the full catalog id order (including
  `fallback-chains-setting`), non-empty rendered text, and `requiresCommand` gating.

### Why

- The tip catalog teaches most of the fork's surface but was only visible one line at a time; a
  JSON dump gives scripts and the give-me-tips skill the whole catalog in one pass.

### Why extension system couldn't handle this

- Flag parsing and pre-runtime dispatch run before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `args.ts` flag table and parse branches.
- LOW: `main.ts` dispatch branches; `list-tips.ts` is additive.

## Removed legacy `--neo` CLI flags and launcher plumbing (2026-07-26)

### What changed

- Removed the gated `--neo` flag family, help text, launcher modules, and early-dispatch path. Unknown long flags continue to use the extension-flag channel.

### Why

- The retired Go TUI no longer has a supported entry point.

### Expected merge conflict zones on next upstream sync

- LOW: removal-only change in fork-owned CLI glue.

## System-prompt flags forwarded to the neo launcher argv (2026-07-18)

### What changed

- `neo/build-argv.ts`: forwards `--system-prompt` and repeated
  `--append-system-prompt` from the parsed classic argv so the Go client can put
  them in the handshake `runtimeOptions` (daemon side in
  `../modes/rpc/changes.md` 2026-07-18).

### Why

- The launcher forwards every runtime-relevant flag; these two were parsed but
  dropped, so neo clients silently lost them through the shared daemon.

### Why extension system couldn't handle this

- Pre-runtime launcher argv construction; extensions are not loaded yet.

### Expected merge conflict zones on next upstream sync

- LOW: `neo/` is fork-only.

## Neo launcher flags and daemon plumbing (2026-07-06)

### What changed

- `args.ts`: added `--neo`, `--neo-isolated`, hidden `--neo-bin`, and `--listen <path>`. (History: a gated `--neo`
  flag first landed 2026-05-18, was removed with the TS neo-tui package on 2026-05-26, and returned 2026-07-06 for
  the Go TUI handoff.)
- `neo/` (fork-only): `launch.ts`, `build-argv.ts`, `platform.ts`, `resolve-binary.ts`, `daemon-launch.ts` — resolves
  the per-platform `@code-yeongyu/senpi-neo-tui-<platform>-<arch>` binary (`SENPI_NEO_BIN` → `--neo-bin` →
  `require.resolve`), builds child argv, and launches the shared daemon.

### Why

- The neo Go TUI ships as a separate binary; the CLI owns flag parsing and binary resolution for the handoff
  (dispatch in `../changes.md` 2026-07-06, daemon serving in `../modes/rpc/changes.md`).

### Why extension system couldn't handle this

- Flag parsing and pre-runtime dispatch run before extensions load.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `args.ts` flag table and parse branches.
- LOW: `neo/` (fork-only directory).

## External stdout guard wiring in startup UIs (2026-07-04)

### What changed

- `config-selector.ts` and `startup-ui.ts`: wire the `ProcessTerminal` external stdout guard so stray `console.log`
  output during startup dialogs (trust prompt, onboarding, session picker) and the config selector is hidden from the
  screen and appended, redacted, to the debug log.

### Why

- QA showed a stray `console.log` corrupting the trust dialog (core/log side in `../core/changes.md` 2026-07-04).

### Why extension system couldn't handle this

- Startup dialogs run before extensions load.

### Expected merge conflict zones on next upstream sync

- LOW: TUI construction sites in `config-selector.ts` / `startup-ui.ts`.

## App-server subcommand args (2026-07-02)

### What changed

- `args.ts`: added `senpi app-server` subcommand parsing (`--listen ws://…`, stdio) with 2026-07-03 review
  hardening; `project-trust.ts` threads the `app-server` app mode through trust resolution.

### Why

- The fork's app-server mode needs CLI plumbing next to the existing modes (dispatch in `../changes.md` 2026-07-02).

### Why extension system couldn't handle this

- Subcommand parsing precedes extension loading.

### Expected merge conflict zones on next upstream sync

- MEDIUM: `args.ts` subcommand/flag parsing.
- LOW: `project-trust.ts` mode threading.

## Full model catalog in `model` command (2026-06-21)

### What changed

- `list-models.ts`: the `model` command lists the full catalog instead of only the narrowed/favorite subset.

### Why

- With the fork's `favoriteModels` narrowing (see `../core/changes.md` favorite-model entries), the command otherwise
  hid installable models users wanted to switch to.

### Why extension system couldn't handle this

- The `model` command's listing is built-in CLI behavior.

### Expected merge conflict zones on next upstream sync

- LOW: `list-models.ts` catalog listing.

## Senpi package command wording (2026-05-02)

### What changed

- `args.ts`: Top-level help now documents `senpi update` as updating senpi instead of pi.

### Why

- The forked CLI should not tell users that self-update targets upstream pi.

### Why extension system couldn't handle this

- The built-in help text is emitted before extension-registered flags are appended.

### Expected merge conflict zones on next upstream sync

- LOW: package-command rows in `printHelp()`.

## Upstream sync (upstream/main@71dca871) integration repairs (2026-09-12)

### What changed

- `packages/coding-agent/src/cli/config-selector.ts`: the startup selector builds the fork `TUI` (not upstream's `TuiMainScreen`) on a `ProcessTerminal({ onExternalStdoutWrite: appendHiddenTuiStdout })` and drops the `agentDir` log-directory argument, while taking upstream's `getShowHardwareCursor()` and `setClearOnShrink(getClearOnShrink())` wiring.

### Why

- The fork renderer owns its log directory and routes stray stdout into the hidden TUI log; the startup selector must match `createStartupTui` so both startup paths behave the same.

### Why an extension could not handle it

- The selector runs before any session or extension exists.

### Expected merge conflict zones

- LOW: the `new TUI(...)`/`new ProcessTerminal(...)` construction in `showConfigSelector`.

## Adopted upstream v1.0.0 CLI argument handling (2026-10-02)

### What changed

- `packages/coding-agent/src/cli/args.ts` — upstream argument parsing with the fork's rule that `--provider` requires `--model` (D-7).

### Why

The `--provider`/`--model` pairing is a fork behaviour; upstream's parser changes are adopted underneath it.

### Why an extension could not handle it

CLI argument semantics live in the executable entry, below any extension hook.

### Expected merge conflict zones

Upstream edits to cli/args.ts at the next sync.
