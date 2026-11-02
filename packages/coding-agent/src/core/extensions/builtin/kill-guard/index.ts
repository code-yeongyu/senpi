import { judgeCommand } from "../../../kill-guard/command.ts";
import { hostKillGuardContext, killGuardProtectedPids, readKillGuardSetting } from "../../../kill-guard/host.ts";
import { activateKillGuardRuntime, releaseKillGuardRuntime } from "../../../kill-guard/runtime.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";

const SUBMIT_KEYS = new Set(["enter", "return"]);
const BACKSPACE = new Set(["\b", "\x7f"]);
const isLineBreak = (char: string) => char === "\r" || char === "\n";
const isControl = (char: string) => {
	const code = char.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

/** The command text of a `bash` or `monitor` call, or `undefined` for any other tool. */
function commandOf(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName !== "bash" && toolName !== "monitor") return undefined;
	return typeof input.command === "string" ? input.command : undefined;
}

/**
 * The lines a `bash_input` call submits when it is plain typing: printable text and backspace, Enter from `submit`, a
 * line break in the text or an `enter` key, and no other named key. `undefined` for any other call (escape sequences,
 * control keys, history or cursor keys): those reach whatever program owns the terminal, which the guard cannot see,
 * so they run unjudged here and the shell that runs them judges the command (PATH shims, the shell's `kill`).
 * Text an earlier call typed without a line break is not tracked.
 */
function plainSubmittedLines(input: Record<string, unknown>): string[] | undefined {
	const keys = Array.isArray(input.keys) ? input.keys : [];
	if (!keys.every((key) => typeof key === "string" && SUBMIT_KEYS.has(key.trim().toLowerCase()))) return undefined;
	const text = typeof input.input === "string" ? input.input : "";
	const submit = typeof input.submit === "boolean" ? input.submit : text.length > 0;
	const lines: string[] = [];
	let line: string[] = [];
	for (const char of `${text}${submit ? "\r" : ""}${"\r".repeat(keys.length)}`) {
		if (isLineBreak(char)) {
			lines.push(line.join(""));
			line = [];
		} else if (BACKSPACE.has(char)) line.pop();
		else if (isControl(char)) return undefined;
		else line.push(char);
	}
	return lines;
}

/**
 * Refuses an agent shell command that would signal every process, a protected process (pid 1, the agent, its
 * ancestors, the user's service manager) or a process group holding one (senpi#5349,
 * code-yeongyu/oh-my-openagent#12096). One `tool_call` handler covers the PTY and core `bash`, `monitor`,
 * `bash_input` and nested `tool.bash` calls, independent of the permission preset. At session start it also activates
 * the runtime layer (PATH shims, bash's BASH_ENV wrapper and its PROMPT_COMMAND hook for interactive bash) that judges
 * the real argv of every agent-spawned `kill`, `pkill` and `killall`. `terminal.killGuard: "off"` in user settings
 * turns both off.
 */
export default function killGuardExtension(pi: ExtensionAPI): void {
	let enabled = true;
	const holder = {};
	const refusal = (command: string): ToolCallEventResult | undefined => {
		// The PTY bash tool, the core bash tool and monitors start the command in a fresh session and process group.
		const verdict = judgeCommand(command, hostKillGuardContext({ kind: "fresh-session" }, "bash"));
		return verdict.action === "refuse" ? { block: true, reason: verdict.message } : undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		enabled = readKillGuardSetting(ctx.cwd, ctx.agentDir) === "on";
		if (!enabled) {
			// Only this session's hold: another session in the process keeps its own until it reads the setting.
			releaseKillGuardRuntime(holder);
			ctx.ui.notify(
				'kill guard off: agent commands may signal any process ("terminal.killGuard": "off")',
				"warning",
			);
			return;
		}
		try {
			activateKillGuardRuntime({ holder, agentDir: ctx.agentDir, protectedPids: killGuardProtectedPids });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`[senpi:kill-guard] the runtime shims could not be installed (${detail}); signals whose targets are only known when a command runs are not judged`,
				"warning",
			);
		}
	});
	pi.on("session_shutdown", () => {
		releaseKillGuardRuntime(holder);
	});
	pi.on("tool_call", (event): ToolCallEventResult | undefined => {
		if (!enabled) return undefined;
		if (event.toolName === "bash_input") {
			// Each submitted line runs, each line break a command separator; a refused call writes nothing.
			const lines = plainSubmittedLines(event.input);
			return lines === undefined || lines.length === 0 ? undefined : refusal(lines.join("\n"));
		}
		const command = commandOf(event.toolName, event.input);
		return command === undefined ? undefined : refusal(command);
	});
}
