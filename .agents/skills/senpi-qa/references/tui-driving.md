# TUI driving (Channel 2)

`tui-smoke.mjs` boots the interactive TUI in a real pseudo-terminal and asserts
boot / render / input / teardown. Two drivers, auto-selected:

## node-pty (default; native Windows)

node-pty allocates a real PTY via ConPTY on Windows and forkpty on macOS/Linux —
one code path everywhere, no WSL. It is a skill-local dependency (declared in
`.agents/skills/senpi-qa/package.json`, installed into the skill's own
`node_modules`) so it never touches senpi's root lockfile or coding-agent
shrinkwrap. node-pty 1.1.0 ships prebuilds for darwin-arm64/x64 and
win32-arm64/x64 (with ConPTY); Linux builds from source (the devcontainer image
includes build tools).

## tmux (POSIX fallback)

When node-pty's PTY is unusable (e.g. a sandbox that blocks `posix_spawn`) but
`tmux` is on PATH, the smoke uses tmux instead. The manual recipe:

```bash
S=senpi-qa-tui
tmux new-session -d -s "$S" -x 120 -y 34 \
  "cd <sandbox>; export SENPI_CODING_AGENT_DIR=<sandbox>/agent PI_OFFLINE=1; \
   exec node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json \
   packages/coding-agent/src/cli.ts --no-context-files --no-skills --no-extensions --approve"
sleep 8
tmux capture-pane -t "$S" -p          # the screen = the artifact
tmux send-keys -t "$S" -l "hello"      # type into the composer
tmux send-keys -t "$S" C-c             # interrupt; C-c again to exit
tmux kill-session -t "$S"
```

Do NOT pipe the TUI through `tee`/a pipe — it detects non-TTY stdout and exits.
Run it directly in the pane (tmux) or the PTY (node-pty).

## Honest limits

A TUI is a full-screen, repainting app. tmux/pty smoke reliably proves it boots,
renders, accepts a keystroke, and survives — it is fragile for asserting exact
conversation output. For behavioral assertions use Channel 1 (RPC) or Channel 3
(mock loop).

## Keybindings

Defaults live in `packages/tui/src/keybindings.ts` (editor/composer) and
`packages/coding-agent/src/core/keybindings.ts` (app: interrupt, exit, model
cycle, session, …). User overrides: `~/.senpi/agent/keybindings.json`. When you
change a binding, smoke the relevant key here, and never hardcode key checks in
source — add a default to the keybindings tables instead.

## Isolation

The smoke sets `SENPI_CODING_AGENT_DIR`/`SENPI_CODING_AGENT_SESSION_DIR` to a
temp sandbox and runs from a temp cwd. Pass `--no-skills --no-extensions` so the
boot screen does not enumerate the user's global skills (faster, cleaner). The
real `~/.senpi/agent/auth.json` sha256 is asserted unchanged after every run.
