# TUI vertical jitter QA evidence (#1064)

Scenario: an agentic turn that interleaves assistant narration with three bash tool
cards — the shape that made the transcript shake up and down before the fix.

Surface: real `senpi` interactive TUI built from this worktree
(`packages/coding-agent/dist/cli.js`), driven in a 100x30 tmux PTY against
`claude-opus-5:xhigh`, prompt:

> say "STEP-ONE-NARRATION", bash `echo CARD-A`, say "STEP-TWO-NARRATION",
> bash `echo CARD-B`, say "STEP-THREE-NARRATION", bash `echo CARD-C`,
> say "FINAL-NARRATION"

Artifacts:
- `frame-analysis-after-fix.txt`: all 518 synchronized-output frames replayed
  through `@xterm/headless`. `marker teleports = 0` (the pre-fix mechanism moved a
  painted text block UP across a tool card on every new toolCall) and the final
  transcript order check reports PASS.
- `final-transcript-order-after-fix.txt`: independent whole-stream replay listing
  every marker occurrence with its absolute buffer row. The real transcript is
  rows 2203..2233 with narration and tool cards strictly alternating; rows
  2193..2195 are the echoed user prompt, which contains every marker word.
- `terminal-screen-after-fix.txt`: settled terminal screen capture.
- `regression-test-green.txt`: `vitest run test/suite/regressions/1064-assistant-text-segment-teleport.test.ts`, 4/4 passing.

Not committed (bulk, local only): `raw-pty-stream-after-fix.ansi` — the 642 KB raw
PTY byte stream both replays were produced from.

Pre-fix RED (same test file, before the production change):
- `keeps an interleaved stream chronological ...` failed with
  `expected [ …(3) ] to include AssistantMessageComponent{ … }` — the painted
  segment was detached when the second toolCall arrived.
- `keeps a catch-up message ... chronological` failed with marker positions
  `[2, 163, 83, 177, 217]`, i.e. BRAVO rendered above TOOL-CARD-ONE.

Secret safety: artifacts contain only the synthetic markers above, tool output
(`CARD-A/B/C`), and TUI chrome. No tokens, auth headers, or environment dumps.
