---
name: tmux-manual-qa
description: Run a single manual tmux-based QA scenario for the todo continuation feature against the real CLI (./pi-test.sh) in an interactive TUI. Captures scrollback, asserts deterministic pass/fail count markers, and cleans up test fixtures. Use only for the manual-qa milestone features.
---

# Tmux Manual QA Worker

You are executing ONE manual QA feature from `features.json` that drives the real `./pi-test.sh` CLI inside a tmux session, captures scrollback, and asserts deterministic pass/fail markers.

## Context you MUST read before starting

1. **Feature spec:** `features.json` — your assigned feature.
2. **Mission document:** `mission.md`.
3. **Validation contract:** the `fulfills` IDs for your feature in `validation-contract.md`.
4. **Architecture:** `.factory/library/architecture.md`.
5. **User testing surface:** `.factory/library/user-testing.md` — especially the Manual tmux TUI section.
6. **Mission AGENTS.md:** boundaries and git safety rules.

## Hard rules

- **Real LLM calls are allowed** in this skill (manual QA only). The user's `~/.pi/agent/auth.json` is presumed configured. Do NOT touch that file.
- **Capture to `local-ignore/`** — never commit QA evidence. The `local-ignore/` directory is gitignored.
- **Clean up test fixtures.** If you create a temporary `.pi/settings.json` for a scenario, delete it after capture so subsequent tests start from a clean slate.
- **Deterministic evidence:** every manual feature includes a `rg -c "SYSTEM DIRECTIVE: SANEPI"` count check. Always save the count to a `.count` file alongside the `.log` file. The count is the canonical pass/fail marker, not the visual scrollback.
- **No src/ changes:** you are verifying only. If you find a bug, return to orchestrator with details and do NOT fix it yourself — a coding-agent-extension-worker will handle the fix in a follow-up feature.

## Prerequisites

Before running any scenario, confirm:
1. `./pi-test.sh` is executable and runs (check `ls -la pi-test.sh`).
2. `npm run build` has been run at least once after the continuation feature was merged (check `packages/coding-agent/dist/cli.js` exists and contains the continuation code).
3. `tmux` is installed (`command -v tmux`).
4. `rg` is installed (`command -v rg`).
5. `local-ignore/` directory exists at repo root (create if needed).

If any prerequisite is missing, return to orchestrator.

## Procedure

### Step 1 — Orient
Read your feature's description carefully. Identify:
- Which scenario you are running (default-enabled / settings-disable / flag-override / re-entry-guard).
- What the expected scrollback should contain.
- The expected `rg -c` count (0 or ≥1).
- The log filename convention (`local-ignore/qa-cross-XXX-*.log`).

### Step 2 — Set up the fixture (if needed)
If your scenario requires a test `.pi/settings.json`:
```bash
mkdir -p .pi
echo '{ "todotools": { "continuation": { "enabled": false } } }' > .pi/settings.json.qa-backup-test
# (Back up any existing .pi/settings.json first so we can restore.)
```
Always back up the existing file before writing the test fixture, and restore it after capture.

### Step 3 — Launch tmux session and drive the CLI
Start a new tmux session for the scenario:
```bash
TMUX_SESSION="pi-qa-${FEATURE_ID}"
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
tmux new-session -d -s "$TMUX_SESSION" "./pi-test.sh${EXTRA_FLAGS}"
```
Wait for the CLI to initialize (use `sleep 3` or poll for the prompt).

Send the scripted prompts that drive the agent to create todos and end its turn. Example:
```bash
tmux send-keys -t "$TMUX_SESSION" 'create a 2-item todo list about testing this feature, mark one as in_progress, then pause' Enter
sleep 10   # wait for the agent to respond
```

Use `sleep` generously between interactions — real model calls take time. A 10-20 second pause between prompts is reasonable.

### Step 4 — Capture scrollback
```bash
tmux capture-pane -p -t "$TMUX_SESSION" -S -10000 > local-ignore/qa-cross-XXX-tmux.log
```

### Step 5 — Assert the count marker
```bash
rg -c 'SYSTEM DIRECTIVE: SANEPI' local-ignore/qa-cross-XXX-tmux.log > local-ignore/qa-cross-XXX-tmux.count || true
COUNT=$(cat local-ignore/qa-cross-XXX-tmux.count)
echo "Continuation directive count: $COUNT"
```

Compare against the expected count in your feature's `expectedBehavior`:
- `manual-tmux-qa-default-enabled`: expect ≥1
- `manual-tmux-qa-settings-disable`: expect 0
- `manual-tmux-qa-flag-override`: flag-on expect 0, flag-off expect ≥1
- `manual-tmux-qa-reentry-guard`: expect per-turn count ≤1 (check manually because it needs per-turn framing)

### Step 6 — Tear down
```bash
tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
```
Restore any backup settings files. Remove any temporary fixtures you created.

### Step 7 — Verify evidence files
```bash
ls -l local-ignore/qa-cross-XXX-*.log local-ignore/qa-cross-XXX-*.count
```
Confirm both files exist.

### Step 8 — Handoff
Report:
- `successState`: `"success"` if the count matches expected; `"failure"` if not.
- `evidenceFiles`: paths to the captured log and count files.
- `observedCount`: the actual number.
- `expectedCount`: the expected range.
- `scrollbackSummary`: 3-5 lines describing what you saw (agent behavior, any error messages, any unexpected output).
- `discoveredIssues`: anything buggy or surprising observed during the run (surface it — do not silently ignore).

## Escalation triggers

Return to orchestrator immediately if:
- `./pi-test.sh` fails to start.
- `tmux` is not available.
- The agent hangs for > 60 seconds without a response (may indicate a provider outage or a bug).
- The count does not match expected and you cannot reproduce the failure deterministically (this is a bug that needs a coding-agent-extension-worker fix).
- You observe any runtime error, stack trace, or TypeError in the scrollback.
- Test fixtures (settings.json) cannot be backed up or restored.

## Anti-patterns

- Modifying source code "to make the test pass."
- Committing log/count files from `local-ignore/`.
- Leaving test settings.json fixtures behind after capture.
- Visual "it looks fine" confirmation without the `rg -c` count file.
- Using the user's live settings without a backup/restore cycle.
