import { BASH_DEFAULT_TIMEOUT_SECONDS } from "../bash-timeout/timeout.ts";
import { DEFAULT_FOREGROUND_WINDOW_SECONDS } from "./tools/foreground-window.ts";

export interface TerminalPromptOptions {
	/** True when the session routes shell tools through eval cells, so call shapes must be `tool.<name>(`. */
	readonly evalOnly: boolean;
	/** Native bash replaces PTY bash, but monitor and its terminal companions remain available. */
	readonly ptyBash?: boolean;
	/** Seconds a foreground `bash` call blocks before it auto-detaches (`PI_BASH_FOREGROUND_SECONDS`). */
	readonly foregroundWindowSeconds?: number;
	/** `timeout` applied when a `bash` call sets none (`PI_BASH_DEFAULT_TIMEOUT_SECONDS`). */
	readonly defaultTimeoutSeconds?: number;
}

/**
 * System-prompt guidance for the persistent-terminal tool suite (CC-close, snake_case).
 *
 * `bash` and `monitor` leave the model's direct tool list whenever the session has an
 * `eval` tool, so their call shapes are rendered per branch: a hardcoded direct shape
 * would teach a call the model cannot make. The steering companions
 * (`bash_output`/`bash_input`/`bash_resize`/`kill_bash`) stay callable by name in both; `bash_input` and
 * `bash_resize` are search-exposed and activate on that first call (senpi#4446). This section is also
 * the one home of the bash timeout facts (kill deadline, default, foreground auto-detach); the separate
 * timeout policy section folded into it (senpi#5335).
 */
export function buildTerminalPromptSection(options: TerminalPromptOptions): string {
	const ptyBash = options.ptyBash !== false;
	const bash = options.evalOnly ? "tool.bash" : "bash";
	const monitor = options.evalOnly ? "tool.monitor" : "monitor";
	const window = options.foregroundWindowSeconds ?? DEFAULT_FOREGROUND_WINDOW_SECONDS;
	const defaultTimeout = options.defaultTimeoutSeconds ?? BASH_DEFAULT_TIMEOUT_SECONDS;
	const evalOnlyReach = !options.evalOnly
		? ""
		: ptyBash
			? '`bash` and `monitor` are reachable only inside eval cells as `tool.bash({ command })` and `tool.monitor(...)`; `tool_schema("bash")` and `tool_schema("monitor")` return their parameters. '
			: '`monitor` is reachable only inside eval cells as `tool.monitor(...)`; `tool_schema("monitor")` returns its parameters. ';
	const bashGuidance = ptyBash
		? `\`bash\` is PTY-backed: never background work with tmux, a plain \`&\` job or \`nohup\` - the call's PTY hangup or timeout kills them; only \`${bash}({ command, run_in_background: true })\` creates a session that outlives the call and returns a \`bash_id\`. A foreground call blocks for about ${window}s, then auto-detaches alive to a background session; its \`timeout\` (seconds, default ${defaultTimeout}) is the process kill deadline, not how long you wait for output, and background sessions ignore it.`
		: "";
	const opening = `${evalOnlyReach}${bashGuidance}`.trimEnd();
	const longerJob = ptyBash
		? "so start a longer job with `run_in_background` and only watch it"
		: "so for a longer job set `persistent: true` and stop it with `kill_bash`";
	return `
## Persistent terminal sessions

${opening ? `${opening}\n\n` : ""}- \`bash_output({ bash_id, filter, view })\` peeks without blocking (new output, the status line, or \`view: "screen"\` for a TUI); completion arrives as a notification with the exit code and output tail, so peeking is for steering, never for waiting.
- To wait on observable state (CI checks, builds, log patterns, deploys, files, other sessions), register \`${monitor}\` and keep working instead of sleeping, polling, or repeatedly calling \`bash_output\`; sleep loops belong inside the monitor command. Pass exactly one source per call:
  - \`${monitor}({ description, command, filter?, timeout_ms?, persistent? })\`: output lines matching \`filter\` arrive as events while you work and exit always delivers a summary. \`timeout_ms\` KILLS the watched command when it fires, ${longerJob}. One-shot gate: \`until <cond>; do sleep 1; done; printf 'READY\\n'\` with \`filter: "^READY$"\`. Stream: \`tail -n 0 -F <log> | grep --line-buffered <pat>\` with \`persistent: true\`. Filter noise at the source; stop with \`kill_bash\`.
  - \`${monitor}({ description, path, event?, persistent? })\`: one regular file whose parent directory already exists, fires once, takes no \`filter\`; \`"create"\` (the default) fires only for a file that appears after registration, so use \`event: "modify"\` for an existing file and a \`command\` poll when the run creates the directory too.
  - \`${monitor}({ type: "rpc", target, description, events?, exclude?, filter?, persistent? })\`: \`target\` is \`"children"\`, \`"all"\`, or one session id, path or \`st_\` task id; status changes and effect receipts arrive as events, \`events: "all"\` adds content, \`exclude\` drops kinds.
- \`persistent: true\` is a standing watch: no deadline, survives a session restart (a command watch is re-run with \`SENPI_MONITOR_RESTORED=1\`, a file rescanned), expires 7 days after creation. Keep any baseline in \`$SENPI_MONITOR_STATE_DIR\` so a move during downtime (at most \`$SENPI_MONITOR_DOWNTIME_MS\` ms) is still reported, and keep failures inside the loop non-fatal: a watch whose command exits is not restarted.
- Repeated monitor-only wakes pause the noisy monitor, not all of them; \`${monitor}({ action: "rearm", bash_id })\` resumes one, \`${monitor}({ action: "rearm" })\` all; completion and real user input also resume them.
- \`bash_input({ bash_id, input, keys, submit })\` sends stdin or named keys (\`["ctrl+c"]\`, \`["enter"]\`) to a REPL or process; \`bash_resize({ bash_id, cols, rows })\` reflows a full-screen program; \`kill_bash({ bash_id })\` or \`{ all: true }\` tears the session tree down.
`;
}
