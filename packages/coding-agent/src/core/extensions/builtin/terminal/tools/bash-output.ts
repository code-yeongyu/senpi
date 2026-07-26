import { type Static, Type } from "typebox";
import { formatTerminalToolOutput } from "../output-format.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import { safeRegExp, TERMINAL_OUTPUT_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { renderBashOutputCall, renderBashOutputResult } from "./render.ts";
import { describeExit } from "./spawn.ts";

/**
 * Migration guidance returned when a caller passes one of the removed blocking
 * params (`wait_for`, `block`, `timeout`). The params stay in the schema as
 * deprecated ghosts so stale callers get this redirect instead of a generic
 * validation error; the blocking semantics themselves are gone.
 */
export const BASH_OUTPUT_WAIT_REMOVED_GUIDANCE =
	"wait_for removed - launch pattern watches through monitor({command, filter}); for an already-running session, peek with bash_output or kill_bash and relaunch under monitor; completion notifications carry the tail";

const GHOST_PARAM_DESCRIPTION =
	"Removed: bash_output no longer blocks. Passing this returns migration guidance pointing at monitor + completion notifications.";

export const bashOutputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	filter: Type.Optional(Type.String({ description: "Only return output lines matching this regex." })),
	view: Type.Optional(
		Type.Union([Type.Literal("log"), Type.Literal("screen")], {
			description: "'log' returns new raw output (default); 'screen' returns the rendered xterm grid.",
		}),
	),
	wait_for: Type.Optional(Type.String({ description: GHOST_PARAM_DESCRIPTION })),
	block: Type.Optional(Type.Boolean({ description: GHOST_PARAM_DESCRIPTION })),
	timeout: Type.Optional(Type.Number({ description: GHOST_PARAM_DESCRIPTION })),
});

export type BashOutputInput = Static<typeof bashOutputSchema>;

function statusLine(runtime: TerminalRuntimeSession): string {
	if (!runtime.exited) return "status: running";
	const status = describeExit(runtime) ?? "exited";
	const code = runtime.exitResult?.exitCode;
	return code === null || code === undefined ? `status: ${status}` : `status: ${status} exit_code: ${code}`;
}

function applyFilter(text: string, filter: string | undefined): string {
	if (!filter) return text;
	const regex = safeRegExp(filter);
	if (regex === null) return text;
	return text
		.split("\n")
		.filter((line) => regex.test(line))
		.join("\n");
}

function screenView(runtime: TerminalRuntimeSession): string {
	const snapshot = runtime.snapshot();
	return snapshot.visibleGrid.join("\n").replace(/\s+$/, "");
}

export function createBashOutputTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_OUTPUT_TOOL,
		label: "bash_output",
		description:
			"Read output from a background bash session without blocking: new output since the last read, the status line, or a rendered full-screen snapshot via view:'screen'. Pattern watches run through monitor; completion arrives as a notification carrying the exit code and output tail.",
		promptSnippet:
			"Peek at background bash session output (filter, screen view, status); watch patterns with monitor, completion arrives as a notification",
		parameters: bashOutputSchema,
		async execute(_toolCallId: string, input: BashOutputInput): Promise<TerminalToolResult> {
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);

			if (input.wait_for !== undefined || input.block !== undefined || input.timeout !== undefined) {
				return errorResult(BASH_OUTPUT_WAIT_REMOVED_GUIDANCE);
			}

			if (input.view === "screen") {
				return textResult(`${statusLine(runtime)}\n${screenView(runtime)}`);
			}

			const delta = runtime.readDelta();
			const formatted = formatTerminalToolOutput(applyFilter(delta.text, input.filter));
			const dropped = delta.droppedChars > 0 ? `[${delta.droppedChars} earlier chars dropped]\n` : "";
			return textResult(`${statusLine(runtime)}\n${dropped}${formatted.text || "(no new output)"}`);
		},
		renderCall: renderBashOutputCall,
		renderResult: renderBashOutputResult,
	};
}
