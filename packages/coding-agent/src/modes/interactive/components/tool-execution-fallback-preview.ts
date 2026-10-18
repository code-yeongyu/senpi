import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import type { ToolExecutionResult } from "./tool-execution-types.ts";

const FALLBACK_PREVIEW_LINES = 10;

/** A collapsed fallback card shows the first lines of its text output and how to expand the rest. */
export function collapseFallbackResult(
	result: ToolExecutionResult | undefined,
	showImages: boolean,
	expanded: boolean,
): ToolExecutionResult | undefined {
	if (!result || expanded) return result;
	const output = getRenderedTextOutput(result, showImages);
	if (!output) return result;
	const lines = output.split("\n");
	if (lines.length <= FALLBACK_PREVIEW_LINES) return result;

	const remaining = lines.length - FALLBACK_PREVIEW_LINES;
	const text =
		lines.slice(0, FALLBACK_PREVIEW_LINES).join("\n") +
		`${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	return { ...result, content: [{ type: "text", text }] };
}
