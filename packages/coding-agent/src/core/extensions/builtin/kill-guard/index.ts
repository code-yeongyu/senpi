import { judgeCommand } from "../../../kill-guard/command.ts";
import { hostKillGuardContext, killGuardProtectedPids, readKillGuardSetting } from "../../../kill-guard/host.ts";
import {
	activateKillGuardRuntime,
	deactivateKillGuardRuntime,
	releaseKillGuardRuntime,
} from "../../../kill-guard/runtime.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";

const SUBMIT_KEYS = new Set(["enter", "return"]);

/** The shell text a tool call would run now, or `undefined` when it runs none (A7: unsubmitted bash_input text). */
export function submittedCommand(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName === "bash" || toolName === "monitor")
		return typeof input.command === "string" ? input.command : undefined;
	if (toolName !== "bash_input" || typeof input.input !== "string") return undefined;
	const submit = typeof input.submit === "boolean" ? input.submit : input.input.length > 0;
	const keys = Array.isArray(input.keys) ? input.keys : [];
	const enter = keys.some((key) => typeof key === "string" && SUBMIT_KEYS.has(key.toLowerCase()));
	return submit || enter ? input.input : undefined;
}

/**
 * Refuses an agent shell command that would signal every process, a protected process (pid 1, the agent, its
 * ancestors, the user's service manager) or a process group holding one (senpi#5349,
 * code-yeongyu/oh-my-openagent#12096). One `tool_call` handler covers the PTY and core `bash`, `monitor`,
 * `bash_input` and nested `tool.bash` calls, independent of the permission preset. At session start it also activates
 * the runtime layer (PATH shims and bash's BASH_ENV wrapper) that judges the real argv of every agent-spawned `kill`,
 * `pkill` and `killall`. `terminal.killGuard: "off"` in user settings turns both off.
 */
export default function killGuardExtension(pi: ExtensionAPI): void {
	let enabled = true;
	const holder = {};
	pi.on("session_start", (_event, ctx) => {
		enabled = readKillGuardSetting(ctx.cwd, ctx.agentDir) === "on";
		if (!enabled) {
			deactivateKillGuardRuntime();
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
	pi.on("session_shutdown", () => releaseKillGuardRuntime(holder));
	pi.on("tool_call", (event): ToolCallEventResult | undefined => {
		if (!enabled) return undefined;
		const command = submittedCommand(event.toolName, event.input);
		if (command === undefined) return undefined;
		// The PTY bash tool, the core bash tool and monitors start the command in a fresh session and process group.
		const verdict = judgeCommand(command, hostKillGuardContext({ kind: "fresh-session" }, "bash"));
		return verdict.action === "refuse" ? { block: true, reason: verdict.message } : undefined;
	});
}
