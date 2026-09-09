import { type Component, Text } from "@earendil-works/pi-tui";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import type { ToolExecutionResult } from "./tool-execution-types.ts";

const FALLBACK_STRING_MAX_LENGTH = 160;
const FALLBACK_JSON_MAX_LENGTH = 2000;
const JSON_VIEW_MAX_DEPTH = 3;
const JSON_VIEW_MAX_ROWS = 24;
const JSON_VIEW_MAX_VALUE_LENGTH = 100;

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

type JsonRecord = Record<string, unknown>;

function parseRenderableJson(text: string): JsonRecord | unknown[] | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as JsonRecord | unknown[];
	} catch {
		return undefined;
	}
}

function truncateJsonViewValue(value: string): string {
	return value.length > JSON_VIEW_MAX_VALUE_LENGTH ? `${value.slice(0, JSON_VIEW_MAX_VALUE_LENGTH)}\u2026` : value;
}

function styleJsonPrimitive(value: unknown): string {
	if (typeof value === "string") return theme.fg("toolOutput", truncateJsonViewValue(value));
	if (typeof value === "number" || typeof value === "boolean") return theme.fg("accent", String(value));
	if (value === null) return theme.fg("dim", "null");
	return theme.fg("toolOutput", truncateJsonViewValue(String(value)));
}

function styleJsonCompact(value: unknown): string {
	return theme.fg("toolOutput", truncateJsonViewValue(JSON.stringify(value) ?? String(value)));
}

function isJsonContainer(value: unknown): value is JsonRecord | unknown[] {
	return typeof value === "object" && value !== null;
}

/**
 * Flattens a parsed JSON value into bounded `key: value` rows. Returns the rendered rows plus the
 * number of entries that were dropped so the caller can append a single truncation line.
 */
function collectJsonViewRows(value: JsonRecord | unknown[]): { rows: string[]; omitted: number } {
	const rows: string[] = [];
	let omitted = 0;

	const walk = (node: JsonRecord | unknown[], depth: number): void => {
		const entries: Array<[string, unknown]> = Array.isArray(node)
			? node.map((item, index) => [String(index), item])
			: Object.entries(node);
		const indent = "  ".repeat(depth);

		for (const [key, entryValue] of entries) {
			if (rows.length >= JSON_VIEW_MAX_ROWS) {
				omitted += 1;
				continue;
			}
			const label = `${indent}${theme.fg("muted", `${key}:`)}`;
			if (isJsonContainer(entryValue)) {
				if (depth + 1 >= JSON_VIEW_MAX_DEPTH) {
					rows.push(`${label} ${styleJsonCompact(entryValue)}`);
					continue;
				}
				rows.push(label);
				walk(entryValue, depth + 1);
				continue;
			}
			rows.push(`${label} ${styleJsonPrimitive(entryValue)}`);
		}
	};

	walk(value, 0);
	return { rows, omitted };
}

function renderJsonView(value: JsonRecord | unknown[]): string {
	const { rows, omitted } = collectJsonViewRows(value);
	if (rows.length === 0) return theme.fg("dim", "(empty)");
	if (omitted > 0) rows.push(theme.fg("dim", `\u2026 ${omitted} more`));
	return rows.join("\n");
}

export function createToolCallFallback(toolName: string): Component {
	return new Text(theme.fg("toolTitle", theme.bold(toolName)), 0, 0);
}

export function createToolResultFallback(
	result: ToolExecutionResult | undefined,
	showImages: boolean,
): Component | undefined {
	const output = getRenderedTextOutput(result, showImages);
	if (!output) return undefined;
	const parsed = parseRenderableJson(output);
	if (parsed) return new Text(renderJsonView(parsed), 0, 0);
	return new Text(theme.fg("toolOutput", output), 0, 0);
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
