import { BASH_DEFAULT_TIMEOUT_SECONDS } from "../bash-timeout/timeout.ts";
import type { SharedSections } from "../../../dynamic-prompt/types.ts";
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
	/** `full` renders the pre-diet section, whose timeout facts live in the bash-timeout policy instead (senpi#5665). */
	readonly sharedSections?: SharedSections;
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
	if (options.sharedSections === "full") return buildFullTerminalPromptSection(options);
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
  - \`${monitor}({ type: "rpc", target, description, events?, exclude?, filter?, persistent? })\`: \`target\` = \`"children"\` / \`"all"\` / one session id, path, \`st_\` id / \`<device>/<session>\` on another device (e.g. \`"laptop/abc123"\`). Status changes + effect receipts -> events; \`events: "all"\` adds content; \`exclude\` drops kinds.
- \`persistent: true\`: no deadline, survives restart (command re-run with \`SENPI_MONITOR_RESTORED=1\`, file rescanned), expires 7 days. Baseline in \`$SENPI_MONITOR_STATE_DIR\` so a move during downtime (<= \`$SENPI_MONITOR_DOWNTIME_MS\` ms) still reported. Loop failures non-fatal: exited watch not restarted.
- Repeated monitor-only wakes pause that noisy monitor only. \`${monitor}({ action: "rearm", bash_id })\` resumes one; \`${monitor}({ action: "rearm" })\` all. Completion and real user input also resume.
- \`bash_input({ bash_id, input, keys, submit })\`: stdin or keys (\`["ctrl+c"]\`, \`["enter"]\`). \`bash_resize({ bash_id, cols, rows })\`: reflow TUI. \`kill_bash({ bash_id })\` / \`{ all: true }\`: tear down session tree.
`;
}

/** The section as worded before the senpi#5335 diet, for presets that render full shared sections (senpi#5665). */
function buildFullTerminalPromptSection(options: TerminalPromptOptions): string {
	const bash = options.evalOnly ? "tool.bash" : "bash";
	const monitor = options.evalOnly ? "tool.monitor" : "monitor";
	const bashGuidance =
		options.ptyBash === false
			? ""
			: `The \`bash\` tool is PTY-backed. For long-running or interactive work, do NOT use tmux or
manual \`&\` backgrounding; use the built-in session tools:

- \`${bash}({ command, run_in_background: true })\` starts a persistent session and returns a
  \`bash_id\` immediately. Foreground calls still block and return output; their \`timeout\`
  (seconds) is a kill deadline. Background sessions ignore \`timeout\` and live until they
  exit or you call \`kill_bash\`. Backgrounding is not a session: a plain \`&\` job dies with the
  call's PTY hangup (native backend), \`nohup\` at best leaves an untracked orphan (no \`bash_id\`,
  no log) that the call's timeout still group-kills; only \`run_in_background\` creates a
  session that outlives the call.
`;
	return `
## Persistent terminal sessions

${bashGuidance}- \`bash_output({ bash_id, filter, view })\` peeks at a session without blocking: new output
  since the last read, the status line, or a rendered full-screen snapshot of TUIs via
  \`view: "screen"\`. Completion arrives as a notification carrying the exit code and output
  tail: peeking is for steering, never for waiting.
- For observable state (CI checks, builds, log patterns, deploys, files or other sessions),
  register \`${monitor}\` and keep working instead of foreground sleeping/polling or repeatedly
  calling \`bash_output\`. Sleep loops belong inside the monitor command.
- \`${monitor}\` subscribes you to a change. Pass exactly one source (\`command\`, \`path\` or
  \`target\`; one branch per call, never two):
  - \`${monitor}({ description, command, filter?, timeout_ms?, persistent? })\` watches a command:
    newline-terminated PTY output lines (stderr included) matching \`filter\` arrive as injected
    events while you keep working; command exit always delivers a summary. \`timeout_ms\` is
    that watch's own deadline: it KILLS the watched command when it fires (the summary says
    \`killed at deadline\`); ${
			options.ptyBash === false
				? "for longer jobs, set `persistent: true` and stop with `kill_bash`."
				: "for longer jobs, start with `run_in_background` and only watch them."
		} One-shot gate: wait
    inside the command and print one sentinel (\`until <cond>; do sleep 1; done;
    printf 'READY\\n'\`) with \`filter: "^READY$"\`. Stream: \`tail -n 0 -F <log> | grep --line-buffered <pat>\`
    with \`persistent: true\`. Filter noise at the
    source and stop with \`kill_bash\`. Persistent command watches are re-run after a restart with
    \`SENPI_MONITOR_RESTORED=1\`; keep any baseline in \`$SENPI_MONITOR_STATE_DIR\` so a move during
    downtime (at most \`$SENPI_MONITOR_DOWNTIME_MS\` ms) is still reported:
    \`b="$SENPI_MONITOR_STATE_DIR/base"; p=$(cat "$b" 2>/dev/null || git rev-parse origin/main | tee "$b"); while sleep 30; do git fetch -q || true; n=$(git rev-parse origin/main); [ "$n" != "$p" ] && { echo "MOVED $p..$n"; p=$n; echo "$p" > "$b"; }; done\`.
    A watch whose command exits is not restarted, so keep failures inside the loop non-fatal.
  - \`${monitor}({ description, path, event?, persistent? })\` natively watches one regular file and
    fires once: prefer it over a shell poll loop. \`"create"\` (the default) fires only when the file
    appears after registration, so watch an already-existing file with \`"modify"\`; registration needs
    the parent directory to exist already, so poll with a \`command\` when the run creates that
    directory too. This branch takes no \`filter\`.
  - \`${monitor}({ type: "rpc", target, description, events?, exclude?, filter?, persistent? })\` watches other
    sessions over every RPC host and terminal: \`target: "children"\` (sessions you spawned, including
    later ones), \`"all"\`, or one session id, path or \`st_\` task id; a session on another device is
    \`<device>/<session>\` (e.g. \`"laptop/abc123"\`). The result lists each matched
    session as it is now; then each status change (\`rpc <label> status running -> idle ...\`) and
    effect receipt arrives as an event. \`events: "all"\` adds their content, streaming collapsed to one
    line per 2 s; \`exclude\` drops kinds. Watching never attaches to a session.
  A standing watch is marked \`persistent: true\`: it has no deadline, survives a session restart
  (the file is rescanned and any change missed while detached reported), expires 7 days after
  creation, has no per-session cap unless the \`terminal.maxDurableMonitors\` setting sets one,
  and is accounted for in one restart-report line on session start.
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
