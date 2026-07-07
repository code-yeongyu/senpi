import { type Static, Type } from "typebox";
import type { TerminalRuntimeSession } from "../runtime-session.ts";
import { DEFAULT_OUTPUT_WAIT_TIMEOUT_SECONDS, safeRegExp, TERMINAL_OUTPUT_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";
import { describeExit } from "./spawn.ts";

export const bashOutputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	filter: Type.Optional(Type.String({ description: "Only return output lines matching this regex." })),
	wait_for: Type.Optional(
		Type.String({ description: "Block until output matches this regex, the session exits, or timeout." }),
	),
	block: Type.Optional(Type.Boolean({ description: "When wait_for is set, block (default true)." })),
	timeout: Type.Optional(Type.Number({ description: "wait_for timeout in seconds (default 30)." })),
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
			"Read new output from a background bash session, or block until wait_for matches / the session exits / timeout. Use view:'screen' for a rendered full-screen snapshot.",
		promptSnippet: "Read/subscribe to background bash session output (wait_for, filter, screen view)",
		parameters: bashOutputSchema,
		async execute(_toolCallId: string, input: BashOutputInput, _signal?: AbortSignal): Promise<TerminalToolResult> {
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);

			if (input.wait_for && input.block !== false) {
				const timeoutMs = Math.trunc((input.timeout ?? DEFAULT_OUTPUT_WAIT_TIMEOUT_SECONDS) * 1000);
				const outcome = await runtime.waitFor(input.wait_for, timeoutMs);
				if (outcome === "invalid_pattern") return errorResult(`Invalid wait_for regex: ${input.wait_for}`);
			}

			if (input.view === "screen") {
				return textResult(`${statusLine(runtime)}\n${screenView(runtime)}`);
			}

			const delta = runtime.readDelta();
			const filtered = applyFilter(delta.text, input.filter).trimEnd();
			const dropped = delta.droppedChars > 0 ? `[${delta.droppedChars} earlier chars dropped]\n` : "";
			return textResult(`${statusLine(runtime)}\n${dropped}${filtered || "(no new output)"}`);
		},
	};
}
