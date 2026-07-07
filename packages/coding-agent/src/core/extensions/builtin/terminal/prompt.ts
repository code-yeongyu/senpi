/** System-prompt guidance for the persistent-terminal tool suite (CC-close, snake_case). */
export const TERMINAL_PROMPT_SECTION = `
## Persistent terminal sessions

The \`bash\` tool is PTY-backed. For long-running or interactive work, do NOT use tmux or
manual \`&\` backgrounding — use the built-in session tools:

- \`bash({ command, run_in_background: true })\` starts a persistent session and returns a
  \`bash_id\` immediately. Foreground calls still block and return output; their \`timeout\`
  (seconds) is a kill deadline. Background sessions ignore \`timeout\` and live until they
  exit or you call \`kill_bash\`.
- \`bash_output({ bash_id, wait_for, filter, view })\` reads new output, or blocks until a
  \`wait_for\` regex matches / the session exits / the timeout elapses. Use \`view: "screen"\`
  for a rendered full-screen snapshot of TUIs.
- \`bash_input({ bash_id, input, keys, submit })\` sends stdin or named keys (e.g.
  \`["ctrl+c"]\`, \`["enter"]\`) to steer a REPL or interrupt a process.
- \`bash_resize({ bash_id, cols, rows })\` resizes the PTY so full-screen programs reflow.
- \`kill_bash({ bash_id })\` (or \`{ all: true }\`) tears the session tree down with no orphans.

Typical flow: start with \`run_in_background: true\`, subscribe via \`bash_output\` with
\`wait_for\`, steer with \`bash_input\`, then \`kill_bash\` when done.
`;
