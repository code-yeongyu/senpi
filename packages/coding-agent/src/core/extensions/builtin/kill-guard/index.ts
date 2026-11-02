import { judgeCommand } from "../../../kill-guard/command.ts";
import { hostKillGuardContext, readKillGuardSetting } from "../../../kill-guard/host.ts";
import { refuse } from "../../../kill-guard/verdict.ts";
import type { ExtensionAPI, ToolCallEventResult } from "../../types.ts";
import { isWakeSourceStateEvent, WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import type { UnjudgedHistory } from "./shell-history.ts";
import { bashInputBytes, type SubmittedLine, typeInto } from "./typed-lines.ts";
import { forgetAgentSession, keepTypedSession, noteRunningShells, typedSession } from "./typed-sessions.ts";

const UNFOLLOWABLE =
	"a bash_input line was sent with a control byte, an escape sequence, tab or a named key, and the bytes sent for it could spell a kill-family command once the shell's line editor rearranges them (the guard refuses these instead of modelling every readline key)";

// bash runs a history entry for these lines, not the typed text, and the guard cannot see the shell's history (it may
// hold lines loaded from the user's history file before the session), so they are refused unjudged (fail closed).
const UNJUDGED_HISTORY: Record<UnjudgedHistory, string> = {
	recall:
		"history recall is not judged: bash runs the history entry a recall key put on the line, which the guard cannot see",
	expansion:
		"history expansion is not judged: bash runs the line a `!` event, a leading `^` or `fc` expands to, not the typed one",
};
const TYPE_IN_FULL = "Type the full command as plain text and submit it.";

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
	let sessionKey = "";
	let stopWatchingShells = () => {};
	const refusal = (command: string): ToolCallEventResult | undefined => {
		// The PTY bash tool, the core bash tool and monitors start the command in a fresh session and process group.
		const verdict = judgeCommand(command, hostKillGuardContext({ kind: "fresh-session" }, "bash"));
		return verdict.action === "refuse" ? { block: true, reason: verdict.message } : undefined;
	};
	// Every line the call completes runs, each line break a command separator. An edited line is judged as every line
	// it could be, and a line that was not typed plainly is refused outright when its bytes could spell a kill-family
	// command (fail-closed; see typed-lines.ts). This judges only the agent's bash_input calls: a person typing in their
	// own terminal never reaches this hook.
	const judgeLines = (lines: readonly SubmittedLine[]): ToolCallEventResult | undefined => {
		const unjudged = lines.find((line) => line.history !== undefined)?.history;
		if (unjudged !== undefined)
			return { block: true, reason: refuse("R5", UNJUDGED_HISTORY[unjudged], TYPE_IN_FULL).message };
		const texts = lines.map((line) => line.text);
		const variants = [
			texts,
			...lines.flatMap((line, index) =>
				line.alternatives.map((alternative) => texts.map((text, at) => (at === index ? alternative : text))),
			),
		];
		for (const variant of variants) {
			const refused = refusal(variant.join("\n"));
			if (refused !== undefined) return refused;
		}
		if (!lines.some((line) => line.unfollowable)) return undefined;
		return {
			block: true,
			reason: refuse(
				"R5",
				UNFOLLOWABLE,
				"Type the whole command as plain text (printable characters and backspace only) and submit it.",
			).message,
		};
	};
	const judgeBashInput = (input: Record<string, unknown>): ToolCallEventResult | undefined => {
		const id = typeof input.bash_id === "string" ? input.bash_id : "";
		const typed = typeInto(typedSession(sessionKey, id), bashInputBytes(input));
		// A refused call writes nothing, so the shell's line stays as it was.
		const refused = typed.lines.length === 0 ? undefined : judgeLines(typed.lines);
		if (refused === undefined) keepTypedSession(sessionKey, id, typed.session);
		return refused;
	};
	pi.on("session_start", (event, ctx) => {
		sessionKey = ctx.sessionManager?.getSessionId?.() ?? "";
		// A reload keeps the terminal's PTY sessions and the text typed into them; any other start brings fresh ones.
		if (event.reason !== "reload") forgetAgentSession(sessionKey);
		stopWatchingShells();
		stopWatchingShells = pi.events.on(WAKE_SOURCE_STATE_EVENT, (data) => {
			if (
				!isWakeSourceStateEvent(data) ||
				data.source !== "terminal-background-sessions" ||
				data.items === undefined
			)
				return;
			noteRunningShells(
				sessionKey,
				data.items.map((item) => item.id),
			);
		});
		enabled = readKillGuardSetting(ctx.cwd, ctx.agentDir) === "on";
		if (!enabled)
			ctx.ui.notify(
				'kill guard off: agent commands may signal any process ("terminal.killGuard": "off")',
				"warning",
			);
	});
	pi.on("session_shutdown", (event) => {
		stopWatchingShells();
		stopWatchingShells = () => {};
		if (event.reason !== "reload") forgetAgentSession(sessionKey);
	});
	pi.on("tool_call", (event): ToolCallEventResult | undefined => {
		if (!enabled) return undefined;
		if (event.toolName === "bash_input") return judgeBashInput(event.input);
		const command = commandOf(event.toolName, event.input);
		return command === undefined ? undefined : refusal(command);
	});
}
