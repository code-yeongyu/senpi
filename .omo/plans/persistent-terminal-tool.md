# persistent-terminal-tool - Work Plan

## TL;DR (For humans)

**What you'll get:** A complete persistent-terminal capability for senpi. A PTY-backed `bash` tool gains Claude-Code-shaped background execution, plus four new snake_case companion tools — `bash_output`, `kill_bash`, `bash_input`, `bash_resize` — that let the model run long-lived interactive sessions, steer them (send stdin/keys), resize them, snapshot the live screen, subscribe to output (regex `wait_for`), and tear them down cleanly. Backed by a new in-house Rust NAPI-RS PTY crate (portable-pty) that loads on **both Node and Bun** and runs **natively on Windows (ConPTY)**, with an `@xterm/headless` screen model on the JS side and a pipe fallback when native is unavailable. Windows is first-class (Git Bash auto-detect + `SENPI_GIT_BASH_PATH`, no bundling). CI grows real Windows + macOS + Linux jobs and a per-OS native-prebuild pipeline. Any senpi-defined PascalCase tool names are renamed to snake_case (discovery-driven — the previously-cited `SearchWeb`/`FetchURL` were already removed upstream, so C7 may find few/none) plus a convention guard that keeps future tool names snake_case.

**Why this approach:** Claude Code's `Bash`/`BashOutput`/`KillShell` model is the cleanest base (the user asked for CC-closest), but it has no stdin steering, no resize, no screen model, and no event subscription — gaps that codex (`write_stdin`), omo (`monitor_*` + idle-wake injection), tui-mcp (`wait_for_text`/`wait_for_idle`), and dori/oh-my-pi (PTY snapshot/resize) each fill. node-pty is officially unsupported on Bun (senpi ships a Bun binary), so a self-owned Rust NAPI-RS crate — the approach both oh-my-pi and dori independently chose — is the only way to be "완전히 돌아가는" on Node + Bun + Windows-native. `@xterm/headless` (already in-tree) is the mature screen model; the `.node`-beside-binary vendoring pattern is already proven by `packages/tui`.

**What it will NOT do (Must-NOT-Have):** No user-facing interactive attach overlay (oh-my-pi `bash-interactive`-style TUI takeover) — model-facing tool suite only, with live tail/screen rendering in tool results. No SSH/remote PTY backend. No MCP. No tmux dependency. No renaming of provider-fixed tool names (only senpi-defined names). No v1/v2/MVP staging: this is one complete build.

**Effort:** Large / Architecture-scale. 8 waves, 37 build todos + 4 final-verification gates, new Rust crate + new TS package + builtin extension + CI matrix. Delivered as 2+ atomic PRs (rename PR lands first; terminal suite PR(s) follow).

**Risk:** Medium-High. Chief risks: (1) `.node` loading inside `bun build --compile` output — mitigated by pi-tui precedent + explicit Bun-binary QA gate; (2) Windows ConPTY quirks — mitigated by portable-pty + native input normalization + a real Windows CI job; (3) Rust toolchain added to a TS monorepo — accepted by user ("CI 번잡해지는 건 괜찮아"), isolated to `crates/` + a prebuild pipeline; (4) renaming provider tool names could break provider APIs — gated by a senpi-defined-vs-provider-fixed check.

**Decisions locked:** snake_case CC-close naming + repo-wide PascalCase→snake_case rename (C7); Windows = detect + `SENPI_GIT_BASH_PATH` + PowerShell/cmd via `shellPath`, no bundling; native = own Rust NAPI-RS crate (portable-pty) + `@xterm/headless`, Node+Bun+Windows; TDD + hardcore real-scenario manual QA; per-wave oracle/deep verification task.

---

## Scope

### IN
- New Rust NAPI-RS crate `crates/senpi-pty` wrapping `portable-pty`: spawn / write / resize / signal / kill(tree) / wait-exit / raw-byte streaming; ConPTY on Windows; Windows input normalization; version sentinel export.
- New TS workspace package `packages/pty` (private, bundled): NAPI loader (Node+Bun, prebuild selection, sentinel check), `PtySession` wrapper, `SessionRegistry` (lifecycle, caps, sweeps), `@xterm/headless` screen model, raw tail buffer, **pipe fallback** mode.
- Builtin extension `packages/coding-agent/src/core/extensions/builtin/terminal/`: replaces core `bash` with a PTY-backed `bash` (adds `run_in_background`, `description`, `cols`, `rows`) and registers `bash_output`, `kill_bash`, `bash_input`, `bash_resize` (snake_case, CC-close). Mutually exclusive with `anthropic-bash` (steps aside when `PI_ANTHROPIC_BASH` native bash is active — no orphaned companions). Integrates permission-system (with `bash_input` gated as command execution), bash-timeout (mode-aware: background sessions survive the injected default timeout), and existing renderers.
- Subscription/wait: blocking `bash_output(block, wait_for, timeout)`; async completion/pattern wake via `sendUserMessage({deliverAs:"followUp"})` with idle guards; configurable (`wake`/`next-turn`/`off`).
- TUI: live tail + status rendering in tool results, optional rendered-screen preview, `ctx.ui.notify` notifications.
- Windows platform: portable-pty ConPTY, Git-Bash-first resolution by EXTENDING `getShellConfig` (add `SENPI_GIT_BASH_PATH` env + shell-KIND resolution so cmd `/c` and PowerShell `-NoProfile -Command` actually work via `shellPath`, not just bash), `taskkill` tree-kill, sentinel for locked-file updates.
- **C7:** discovery-driven rename of any senpi-defined PascalCase tool names to snake_case (kimi `SearchWeb`/`FetchURL` were already removed upstream — the list may be empty) + a snake_case tool-name convention guard; update prompt snippets, permission rules, docs, tests, changelogs.
- Packaging: vendored per-OS `.node` prebuilds under `packages/pty/native/prebuilds/`; bundledDependencies; shrinkwrap; supply-chain pinning; Bun-binary asset wiring; updating the hardcoded monorepo machinery (`build-all` BUILD_PHASES; `prepare-senpi-bundled-workspaces` bundledWorkspaces + `native/**` copy filter + pack assertion; `release-packages`/`release-changelog`/`sync-versions`/`local-release`/`publish`/`release-artifacts` + tests) to include `@earendil-works/pi-pty`.
- CI: `windows-latest` + `macos-latest` + `ubuntu-latest` test matrix; native prebuild build workflow (real OS runners); Rust toolchain; prebuild freshness guard; senpi-qa terminal channel; infra-sync (devenv-setup, devcontainer, docs, CONTRIBUTING, env-vars).

### OUT (Must-NOT-Have)
- User-facing interactive attach overlay / TUI takeover of a running PTY.
- SSH / remote / container PTY backends.
- MCP integration.
- tmux-based sessions (POSIX-only; rejected).
- Renaming provider-fixed tool names (only senpi-owned names change).
- Any v1/v2/MVP phasing or feature-flag half-measures.
- Upgrading `@xterm/headless` beyond the lockfile version unless a required API forces it.

---

## Verification strategy

- **TDD everywhere.** Every implementation todo starts with a failing test (Rust `#[test]`/`cargo test`, TS vitest, or coding-agent `test/suite/harness.ts` faux-provider). Implement to green, then refactor.
- **Hardcore manual QA with real scenarios** (Q4). Every user-facing wave ends with real CLI drives through senpi-qa channels — including a NEW `scripts/pty-drive.mjs` terminal channel — with evidence written to `local-ignore/qa-evidence/<YYYYMMDD>-<slug>/`. Concrete scenarios (background sleep→`wait_for`, python REPL via `bash_input`, full-screen TUI resize via `bash_resize`+`view:screen`, `kill_bash` orphan check, ConPTY on Windows). A green `npm run check` / `npm test` is NOT QA.
- **Per-wave verification task** (standing rule): each wave ends with a read-only `oracle`/`superoracle` audit OR a `deep` agent QA-execution task that independently confirms the wave's acceptance criteria and evidence.
- **Cross-OS proof:** the terminal channel runs in CI on Windows + macOS + Linux; PTY tests must PASS (not skip) on Windows. Bun-binary load is QA'd on all three.
- **Isolation invariant:** every QA run asserts real `~/.senpi/agent/auth.json` sha256 unchanged, uses a temp sandbox, spends zero tokens (mock loop / faux provider).
- **250 pure LOC/file ceiling** enforced on every new Rust and TS file; split by responsibility.
- **Final wave F1-F4** (below) all APPROVE before done.

---

## Execution strategy

- **Parallel git worktrees + TDD.** Independent waves run concurrently in separate worktrees off `main`, one worker (deep/quick agent) per worktree, TDD each, merged back via merge-commit PRs.
- **Dependency-ordered waves:**
  - **W0 build foundations** (crate skeleton + NAPI build + Rust toolchain + CI rust setup + prebuild scaffold) — blocks all PTY work.
  - **W1 Rust PTY core** → **W2 TS runtime (session/registry/screen/fallback)** → **W3 tool surface** → **W4 subscription+notify+TUI** → (**W7 full cross-OS manual QA**).
  - **W5 (C7 rename)** is INDEPENDENT of PTY work — runs in its own worktree from the start, lands as the FIRST PR.
  - **W6 packaging + CI matrix + infra-sync + docs** partially parallel; native-build workflow needs W0, freshness guard needs prebuilds from W1.
- **PR decomposition:** PR-A = C7 rename (small, merge first). PR-B = terminal suite (native+runtime+tools+notify+TUI+packaging+CI+QA); split into PR-B1 (crate+runtime) and PR-B2 (tools+notify+CI+QA) if the diff grows too large. Each PR: branch → TDD+QA evidence → `gh pr create` (reviewer-readable English, QA/evidence section) → CI green → review-work + optional dual review → `gh pr merge --merge --delete-branch`.
- **Fork-strategy discipline:** minimize core edits; prefer the builtin-extension swap (gpt-apply-patch precedent). Every touched upstream file gets a `changes.md` entry. Keep `packages/pty` self-contained.

---

## Todos

### Wave 0 — Build foundations (blocks all native work)

- [ ] 1. **[W0.1] `crates/senpi-pty/Cargo.toml` + repo `Cargo.toml` workspace + `rust-toolchain.toml`: scaffold NAPI-RS crate — expect `napi build` to emit a loadable `.node`.**
  - References: oh-my-pi `packages/natives` (Cargo.toml, build.rs, napi-rs setup) + repo-root `Cargo.toml`/`rust-toolchain.toml`; dori `packages/dori-pty/Cargo.toml`, `build.rs`. Deps: `napi` (v3), `napi-derive`, `portable-pty` (0.9.x), `napi-build`. Pin exact versions.
  - Acceptance: `napi build --platform` in `crates/senpi-pty` produces a `.node` exporting a `version()` sentinel; `cargo test` runs.
  - QA happy: build locally, `node -e "require('./<built>.node')"` loads and calls sentinel → prints version. QA failure: corrupt the sentinel name → loader throws a clear load-time error (not `<sym> is not a function`). Evidence: build log + load transcript.
  - Commit: `feat(pty): scaffold senpi-pty Rust NAPI crate + cargo workspace`

- [ ] 2. **[W0.2] `packages/pty/package.json` (name `@earendil-works/pi-pty`) + `native/index.js` loader + generated `native/index.d.ts`: create the bundled TS package wired to the crate — expect `import { PtySession } from "@earendil-works/pi-pty"` type-resolves.**
  - References: oh-my-pi `packages/natives/native/index.js` (loader) + `native/index.d.ts` (NAPI-generated) + version-sentinel; senpi `packages/tui/package.json` (MIRROR it: `private:true`, name `@earendil-works/pi-*`, `files[]` includes `native/**/prebuilds/**/*.node`), root `package.json` `workspaces`. NAME MUST be `@earendil-works/pi-pty` so `scripts/generate-coding-agent-shrinkwrap.mjs:12,140` (`internalPackagePrefix="@earendil-works/pi-"`) auto-detects it as a bundled internal workspace with NO generator change; vendored prebuilds ship in the package's own `files[]` (inBundle) with NO install/lifecycle script → no shrinkwrap allowlist entry.
  - Acceptance: package name `@earendil-works/pi-pty`, `private:true`, `files[]` includes `native/**/prebuilds/**/*.node`; builds; exports typed loader; added to root `workspaces`; added to `scripts/build-all.mjs` `BUILD_PHASES` phase 1 (`:23-28`, alongside tui/ai so it builds BEFORE agent/coding-agent) + `scripts/build-all.test.mjs` updated (mirrors pi-tui exactly).
  - QA happy: `npm run build` resolves the package; `npm run check` passes. QA failure: host prebuild missing → loader returns a typed `null` (native-unavailable) with a clear diagnostic and does NOT crash (the actual pipe-fallback RUN is proven in todo 12, not here). Evidence: check/build logs.
  - Commit: `feat(pty): add @earendil-works/pi-pty package + NAPI loader`

- [ ] 3. **[W0.3] `.github/workflows/native-prebuilds.yml`: per-OS native build workflow (win32 x64/arm64, darwin x64/arm64, linux x64/arm64) — expect it uploads a `.node` artifact per target.**
  - References: oh-my-pi `.github/workflows/ci.yml` native-artifact jobs + `oh-my-pi/packages/natives/CHANGELOG.md` (Linux addon glibc floor pinned to **2.17** for portability — MATCH this, NOT 2.35, or older distros can't dlopen the CLI); senpi `.github/workflows/build-binaries.yml` (artifact staging). Build tooling: `@napi-rs/cli` (`napi build`) as a crate/package devDep; win32-arm64 via cargo cross-target (`aarch64-pc-windows-msvc`) rather than a hosted Windows-arm64 runner (mark win32-arm64 cross-compiled/best-effort).
  - Acceptance: workflow builds all targets (linux x64/arm64 via cargo-zigbuild **glibc 2.17 floor**; darwin native; win32-x64 native; win32-arm64 cross-compiled), uploads a `.node` artifact per target.
  - QA happy: dispatch workflow → all matrix legs green, artifacts present. QA failure: a target fails → job red with actionable log; other targets still upload. Evidence: workflow run URL + artifact list (linked in PR).
  - Commit: `ci(pty): add per-OS native prebuild workflow`

- [ ] 4. **[W0.4] `rust-toolchain.toml` + `scripts/devenv-setup.mjs` (`--with-native`) + `.devcontainer/devcontainer.json` + `CONTRIBUTING.md`: infra-sync for the Rust toolchain — expect a fresh clone can build native optionally, and the prebuilt path needs no Rust.**
  - References: AGENTS.md infra-sync table; senpi `scripts/devenv-setup.mjs`, `.devcontainer/devcontainer.json`, `CONTRIBUTING.md` prerequisites.
  - Acceptance: `--with-native` installs/pins Rust + builds crate; default setup uses vendored prebuild (no Rust required); devcontainer documents Rust as optional.
  - QA happy: run `devenv-setup.mjs` (no flag) on a clean checkout → builds using prebuild, no cargo. QA failure: `--with-native` without Rust → clear install guidance. Evidence: setup transcripts (with/without flag).
  - Commit: `chore(pty): wire Rust toolchain into devenv + devcontainer + docs`

- [ ] 5. **[W0.5][verify] oracle audit of W0 foundations — expect confirmation the crate/loader/CI-build/toolchain wiring is coherent and cross-platform-sound.**
  - References: todos 1-4 outputs; librarian report (napi-rs Bun compat, cargo-zigbuild glibc floor).
  - Acceptance: `task(subagent_type="oracle", ...)` returns APPROVE on: workspace layout, napi version, prebuild target list completeness (incl. arm64), sentinel design, Bun-N-API compatibility assumption.
  - QA: the oracle transcript IS the evidence; any finding folded before W1 starts. Evidence: oracle session id + verdict saved to qa-evidence.
  - Commit: (no code) — record verdict in PR description.

### Wave 1 — Rust PTY core (TDD)

- [ ] 6. **[W1.1] `crates/senpi-pty/src/session.rs` (+ `pty/open.rs`): `PtySession::start(opts, on_chunk)` over portable-pty — expect a spawned process streams raw bytes and resolves `{exitCode, cancelled, timedOut}`.**
  - References: oh-my-pi `PtyStartOptions`/`PtyRunResult` shape (index.d.ts:1273-1304), dori `pty/open.rs` (`native_pty_system()`), codex `utils/pty/src/pty.rs`. Options: `{command, cwd?, env?, timeoutMs?, cols?, rows?, shell?, shellArgs?, commandTransport?("argv"|"stdin")}` — the caller (terminal extension) resolves the shell + args + transport per shell kind (bash `-c`, WSL bash `-s`/stdin, cmd `/c`, powershell `-NoProfile -Command`) and passes them so PTY spawn honors non-bash shells; pty stays shell-agnostic.
  - Acceptance: `cargo test` — spawn `echo hi` streams "hi", resolves exitCode 0; timeout path sets `timedOut`.
  - QA happy: unit test asserts streamed bytes + exit code. QA failure: nonexistent command → error surfaced, not panic. Evidence: `cargo test` output.
  - Commit: `feat(pty): PtySession spawn + streaming over portable-pty`

- [ ] 7. **[W1.2] `crates/senpi-pty/src/session.rs`: `write`, `resize(cols,rows)`, `signal`, `kill` (tree) — expect stdin write reaches the child, resize changes winsize, kill terminates the tree.**
  - References: dori `pty/lifecycle.rs` (resize/signal, TERM→500ms→KILL), oh-my-pi `Process.killTree`, codex `ProcessHandle::resize` (TIOCSWINSZ / ConPTY COORD).
  - Acceptance: `cargo test` — write to a `cat` echoes back; resize reflected via `stty size`; kill leaves no child (poll process table).
  - QA happy: interactive `cat` round-trip test. QA failure: write after exit → benign error, no panic. Evidence: `cargo test` output.
  - Commit: `feat(pty): stdin write, resize, tree-kill`

- [ ] 8. **[W1.3] `crates/senpi-pty/src/win/` (ConPTY + `windows_input.rs`): Windows PTY path + input normalization — expect ConPTY spawn works and LF→CR / CRLF-collapse / BS→DEL normalization is applied.**
  - References: codex `utils/pty/src/win/conpty.rs` + `windows_input.rs`; portable-pty ConPtySystem; oh-my-pi Windows notes. (portable-pty provides ConPTY; add input normalization + resize COORD.)
  - Acceptance: `#[cfg(windows)]` tests — spawn `cmd /c echo hi` via ConPTY streams output; normalization unit tests pass.
  - QA happy (Windows CI): ConPTY echo test. QA failure: ConPTY unavailable (old Windows) → typed error the loader can catch for fallback. Evidence: Windows `cargo test` log (CI).
  - Commit: `feat(pty): Windows ConPTY path + input normalization`

- [ ] 9. **[W1.4] `crates/senpi-pty/src/lib.rs`: version sentinel export + NAPI surface finalize — expect the `.node` exposes `PtySession` + `__senpiPtyV<maj>_<min>_<patch>()` matching package.json.**
  - References: oh-my-pi version-sentinel export (`__piNativesV16_3_7`, index.d.ts:155-173) + release-bump policy; senpi `scripts/release.mjs`.
  - Acceptance: sentinel name derived from `packages/pty/package.json#version`; loader verifies it (todo 11). Release script bumps it.
  - QA happy: loader accepts matching sentinel. QA failure: mismatched sentinel → clear load-time error. Evidence: unit test for sentinel match/mismatch.
  - Commit: `feat(pty): version sentinel export for locked-file safety`

- [ ] 10. **[W1.5][verify] `deep` agent QA of W1 native core across the CI OS matrix — expect green cargo tests on linux+macos+windows with evidence.**
  - References: todos 6-9; native-prebuilds workflow (todo 3).
  - Acceptance: deep agent runs/collects `cargo test` on all three OS (via CI dispatch), confirms tree-kill leaves no orphans, resize works, ConPTY passes; writes evidence.
  - QA: matrix logs saved to qa-evidence. Evidence: three-OS cargo-test logs + orphan-check.
  - Commit: (no code) — evidence in PR.

### Wave 2 — TS runtime: session, registry, screen, fallback (TDD)

- [ ] 11. **[W2.1] `packages/pty/src/loader.ts`: prebuild selection + sentinel check + Node/Bun detection — expect the correct `.node` loads on Node and Bun, else returns `null` (→ fallback).**
  - References: senpi `packages/tui/src/terminal.ts:426-444` — the CONFIRMED load pattern to copy exactly: `createRequire(import.meta.url)` + a candidate-path search `[moduleDir/../native/…, moduleDir/native/…, path.dirname(process.execPath)/native/…]` with silent try/catch fallthrough (the 3rd candidate is the Bun-binary sidecar path). Also `packages/tui/src/native-modifiers.ts:1-52` (darwin variant). oh-my-pi loader (`__ompInstallTokioRuntime`, sentinel); librarian (Bun N-API support).
  - Acceptance: vitest — loads host prebuild; wrong-arch/missing → `null`; sentinel mismatch → throws typed error.
  - QA happy: `node` + `bun` both load host prebuild (script drives both runtimes). QA failure: renamed `.node` → fallback null, no crash. Evidence: node+bun load transcripts.
  - Commit: `feat(pty): native loader with sentinel + Node/Bun support`

- [ ] 12. **[W2.2] `packages/pty/src/pipe-fallback.ts`: child_process pipe backend implementing the same session interface — expect non-PTY exec works (degraded, no screen) when native is unavailable.**
  - References: senpi `core/tools/bash.ts` `createLocalBashOperations` (spawn), `utils/shell.ts` `getShellConfig`.
  - Acceptance: vitest — runs a command via pipes, streams output, exit code; `bash_input`/`bash_resize` no-op gracefully with a clear "not a PTY" note.
  - QA happy: force fallback (env `SENPI_PTY_FORCE_PIPE=1`) → command still runs. QA failure: resize in pipe mode → informative error, session survives. Evidence: fallback drive log.
  - Commit: `feat(pty): pipe fallback backend`

- [ ] 13. **[W2.3] `packages/pty/src/session.ts`: `TerminalSession` wrapping native-or-fallback + raw tail buffer — expect write/resize/kill/waitExit + a bounded raw-output tail.**
  - References: oh-my-pi `bash-interactive.ts` session wiring; senpi `core/tools/output-accumulator.ts` + `truncate.ts` (tail policy, DEFAULT_MAX_LINES/BYTES).
  - Acceptance: vitest — session exposes `write/resize/kill/waitExit/onData`; tail buffer bounded to truncate.ts limits; exit state tracked.
  - QA happy: session lifecycle test. QA failure: double-kill idempotent. Evidence: vitest output.
  - Commit: `feat(pty): TerminalSession wrapper + bounded tail`

- [ ] 14. **[W2.4] `packages/pty/src/screen.ts`: `@xterm/headless` screen model fed raw bytes — expect a snapshot (visible grid + scrollback + cursor) and reflow on resize.**
  - References: oh-my-pi `bash-interactive.ts` xterm-headless usage (120x40, scrollback 10k, lazy import), librarian (xterm-headless API, serialize/reflow); senpi `packages/tui` xterm-headless test usage.
  - Acceptance: vitest — feed ANSI, `snapshot()` returns expected visible lines; resize reflows; scrollback capped.
  - QA happy: full-screen sequence (cursor moves + clear) → correct grid. QA failure: malformed bytes → sanitized, no throw. Evidence: vitest snapshot assertions.
  - Commit: `feat(pty): xterm-headless screen model + snapshot`

- [ ] 15. **[W2.5] `packages/pty/src/registry.ts`: `SessionRegistry` (ids `bash_N`, caps, LRU-exited prune, sweeps, teardown) — expect capped concurrent sessions with clean teardown and orphan sweeps.**
  - References: codex `unified_exec/process_manager.rs` (MAX 64, prune keep-recent), omo stale-session-sweep, senpi `utils/shell.ts` `killTrackedDetachedChildren` + `killProcessTree`.
  - Acceptance: vitest — create beyond cap prunes oldest EXITED; `stopAll`/`stop(id)` tree-kills; startup + session-end sweeps remove orphans; integrates `killTrackedDetachedChildren`.
  - QA happy: create 40 sessions (cap 32) → oldest-exited pruned, live ones kept. QA failure: cap reached with all live → new-session rejected with clear error. Evidence: vitest + orphan-poll.
  - Commit: `feat(pty): session registry with caps, pruning, sweeps`

- [ ] 16. **[W2.6][verify] oracle audit of W2 runtime — expect confirmation session/registry/screen/fallback are correct, leak-free, and 250-LOC-compliant.**
  - References: todos 11-15.
  - Acceptance: oracle APPROVE on lifecycle correctness, no fd/process leaks, fallback parity, LOC ceiling.
  - QA: oracle transcript. Evidence: session id + verdict.
  - Commit: (no code).

### Wave 3 — Tool surface (builtin extension, TDD)

- [ ] 17. **[W3.1] `.../builtin/terminal/extension.ts`: register extension + swap core `bash` for PTY-backed `bash`, MUTUALLY EXCLUSIVE with `anthropic-bash` — expect PTY `bash` + companions when active; when native Anthropic bash is on, the suite steps aside cleanly (no orphaned companion tools).**
  - References: gpt-apply-patch tool-swap via `getActiveTools`/`setActiveTools` — it re-syncs on BOTH `session_start` AND `model_select` (`.../builtin/gpt-apply-patch/extension.ts:68`); MIRROR that (a static startup-only check is NOT enough). `.../builtin/anthropic-bash/index.ts:20-69` — on `before_provider_request`, when `PI_ANTHROPIC_BASH` truthy AND CURRENT model api `anthropic-messages`, `sanitizeTools` STRIPS the function tool named `bash` and injects native `bash_20250124` (stateless) — this is DYNAMIC per model, so companions can orphan on a model switch; `builtin/index.ts` registration order (anthropic-bash #7, bash-timeout #10 — insert terminal with intent); `extensions/types.ts` ExtensionAPI + builtin AGENTS.md (needs a `test/suite/terminal-extension.test.ts`). MECHANISM (verified): `agent-session.ts` `setActiveToolsByName` resolves ONLY by name and extension tools OVERRIDE base tools by name in `_refreshToolRegistry` — so a name-toggle CANNOT recover the ORIGINAL core `bash` once the terminal registers a tool also named `bash`. The extension MUST capture the original core `bash` `ToolDefinition` (via `getAllTools`) at `session_start`, and on step-aside RE-REGISTER/RESTORE that captured definition (or use an explicit unregister/replace path), not rely on name-toggling; if no restore-capable API exists, the plan's first sub-task is to add one to ExtensionAPI (documented in `extensions/changes.md`).
  - Acceptance: harness — with terminal loaded (anthropic-bash NOT active), active `bash` is PTY + `bash_output`/`kill_bash`/`bash_input`/`bash_resize` registered; `--no-extensions` keeps core bash. MUTUAL EXCLUSION, re-evaluated on `session_start` AND `model_select`: when `isAnthropicBashEnabled()` && api===`anthropic-messages`, terminal does NOT swap `bash` and DEACTIVATES/does-not-register companions (one-line notice "native Anthropic bash active — persistent terminal sessions disabled"); when the condition is false, the PTY `bash` + companions are (re)activated by RESTORING the captured original core `bash` definition (re-register), NOT by a name-toggle (which cannot recover the overridden core tool) — so no `bash_*` tool dangles without a PTY `bash` in any state, and the RESTORED `bash` is verified to be the correct backend (core vs PTY), not merely present by name.
  - QA happy: mock-loop calls `bash` → PTY path, companions present. QA failure(a): `PI_ANTHROPIC_BASH=1` + anthropic model → companions ABSENT, native bash present, notice shown. QA failure(b): DYNAMIC — start under a non-anthropic model (companions active) then `/model` switch to an anthropic model with `PI_ANTHROPIC_BASH=1` → companions deactivate (no orphans); switch back → companions restored. QA failure(c): pty load fail → PTY `bash` still runs via pipe fallback. Evidence: mock-loop transcripts (static + model-switch).
  - Commit: `feat(terminal): builtin extension + PTY bash swap (anthropic-bash exclusive)`

- [ ] 18. **[W3.2] `.../builtin/terminal/tools/bash.ts`: extended `bash` schema `{command, timeout?(s), description?, run_in_background?, cols?, rows?}` with MODE-AWARE timeout — expect foreground returns output (timeout = kill deadline); `run_in_background:true` returns a `bash_id` and is NOT killed by `timeout`.**
  - References: free-code `Bash` schema (report), senpi `core/tools/bash.ts` (TypeBox, timeout seconds, renderer), `.../builtin/bash-timeout/index.ts:24-32` — its `tool_call` handler injects `input.timeout = default(120s)` into EVERY `bash` call when absent (so background calls WILL receive it) and clamps to max 600s. CRITICAL: interpret `timeout` per mode; permission-system integration. SHELL RESOLUTION (locked Windows requirement): extend `packages/coding-agent/src/utils/shell.ts` `getShellConfig` (`:20-22` `getBashShellConfig` is bash-only `-c`/`-s`; `:67-119` has NO `SENPI_GIT_BASH_PATH`) → (1) check `SENPI_GIT_BASH_PATH` env FIRST, (2) detect shell KIND from the resolved path so `shellPath`→`cmd.exe` uses `/c`, →`powershell`/`pwsh` uses `-NoProfile -Command`, →bash/sh uses `-c`/`-s`; the terminal extension resolves via this and passes shell+args+transport into pty (todo 6). Core `utils/shell.ts` change → add `utils/changes.md` entry.
  - Acceptance: harness — foreground `echo` returns text and honors `timeout` as a kill deadline (unchanged); `run_in_background:true` returns `Command running in background with ID: bash_1` PROMPTLY (within a short fixed bound after the session spawns, e.g. ≤ a small grace to capture early output — NOT after the injected/explicit `timeout`, so bash-timeout's 120s default never delays the return), and `timeout` is NEVER a process kill deadline in background mode — the session lives until it exits or `kill_bash`. Shell resolution honors `SENPI_GIT_BASH_PATH` and shell-kind (bash/cmd/powershell) with correct per-kind args.
  - Note: distinguish user-specified vs bash-timeout-injected `timeout` where needed (bash-timeout mutates `input.timeout` in place, `bash-timeout/timeout.ts:31`) so background return-latency ignores it.
  - QA happy: `run_in_background:true` `sleep 300` (no explicit timeout → bash-timeout injects 120s) → still alive & queryable via `bash_output` after >120s. QA failure: foreground `sleep 300` with `timeout:2` → killed at ~2s with a clear timeout message. Evidence: pty-drive transcript with timestamps.
  - Commit: `feat(terminal): PTY bash with mode-aware timeout + run_in_background`

- [ ] 19. **[W3.3] `.../builtin/terminal/tools/bash-output.ts`: `bash_output {bash_id, filter?, wait_for?, block?(true), timeout?(s,30), view?("log"|"screen")}` — expect it returns new output since last read, or blocks until `wait_for` regex / exit / timeout.**
  - References: free-code `TaskOutput` (report: block/timeout, XML-ish status), omo `background_output` + `monitor_output` (wait/poll, stream filter), tui-mcp `wait_for_text`; senpi `sendUserMessage`/agent-session, truncate.ts.
  - Acceptance: harness — returns delta output + status + exit_code; `wait_for` blocks then resolves on match; `view:"screen"` returns xterm snapshot; `filter` regex-filters lines.
  - QA happy: `sleep 2 && echo READY` background + `bash_output(wait_for:"READY")` → resolves with READY. QA failure: `wait_for` never matches → times out with partial output + `timeout` status. Evidence: pty-drive transcript.
  - Commit: `feat(terminal): bash_output with wait_for + screen view`

- [ ] 20. **[W3.4] `.../builtin/terminal/tools/kill-bash.ts` + `bash-input.ts` + `bash-resize.ts` + permission-system parser coverage: steering + teardown tools, correctly permission-gated — expect stdin/keys reach a live session, resize reflows, kill tears down the tree, and `bash_input` is gated as command execution.**
  - References: codex `write_stdin` (report), oh-my-pi `bash-interactive` key normalization (kitty→PTY), dori `resize`/`destroy`, free-code `TaskStop`; senpi `.../builtin/permission-system/parsers.ts` (bash parser). SECURITY: `bash_input` writes arbitrary stdin to a live shell = arbitrary command execution, so it MUST be gated in the SAME permission class as `bash` (not a coarse default), else `read-only`/`workspace`/`ask` presets are bypassable via a shell session.
  - Acceptance: harness — `bash_input {bash_id, input, submit:true}` writes+Enter; `bash_input {keys:["ctrl+c"]}` sends SIGINT-seq; `bash_resize {cols,rows}` reflects; `kill_bash {bash_id|all}` tree-kills. PERMISSION: permission-system parser/rule coverage — `bash_input` classified command-execution (bash-equivalent), `kill_bash`/`bash_resize`/`bash_output` as session-control/read; under `read-only`/`ask` presets `bash_input` prompts/denies exactly like `bash`.
  - QA happy: python REPL via `bash` bg → `bash_input "print(6*7)\n"` → `bash_output` shows `42`; under `read-only` preset `bash_input` is denied/prompted. QA failure: input to exited session → clear "session not running" error. Evidence: pty-drive REPL transcript + permission-preset transcript.
  - Commit: `feat(terminal): bash_input/bash_resize/kill_bash + permission gating`

- [ ] 21. **[W3.5] `.../builtin/terminal/prompt.ts` + tool descriptions: CC-close snake_case prompt guidance — expect the model gets accurate persistent-session usage guidance (no "use tmux" advice).**
  - References: senpi `core/tools/bash.ts` promptSnippet, README bash-timeout policy, free-code bash prompt lines (report), dynamic-prompt tool reference section.
  - Acceptance: prompt snippets describe `bash run_in_background` + `bash_output`/`bash_input`/`bash_resize`/`kill_bash` semantics; removes any tmux-background steering guidance for this path.
  - QA happy: `--print` startup shows updated tool reference. QA failure: n/a (prose) — verify no stale "no background bash" text. Evidence: cli-smoke prompt dump.
  - Commit: `docs(terminal): CC-close prompt guidance for persistent sessions`

- [ ] 22. **[W3.6][verify] `deep` agent hands-on QA of the full tool surface — expect background/stdin/resize/screen/kill all proven via real CLI with evidence.**
  - References: todos 17-21; senpi-qa channels.
  - Acceptance: deep agent runs the 4 canonical scenarios (bg+wait, REPL steer, TUI resize+screen, kill orphan-check) on the host OS, saves evidence.
  - QA: full scenario transcripts. Evidence: qa-evidence dir with per-scenario logs.
  - Commit: (no code).

### Wave 4 — Subscription/notify + TUI (TDD)

- [ ] 23. **[W4.1] `.../builtin/terminal/notify.ts`: async wake on completion/pattern via `sendUserMessage({deliverAs:"followUp"})` with idle+context guards — expect an idle interactive agent is woken ONCE with a `<system-reminder>`-style notice; a busy agent gets a queued follow-up; non-interactive/print runs never spin.**
  - References: omo parent-wake/monitor injection (idle guards, dedupe, `<system-reminder>`), senpi `agent-session.ts` `sendUserMessage`/`followUp` (NOTE: injecting a followUp STARTS A NEW agent turn — must be guarded so a completing bg task can't trigger an auth-less turn or a wake loop), `notify.ts` example, interactive-mode `queue_update`.
  - Acceptance: harness — completion while idle injects ONE deduped followUp; while streaming, queues; `terminal.notify=off` suppresses; wake is a NO-OP when there is no active model / not authenticated / in `-p`/`--print` or `--mode json` one-shot runs.
  - QA happy: bg task completes during idle interactive → agent receives one notice next tick. QA failure: bg task completes in a `-p` print run → NO wake/turn; notify while user typing → deferred. Evidence: rpc-drive + print-mode transcripts.
  - Commit: `feat(terminal): async completion/pattern wake with idle+context guards`

- [ ] 24. **[W4.2] `.../builtin/terminal/render.ts`: tool-result renderer (live tail + status + duration; optional screen preview) — expect running/backgrounded/exited states render like the existing bash renderer.**
  - References: senpi `core/tools/bash.ts` renderResult/render component, `render-utils.ts`, `visual-truncate.ts`, tui components.
  - Acceptance: renderer shows streaming tail, "running in background [bash_id]", exit status, duration; expandable; `view:"screen"` shows a bounded grid.
  - QA happy: TUI smoke shows live-updating bash output + background label. QA failure: huge output → truncated with expand hint, no overflow. Evidence: tui-smoke capture.
  - Commit: `feat(terminal): live tool-result rendering + screen preview`

- [ ] 25. **[W4.3] `.../builtin/terminal/settings.ts` + settings-manager keys: config surface — expect `terminal.{defaultCols,defaultRows,scrollback,maxSessions,timeoutAction,notify}` are read with sane defaults.**
  - References: senpi `settings-manager.ts` (settings shape), README settings docs, bash-timeout env pattern.
  - Acceptance: defaults `{cols:120, rows:40, scrollback:10000, maxSessions:32, timeoutAction:"background", notify:"wake"}`; overridable via settings.json + documented.
  - QA happy: set `terminal.notify="off"` → no wake. QA failure: invalid value → falls back to default with warning. Evidence: settings drive log.
  - Commit: `feat(terminal): configurable terminal settings`

- [ ] 26. **[W4.4][verify] oracle audit of subscription/notify correctness — expect confirmation wake timing is safe (no interrupt storms, no lost notifications, idle-guarded).**
  - References: todos 23-25, omo idle-guard semantics.
  - Acceptance: oracle APPROVE on injection guards, dedup, off/next-turn/wake modes.
  - QA: oracle transcript. Evidence: session id + verdict.
  - Commit: (no code).

### Wave 5 — C7: PascalCase → snake_case rename (INDEPENDENT; PR-A, lands first)

- [ ] 27. **[W5.1] discovery: grep the whole senpi tree for senpi-DEFINED tool `name:`/`registerTool` values that are PascalCase — expect the actual (possibly empty) rename list, classified renamable vs provider-fixed.**
  - References: `packages/coding-agent/src/core/extensions/builtin/**` + `core/tools/**`. VERIFIED FACT: the `kimi-web-search` builtin and its `SearchWeb`/`FetchURL` tools NO LONGER EXIST in-tree (Glob empty; grep found only highlight.js language names + `hook_event_name` strings) — do NOT assume them. Exclude provider-fixed names (hook `hook_event_name` like `PreToolUse`, provider-native web-search tool ids, highlight.js language names).
  - Acceptance: a table — every senpi-defined PascalCase tool name → file:line → renamable/KEEP; if EMPTY, record "no PascalCase senpi tool names present; C7 delivers the convention guard only".
  - QA happy: grep audit reproduced + table saved. QA failure: ambiguous name → mark KEEP (safe) + flag. Evidence: audit table.
  - Commit: (no code) — audit in PR description.

- [ ] 28. **[W5.2] rename any discovered renamable PascalCase tool names to snake_case + add a snake_case tool-name convention guard — expect zero senpi-defined PascalCase tool names remain and future ones are blocked.**
  - References: todo 27 table; permission-system rule parser (`.../builtin/permission-system/`), README tool tables, affected tests, per-package CHANGELOG. If todo 27's list is empty, this todo delivers ONLY the guard.
  - Acceptance: every renamable name → snake_case (tool `name`, prompt refs, permission rules, docs, tests, changelog); provider-fixed names untouched; STALE-DOC CLEANUP — remove/correct references to the removed `kimi-web-search` builtin and `SearchWeb`/`FetchURL` tools in top-level `README.md` (its builtin table still lists them though the code is gone; current builtin #15 is `websearch` per `builtin/AGENTS.md`) and any `changes.md`; a lightweight test/lint guard asserts no builtin registers a PascalCase tool name (covers the new terminal tools + all future tools).
  - QA happy: guard red before / green after; mock-loop invokes any renamed tool. QA failure: plant a PascalCase tool name → guard fails. Evidence: guard run + mock-loop.
  - Commit: `refactor: enforce snake_case tool-name convention`

- [ ] 29. **[W5.3][verify] `deep` agent QA of the rename + guard — expect every renamed tool still invocable and the guard actually blocks PascalCase.**
  - References: todos 27-28.
  - Acceptance: deep agent drives each renamed tool (if any) via faux/mock loop, greps for stragglers, and proves the guard fails on a planted PascalCase name.
  - QA: per-tool invocation + guard-failure demo. Evidence: qa-evidence dir.
  - Commit: (no code).

### Wave 6 — Packaging + CI matrix + infra-sync + docs

- [ ] 30. **[W6.1] vendor prebuilds into `packages/pty/native/prebuilds/<platform>/` + `files[]` + freshness guard — expect the published package carries all-OS `.node` and CI verifies they match source.**
  - References: senpi `packages/tui/package.json` `files[]` native inclusion; oh-my-pi source-hash freshness; native-prebuilds workflow (todo 3).
  - Acceptance: prebuilds committed (or fetched in release), `files[]` includes them; a CI guard rebuilds and diffs the host target against the committed prebuild (fail on drift).
  - QA happy: freshness guard green on matching prebuild. QA failure: stale prebuild → guard red with which target drifted. Evidence: guard run log.
  - Commit: `chore(pty): vendor per-OS prebuilds + freshness guard`

- [ ] 31. **[W6.2] bundle `@earendil-works/pi-pty` across package.json + shrinkwrap + ALL hardcoded monorepo machinery — expect the CLI npm package ships pty `dist/` + its `.node`, `--ignore-scripts`-safe.**
  - References: `packages/coding-agent/package.json:43-84` (add pi-pty to `dependencies` + both `bundledDependencies`:80 / `bundleDependencies`:127, mirror pi-tui); `scripts/generate-coding-agent-shrinkwrap.mjs` auto-detects `@earendil-works/pi-*` (no generator edit); `@xterm/headless` (exact-pinned) is pi-pty's dep, transitive. HARDCODED LISTS to update (verified): `scripts/prepare-senpi-bundled-workspaces.mjs:8-14` (`bundledWorkspaces` += `{source:"packages/pty",targetName:"pi-pty"}`) AND `:16-26` `shouldCopyWorkspaceFile` MUST also copy `native/**` (today it only copies package.json/README/CHANGELOG/dist → the `.node` prebuilds would be DROPPED, shipping a pipe-only package) AND `:67-87` `assertSenpiPackedWorkspaceFiles` += assert a pi-pty native `.node`; `scripts/release-packages.mjs`, `scripts/release-changelog.mjs`, `scripts/sync-versions*.mjs`, `scripts/local-release.mjs`, `scripts/publish.mjs`, `scripts/release-artifacts.mjs` (lockstep CalVer + changelog + release), and `scripts/generate-coding-agent-install-lock.mjs` (`:25` `internalPackagePrefixes=["@earendil-works/pi-",…]`, `:53` matches by prefix, `:70` sets `entry.resolved = registryTarballUrl(name,version)` for EVERY internal workspace) — pi-pty is auto-matched by the prefix and RESOLVED AS A REGISTRY TARBALL, so pi-pty MUST be published to npm exactly like siblings pi-tui/pi-ai/pi-agent-core (match pi-tui's exact private-flag + publish + lockstep treatment in `release-packages.mjs`/`publish.mjs`; the vendored `.node` prebuilds ride in the published tarball via `files[]`) — the earlier "mirror pi-tui `private:true`" note means mirror pi-tui's FULL treatment (whatever makes pi-tui installable via this same install-lock), not "unpublished". + every matching `*.test.mjs` (incl. `install-lock-validation.mjs`).
  - Acceptance: pi-pty in deps + both bundle arrays + `bundledWorkspaces`; `shouldCopyWorkspaceFile` copies `native/**`; `npm run shrinkwrap --check` passes; lockstep version + changelog stamping include pi-pty; `node scripts/generate-coding-agent-install-lock.mjs --check` passes AND pi-pty's install-lock entry resolves to a REAL published registry tarball (pi-pty published like pi-tui) — OR, only if maintainers deliberately keep pi-pty registry-absent, it is special-cased as in-bundle/no-registry in the install-lock generator + `install-lock-validation.mjs` with an assertion; decide by matching pi-tui's actual treatment; prebuilds vendored, NO install script → `npm ci --ignore-scripts` needs no allowlist change.
  - QA happy: `npm run release:local` pack → the tarball contains pi-pty `dist/index.js` AND a native `.node`; installed CLI (outside repo) runs a terminal scenario natively on Node. QA failure: prebuild missing for platform → pipe fallback, CLI still runs. Evidence: local-release pack file-list (showing the `.node`) + `shrinkwrap --check` log.
  - Commit: `chore(coding-agent): bundle @earendil-works/pi-pty across build+release machinery`

- [ ] 32. **[W6.3] Bun binary + RELEASE-ARCHIVE asset wiring: copy the correct per-target `.node` next to the executable in BOTH `dist/pi` and every release archive — expect Bun binaries run terminal tools natively, else pipe fallback.**
  - References: CONFIRMED `.node` is NOT embedded in `bun build --compile`; pi-tui loads it as a SIDECAR via `path.dirname(process.execPath)/native/…` (`packages/tui/src/terminal.ts:426-435`). TWO copy sites (both required): (1) local `packages/coding-agent/package.json:38` `copy-binary-assets` → copy host `packages/pty/native/prebuilds/<host>/…​.node` into `dist/native/…`; (2) RELEASE archives `scripts/build-binaries.sh:127,133` (per-platform darwin-arm64/x64, linux-x64/arm64, windows-x64/arm64) + `:154-166` shared-file copy where `:168+` copies a per-target `clipboard-<platform>` native package (EXACT precedent) → add a per-platform copy of the matching pty `.node` into `$OUTPUT_DIR/$platform/native/…`; make `.github/workflows/build-binaries.yml` validate each archive contains the pty `.node`.
  - Acceptance: both `dist/pi` and each release archive carry the correct per-target `.node` at the loader's `process.execPath`/native candidate path; `dist/pi` resolves + loads it; a terminal scenario works under `dist/pi`; a build-binaries archive-content validation step passes.
  - QA happy: `dist/pi` runs a bg+`wait_for` scenario on all 3 OS; built windows-x64 + linux-x64 + darwin archives each contain their `.node`. QA failure: `.node` unresolved under Bun → pipe fallback, clear log. Evidence: bun-binary drive (3 OS) + per-platform archive file-list.
  - Commit: `chore(coding-agent): ship pty native in Bun binary + release archives`

- [ ] 33. **[W6.4] `.github/workflows/ci.yml`: add windows-latest + macos-latest to the test matrix — expect `npm run check` + `npm test` + PTY suite pass on all three OS.**
  - References: senpi `.github/workflows/ci.yml` (ubuntu-only today), oh-my-pi ci matrix; W1/W2/W3 tests.
  - Acceptance: 3-OS matrix; installs prebuild; PTY tests PASS (not skip) on Windows; existing POSIX-only tests guarded appropriately.
  - QA happy: matrix green on push. QA failure: a Windows PTY test flakes → retry/mitigation documented, not skipped. Evidence: CI run URL.
  - Commit: `ci: add windows + macos test matrix`

- [ ] 34. **[W6.5] `.agents/skills/senpi-qa/scripts/pty-drive.mjs` + SKILL.md router + `references/`: new terminal QA channel — expect a `--self-test` channel that drives bash/bash_output/bash_input/bash_resize/kill_bash in an isolated sandbox.**
  - References: senpi-qa SKILL.md router + scripts (rpc-drive/mock-loop/tui-smoke/cli-smoke), AGENTS.md QA section, references/tui-driving.md.
  - Acceptance: `pty-drive.mjs --self-test` passes; runs the 4 canonical scenarios; asserts auth.json sha256 unchanged; router updated.
  - QA happy: `--self-test` green. QA failure: sandbox leak / auth touched → channel fails loudly. Evidence: self-test log.
  - Commit: `test(qa): add pty-drive senpi-qa channel`

- [ ] 35. **[W6.6] docs + env-vars + CHANGELOGs + changes.md: `SENPI_GIT_BASH_PATH`, terminal tools, settings — expect users/agents have complete, accurate reference.**
  - References: senpi `packages/coding-agent/docs/` (windows.md, providers.md pattern), `env-api-keys.ts` doc obligations, per-package CHANGELOG format (AGENTS.md), core `changes.md` for any core bash touch.
  - Acceptance: docs cover terminal tool suite, settings, `SENPI_GIT_BASH_PATH`, Windows notes; CHANGELOGs under `[Unreleased]`; changes.md entries for core edits.
  - QA happy: docs build/lint clean; links resolve. QA failure: n/a (prose review). Evidence: doc diff + link check.
  - Commit: `docs: terminal tool suite, settings, Windows env`

- [ ] 36. **[W6.7][verify] oracle audit of packaging + CI + supply-chain — expect confirmation the distribution is complete (Node+Bun+all-OS), `--ignore-scripts`-safe, and CI actually proves Windows.**
  - References: todos 30-35.
  - Acceptance: oracle APPROVE on bundling, prebuild coverage, shrinkwrap, Bun load, Windows CI reality.
  - QA: oracle transcript. Evidence: session id + verdict.
  - Commit: (no code).

### Wave 7 — Full cross-OS hardcore manual QA

- [ ] 37. **[W7.1] real-scenario manual QA on Linux + macOS + Windows via `pty-drive.mjs` — expect all canonical scenarios PASS on all three OS with saved evidence.**
  - References: todo 34 channel; scenarios: (a) `sleep`+`echo`+`bash_output wait_for`; (b) python/node REPL via `bash_input`; (c) full-screen TUI (e.g. `vim`/`htop` or a scripted alt-screen program) + `bash_resize` + `bash_output view:screen` reflow; (d) `kill_bash all` orphan-poll; (e) ConPTY-specific Windows run; (f) Bun-binary run of (a); (g) Windows shell resolution — `SENPI_GIT_BASH_PATH` override honored, and `shellPath`→`cmd.exe` (`/c`) + `shellPath`→`powershell`/`pwsh` (`-NoProfile -Command`) both spawn and stream correctly.
  - Acceptance: every scenario passes on every OS (Windows via CI job or a Windows host); evidence per OS/scenario; auth.json unchanged.
  - QA happy: all green. QA failure: any red → back into the owning wave's worktree, fix, re-QA. Evidence: qa-evidence/<date>-terminal/ per-OS logs + snapshots.
  - Commit: (no code) — evidence attached to PR-B.

## Final verification wave

- [ ] F1. **plan-compliance audit (oracle):** every todo delivered, every Scope IN item present, every Must-NOT-Have absent (no attach overlay, no SSH, no MCP, no tmux, no provider-name renames, no MVP staging).
- [ ] F2. **code-quality review (oracle):** 250-LOC ceiling on all new files; no `any`; TypeBox schemas; erasable-TS compliance; Rust no-panic/typed errors; fork-strategy changes.md coverage; no hardcoded keybindings.
- [ ] F3. **real manual QA (deep):** independently re-run the W7 canonical scenarios on ≥2 OS incl. Windows, plus Bun binary + Node package; confirm evidence integrity and isolation receipts.
- [ ] F4. **scope-fidelity (oracle):** delivered surface = CC-close snake_case (`bash`+`bash_output`/`kill_bash`/`bash_input`/`bash_resize`); C7 rename complete (grep-clean); Node+Bun+Windows-native all proven; no scope creep.

---

## Commit strategy

- **PR-A (first): C7 snake_case convention.** Branch `refactor/snake-case-tool-names` → todos 27-29 → QA (mock-loop any renamed tool + guard red→green + grep-clean) → `gh pr create` → CI green → `gh pr merge --merge --delete-branch`. May be near-empty on renames (kimi tools already gone) but always lands the convention guard; isolates any rename churn.
- **PR-B: terminal suite.** Branch `feat/persistent-terminal` (or worktree) → todos 1-26, 30-37 → QA evidence (pty-drive all-OS + Bun binary) → `gh pr create` (reviewer-readable English; Summary/Changes/QA-Evidence/Risks/Secret-safety) → CI matrix green + review-work + optional dual review → `gh pr merge --merge --delete-branch`. Split into **PR-B1 (crate+runtime: todos 1-16, 30-32)** and **PR-B2 (tools+notify+TUI+CI+QA: todos 17-26, 33-37)** if the diff is too large to review.
- Commit message format `{feat,fix,docs,chore,ci,refactor}[(scope)]: <msg>`; scopes `pty`/`terminal`/`coding-agent`/`ai`/`tui`. Stage explicit paths only (never `git add -A`); `models.generated.ts` may ride along. Lockfile commits need `PI_ALLOW_LOCKFILE_CHANGE=1`. Per-package CHANGELOG `[Unreleased]` + `changes.md` for core edits. `closes #<n>` when an issue exists.

---

## Success criteria

1. `bash` supports `run_in_background` + `cols`/`rows`; `bash_output` (with `wait_for`/`filter`/`view`), `kill_bash`, `bash_input`, `bash_resize` all work — CC-close snake_case schemas.
2. Persistent sessions: create → steer (stdin/keys) → resize → screen snapshot → subscribe (`wait_for`) → clean teardown (tree-kill, no orphans), capped + swept.
3. Native PTY runs on **Node AND Bun**, **Windows natively via ConPTY**, macOS, Linux; pipe fallback when native unavailable; `--ignore-scripts` install stays functional via vendored prebuilds.
4. Windows first-class: Git-Bash auto-detect + `SENPI_GIT_BASH_PATH` + `shellPath` opt-in; no bundling.
5. Async completion/pattern wake (idle-guarded) + live TUI rendering; configurable (`wake`/`next-turn`/`off`).
6. CI proves it: windows + macos + linux test matrix green with PTY tests PASSING on Windows; native-prebuild workflow + freshness guard; new senpi-qa `pty-drive` channel.
7. C7: zero senpi-defined PascalCase tool names remain (grep-clean); provider-fixed names untouched.
8. All new files ≤250 pure LOC; fork surface documented in changes.md; F1-F4 all APPROVE; hardcore real-scenario QA evidence captured per OS.
