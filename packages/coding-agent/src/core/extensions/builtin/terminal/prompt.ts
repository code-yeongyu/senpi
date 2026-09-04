export interface TerminalPromptOptions {
	/** True when the session routes shell tools through eval cells, so call shapes must be `tool.<name>(`. */
	readonly evalOnly: boolean;
}

/**
 * System-prompt guidance for the persistent-terminal tool suite (CC-close, snake_case).
 *
 * `bash` and `monitor` leave the model's direct tool list whenever the session has an
 * `eval` tool, so their call shapes are rendered per branch: a hardcoded direct shape
 * would teach a call the model cannot make. The steering companions
 * (`bash_output`/`bash_input`/`bash_resize`/`kill_bash`) stay directly callable in both.
 */
export function buildTerminalPromptSection(options: TerminalPromptOptions): string {
	const bash = options.evalOnly ? "tool.bash" : "bash";
	const monitor = options.evalOnly ? "tool.monitor" : "monitor";
	return `
## Persistent terminal sessions

The \`bash\` tool is PTY-backed. For long-running or interactive work, do NOT use tmux or
manual \`&\` backgrounding — use the built-in session tools:

- \`${bash}({ command, run_in_background: true })\` starts a persistent session and returns a
  \`bash_id\` immediately. Foreground calls still block and return output; their \`timeout\`
  (seconds) is a kill deadline. Background sessions ignore \`timeout\` and live until they
  exit or you call \`kill_bash\`.
- \`bash_output({ bash_id, filter, view })\` peeks at a session without blocking: new output
  since the last read, the status line, or a rendered full-screen snapshot of TUIs via
  \`view: "screen"\`. Completion arrives as a notification carrying the exit code and output
  tail — peeking is for steering, never for waiting.
- \`${monitor}\` subscribes you to a change. Pass \`command\` XOR \`path\` — one branch per call,
  never both:
  - \`${monitor}({ description, command, filter?, timeout_ms?, persistent? })\` watches a command:
    newline-terminated PTY output lines (stderr included) matching \`filter\` arrive as injected
    events while you keep working; command exit always delivers a summary. One-shot gate: wait
    inside the command and print one sentinel (\`until <cond>; do sleep 1; done;
    printf 'READY\\n'\`). Stream: \`tail -n 0 -F | grep --line-buffered\`. Filter noise at the
    source and stop with \`kill_bash\`.
  - \`${monitor}({ description, path, event?, persistent? })\` natively watches one regular file and
    fires once — prefer it over a shell poll loop. \`"create"\` (the default) fires only when the file
    appears after registration, so watch an already-existing file with \`"modify"\`; registration needs
    the parent directory to exist already, so poll with a \`command\` when the run creates that
    directory too. This branch takes no \`filter\`.
  A standing watch is marked \`persistent: true\`: it has no deadline, survives a session restart
  (the command is re-run once, the file rescanned and any change missed while detached reported),
  expires 7 days after creation, is capped at 5 per session, and is accounted for in one
  restart-report line on session start.
  Identical updates are deduped; repeated monitor-only wakes pause the noisy monitor(s) that
  caused them, not all monitors. Completion still wakes the session, and
  \`${monitor}({ action: "rearm", bash_id })\` resumes one while \`${monitor}({ action: "rearm" })\`
  resumes all paused monitors; real user input also resumes paused monitors.
- \`bash_input({ bash_id, input, keys, submit })\` sends stdin or named keys (e.g.
  \`["ctrl+c"]\`, \`["enter"]\`) to steer a REPL or interrupt a process.
- \`bash_resize({ bash_id, cols, rows })\` resizes the PTY so full-screen programs reflow.
- \`kill_bash({ bash_id })\` (or \`{ all: true }\`) tears the session tree down with no orphans.
`;
}
