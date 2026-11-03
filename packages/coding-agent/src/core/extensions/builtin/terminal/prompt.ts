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
			? '`bash`, `monitor`: eval-only, call as `tool.bash({ command })` / `tool.monitor(...)`; params via `tool_schema("bash")` / `tool_schema("monitor")`. '
			: '`monitor`: eval-only, call as `tool.monitor(...)`; params via `tool_schema("monitor")`. ';
	const bashGuidance = ptyBash
		? `\`bash\` = PTY. Never tmux, plain \`&\`, or \`nohup\` (PTY hangup or call timeout kills them). Only \`${bash}({ command, run_in_background: true })\` -> session outliving the call, returns \`bash_id\`. Foreground call blocks ~${window}s then auto-detaches alive to background. \`timeout\` (seconds, default ${defaultTimeout}) = process kill deadline, not output wait; background sessions ignore it.`
		: "";
	const opening = `${evalOnlyReach}${bashGuidance}`.trimEnd();
	const longerJob = ptyBash
		? "longer job: `run_in_background` + watch only"
		: "longer job: `persistent: true` + stop via `kill_bash`";
	return `
## Persistent terminal sessions

${opening ? `${opening}\n\n` : ""}- \`bash_output({ bash_id, filter, view })\`: non-blocking peek (new output / status line / \`view: "screen"\` for TUI). Completion = notification with exit code + tail. Peek to steer, never to wait.
- Waiting on observable state (CI, build, log pattern, deploy, file, other session): register \`${monitor}\`, keep working. No sleep/poll in cells, no repeated \`bash_output\`; sleep loops live inside monitor command. Exactly one source per call:
  - \`${monitor}({ description, command, filter?, timeout_ms?, persistent? })\`: lines matching \`filter\` -> events; exit -> summary. \`timeout_ms\` KILLS watched command; ${longerJob}. One-shot gate: \`until <cond>; do sleep 1; done; printf 'READY\\n'\` + \`filter: "^READY$"\`. Stream: \`tail -n 0 -F <log> | grep --line-buffered <pat>\` + \`persistent: true\`. Filter noise at source; stop via \`kill_bash\`.
  - \`${monitor}({ description, path, event?, persistent? })\`: one regular file, parent dir must exist, fires once, no \`filter\`. \`"create"\` (default) fires only for a file that appears after registration; existing file -> \`event: "modify"\`; run creates the dir too -> \`command\` poll.
  - \`${monitor}({ type: "rpc", target, description, events?, exclude?, filter?, persistent? })\`: \`target\` = \`"children"\` / \`"all"\` / one session id, path, \`st_\` id. Status changes + effect receipts -> events; \`events: "all"\` adds content; \`exclude\` drops kinds.
- \`persistent: true\`: no deadline, survives restart (command re-run with \`SENPI_MONITOR_RESTORED=1\`, file rescanned), expires 7 days. Baseline in \`$SENPI_MONITOR_STATE_DIR\` so a move during downtime (<= \`$SENPI_MONITOR_DOWNTIME_MS\` ms) still reported. Loop failures non-fatal: exited watch not restarted.
- Repeated monitor-only wakes pause that noisy monitor only. \`${monitor}({ action: "rearm", bash_id })\` resumes one; \`${monitor}({ action: "rearm" })\` all. Completion and real user input also resume.
- \`bash_input({ bash_id, input, keys, submit })\`: stdin or keys (\`["ctrl+c"]\`, \`["enter"]\`). \`bash_resize({ bash_id, cols, rows })\`: reflow TUI. \`kill_bash({ bash_id })\` / \`{ all: true }\`: tear down session tree.
`;
}
