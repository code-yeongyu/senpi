---
name: interactive-testing
description: Test and debug senpi's interactive mode in a controlled tmux terminal. Use for TUI behavior checks and interactive release smoke tests.
---

# Testing senpi Interactive Mode with tmux

Run the TUI in a controlled terminal (from the repo root, two directories above this skill):

```bash
tmux new-session -d -s senpi-test -x 80 -y 24
tmux send-keys -t senpi-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t senpi-test -p     # capture after startup
tmux send-keys -t senpi-test "your prompt here" Enter
tmux send-keys -t senpi-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t senpi-test
```

For release smoke tests, start the tmux session with `-c /tmp` and replace `./pi-test.sh` with the absolute path to the release `senpi` binary. Test both Node and Bun binaries separately, submit a prompt, and wait for the model reply; startup alone is not a passing smoke test.
