import { judgeCommand } from "../../../kill-guard/command.ts";
import { hostKillGuardContext, readKillGuardSetting } from "../../../kill-guard/host.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";
import { bashInputStream, typeInto } from "./typed-lines.ts";

/** The command text of a `bash` or `monitor` call, or `undefined` for any other tool. */
function commandOf(toolName: string, input: Record<string, unknown>): string | undefined {
	if (toolName !== "bash" && toolName !== "monitor") return undefined;
	return typeof input.command === "string" ? input.command : undefined;
}

/**
 * Refuses an agent shell command that would signal every process, a protected process (pid 1, the agent, its
 * ancestors, the user's service manager) or a process group holding one (senpi#5349,
 * code-yeongyu/oh-my-openagent#12096). One `tool_call` handler covers the PTY and core `bash`, `monitor`,
 * `bash_input` and nested `tool.bash` calls, independent of the permission preset. `terminal.killGuard: "off"` in user
 * settings turns it off.
 */
export default function killGuardExtension(pi: ExtensionAPI): void {
	let enabled = true;
	// Text typed into a background session without a line break, per bash_id: a later Enter submits it (A7).
	const pendingLines = new Map<string, string>();
	const refusal = (command: string): ToolCallEventResult | undefined => {
		// The PTY bash tool, the core bash tool and monitors start the command in a fresh session and process group.
		const verdict = judgeCommand(command, hostKillGuardContext({ kind: "fresh-session" }, "bash"));
		return verdict.action === "refuse" ? { block: true, reason: verdict.message } : undefined;
	};
	const judgeBashInput = (input: Record<string, unknown>): ToolCallEventResult | undefined => {
		const id = typeof input.bash_id === "string" ? input.bash_id : "";
		const typed = typeInto(pendingLines.get(id) ?? "", bashInputStream(input));
		// Every line the call completes runs, each line break a command separator; a refused call writes nothing.
		const refused = typed.lines.length === 0 ? undefined : refusal(typed.lines.join("\n"));
		if (refused !== undefined) return refused;
		if (typed.pending === "") pendingLines.delete(id);
		else pendingLines.set(id, typed.pending);
		return undefined;
	};
	pi.on("session_start", (_event, ctx) => {
		pendingLines.clear();
		enabled = readKillGuardSetting(ctx.cwd, ctx.agentDir) === "on";
		if (!enabled)
			ctx.ui.notify(
				'kill guard off: agent commands may signal any process ("terminal.killGuard": "off")',
				"warning",
			);
	});
	pi.on("tool_call", (event): ToolCallEventResult | undefined => {
		if (!enabled) return undefined;
		if (event.toolName === "bash_input") return judgeBashInput(event.input);
		const command = commandOf(event.toolName, event.input);
		return command === undefined ? undefined : refusal(command);
	});
}
