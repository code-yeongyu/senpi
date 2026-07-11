import { type Component, Text } from "@earendil-works/pi-tui";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionResult } from "./tool-execution-types.ts";

const FALLBACK_STRING_MAX_LENGTH = 160;
const FALLBACK_JSON_MAX_LENGTH = 2000;

function sanitizeFallbackString(value: string, maxLength = FALLBACK_STRING_MAX_LENGTH): string {
	const sanitized = stripAnsi(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (sanitized.length <= maxLength) {
		return sanitized;
	}
	return `${sanitized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function sanitizeFallbackJsonValue(_key: string, value: unknown): unknown {
	return typeof value === "string" ? sanitizeFallbackString(value) : value;
}

export function createToolCallFallback(toolName: string): Component {
	return new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
}

export function createToolResultFallback(
	result: ToolExecutionResult | undefined,
	showImages: boolean,
): Component | undefined {
	const output = getRenderedTextOutput(result, showImages);
	return output ? new Text(theme.fg("toolOutput", output), 0, 0) : undefined;
}

export function formatToolExecutionFallback(
	toolName: string,
	args: unknown,
	result: ToolExecutionResult | undefined,
	showImages: boolean,
): string {
	let text = theme.fg("toolTitle", theme.bold(sanitizeFallbackString(toolName)));
	const content = JSON.stringify(args, sanitizeFallbackJsonValue, 2);
	if (content) {
		const boundedContent =
			content.length > FALLBACK_JSON_MAX_LENGTH ? `${content.slice(0, FALLBACK_JSON_MAX_LENGTH - 3)}...` : content;
		text += `\n\n${boundedContent}`;
	}
	const output = getRenderedTextOutput(result, showImages);
	if (output) {
		text += `\n${sanitizeFallbackString(output, FALLBACK_JSON_MAX_LENGTH)}`;
	}
	return text;
}
