import { type Static, Type } from "typebox";
import { formatTerminalToolOutput } from "../output-format.ts";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import { safeRegExp, TERMINAL_OUTPUT_TOOL } from "../shared.ts";
import {
	errorResult,
	resolveTerminalId,
	type TerminalToolContext,
	type TerminalToolResult,
	textResult,
} from "./context.ts";
import { renderBashOutputCall, renderBashOutputResult } from "./render.ts";
import { describeExit } from "./spawn.ts";

export const bashOutputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	filter: Type.Optional(Type.String({ description: "Only return output lines matching this regex." })),
	view: Type.Optional(
		Type.Union([Type.Literal("log"), Type.Literal("screen")], {
			description: "'log' returns new raw output (default); 'screen' returns the rendered xterm grid.",
		}),
	),
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
			const sessionId = resolveTerminalId(ctx.manager, input.bash_id);
			const runtime = ctx.manager.get(sessionId);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);

			const monitorEntry = ctx.monitorRegistry?.snapshot().find((entry) => entry.id === sessionId);
			const muted = monitorEntry?.paused === true;
			const mutedDropped = muted ? (ctx.monitorRegistry?.mutedDropped(sessionId) ?? 0) : 0;
			let mutedNote = "";
			if (muted) {
				mutedNote =
					mutedDropped > 0
						? `monitor muted — ${mutedDropped} line(s) dropped while muted; run monitor({ action: "rearm", bash_id: "${input.bash_id}" }) to resume.`
						: `monitor muted; run monitor({ action: "rearm", bash_id: "${input.bash_id}" }) to resume.`;
			}
			const extra = monitorEntry ? { details: { monitorMuted: muted, mutedDropped } } : undefined;
			const prefix = mutedNote.length > 0 ? `${mutedNote}\n` : "";

			if (input.view === "screen") {
				return textResult(`${prefix}${statusLine(runtime)}\n${screenView(runtime)}`, extra);
			}

			const delta = runtime.readDelta();
			const formatted = formatTerminalToolOutput(applyFilter(delta.text, input.filter));
			const dropped = delta.droppedChars > 0 ? `[${delta.droppedChars} earlier chars dropped]\n` : "";
			return textResult(`${prefix}${statusLine(runtime)}\n${dropped}${formatted.text || "(no new output)"}`, extra);
		},
		renderCall: renderBashOutputCall,
		renderResult: renderBashOutputResult,
	};
}
