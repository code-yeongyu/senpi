# changes

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
