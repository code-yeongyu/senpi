# changes

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
