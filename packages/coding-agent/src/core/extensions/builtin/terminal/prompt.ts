/** System-prompt guidance for the persistent-terminal tool suite (CC-close, snake_case). */
export const TERMINAL_PROMPT_SECTION = `
## Persistent terminal sessions

The \`bash\` tool is PTY-backed. For long-running or interactive work, do NOT use tmux or
manual \`&\` backgrounding — use the built-in session tools:

- \`bash({ command, run_in_background: true })\` starts a persistent session and returns a
  \`bash_id\` immediately. Foreground calls still block and return output; their \`timeout\`
  (seconds) is a kill deadline. Background sessions ignore \`timeout\` and live until they
  exit or you call \`kill_bash\`.
- \`bash_output({ bash_id, filter, view })\` peeks at a session without blocking: new output
  since the last read, the status line, or a rendered full-screen snapshot of TUIs via
  \`view: "screen"\`. Completion arrives as a notification carrying the exit code and output
  tail — peeking is for steering, never for waiting.
- \`monitor({ description, command, filter?, timeout_ms?, persistent? })\` subscribes you to a
  command: newline-terminated PTY output lines (stderr included) matching \`filter\` arrive as
  injected events while you keep working; command exit always delivers a summary. One-shot
  gate: wait inside the command and print one sentinel (\`until <cond>; do sleep 1; done;
  printf 'READY\\n'\`). Stream: \`tail -n 0 -F | grep --line-buffered\`. Filter noise at the
  source and stop with \`kill_bash\`. Identical updates are deduped; enough monitor-only wakes
  pause ALL monitors - completion still wakes the session, and
  \`monitor({ action: "rearm", bash_id })\` resumes intermediate events.
- \`bash_input({ bash_id, input, keys, submit })\` sends stdin or named keys (e.g.
  \`["ctrl+c"]\`, \`["enter"]\`) to steer a REPL or interrupt a process.
- \`bash_resize({ bash_id, cols, rows })\` resizes the PTY so full-screen programs reflow.
- \`kill_bash({ bash_id })\` (or \`{ all: true }\`) tears the session tree down with no orphans.

Typical flow: start with \`run_in_background: true\`, watch for patterns with
\`monitor({ command, filter })\`, peek with \`bash_output\`, steer with \`bash_input\`, then
\`kill_bash\` when done. Completion notifications carry the exit code and output tail, so a
follow-up read is only needed when the tail is not enough.
`;
