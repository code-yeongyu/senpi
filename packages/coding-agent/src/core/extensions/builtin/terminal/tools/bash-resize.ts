import { type Static, Type } from "typebox";
import { TERMINAL_RESIZE_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";

export const bashResizeSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	cols: Type.Number({ description: "New PTY width in columns." }),
	rows: Type.Number({ description: "New PTY height in rows." }),
});

export type BashResizeInput = Static<typeof bashResizeSchema>;

function valid(value: number): boolean {
	return Number.isFinite(value) && value >= 1;
}

export function createBashResizeTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_RESIZE_TOOL,
		label: "bash_resize",
		description:
			"Resize a live background bash session's PTY (cols x rows) so full-screen TUIs reflow. No-ops with a note under the pipe fallback.",
		promptSnippet: "Resize a background bash session's PTY so TUIs reflow",
		parameters: bashResizeSchema,
		async execute(_toolCallId: string, input: BashResizeInput, _signal?: AbortSignal): Promise<TerminalToolResult> {
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);
			if (runtime.exited) return errorResult(`Session ${input.bash_id} is not running; cannot resize.`);
			if (!valid(input.cols) || !valid(input.rows)) {
				return errorResult("cols and rows must be finite integers >= 1.");
			}
			const cols = Math.trunc(input.cols);
			const rows = Math.trunc(input.rows);
			const result = runtime.session.resize(cols, rows);
			runtime.resizeScreen(cols, rows);
			if (!result.ok) return textResult(`Resize note for ${input.bash_id}: ${result.note}`);
			return textResult(`Resized ${input.bash_id} to ${cols}x${rows}.`);
		},
	};
}
