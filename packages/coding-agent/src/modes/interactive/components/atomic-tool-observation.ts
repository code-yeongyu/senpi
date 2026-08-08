import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { extractPatchedPaths } from "../../../core/extensions/builtin/gpt-apply-patch/text.ts";
import type { ToolExecutionIdentity, ToolExecutionResult } from "./tool-execution-types.ts";

const CHAR_LIMIT = 16_384;
const ITEM_LIMIT = 64;
const SAMPLE_ITEM_LIMIT = ITEM_LIMIT / 2;
const TARGET_ITEM_LIMIT = 8;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const TARGET_FIELDS = [
	"task_summary",
	"description",
	"path",
	"file_path",
	"filePath",
	"url",
	"query",
	"pattern",
	"command",
	"newName",
	"name",
	"symbol",
	"bash_id",
	"task_id",
	"team_id",
	"cell_id",
	"action",
] as const;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function sanitizeAtomicLabel(value: string): string {
	return stripTerminalSequences(value.slice(0, CHAR_LIMIT))
		.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
		.replace(BIDI_CONTROLS, "")
		.replace(/·/g, "∙")
		.replace(/\s+/g, " ")
		.trim();
}

function stringField(value: unknown): string | undefined {
	if (typeof value === "string") return sanitizeAtomicLabel(value) || undefined;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resultText(result: ToolExecutionResult | undefined): { text: string; truncated: boolean } {
	if (!result) return { text: "", truncated: false };
	let totalChars = 0;
	const exact: string[] = [];
	const exactLimit = Math.min(result.content.length, ITEM_LIMIT);
	for (let index = 0; index < exactLimit; index++) {
		const item = result.content[index];
		if (!item) continue;
		if (item.type !== "text") continue;
		const text = item.text;
		totalChars += text.length;
		exact.push(text);
	}
	if (result.content.length <= ITEM_LIMIT && totalChars <= CHAR_LIMIT) {
		return { text: exact.join("\n"), truncated: false };
	}

	const sampleLimit = CHAR_LIMIT / 2;
	let headRemaining = sampleLimit;
	const head: string[] = [];
	for (let index = 0; index < result.content.length && index < SAMPLE_ITEM_LIMIT && headRemaining > 0; index++) {
		const item = result.content[index];
		if (item?.type !== "text") continue;
		const itemText = item.text;
		const text = itemText.slice(0, headRemaining);
		head.push(text);
		headRemaining -= text.length;
	}

	let tailRemaining = sampleLimit;
	const tail: string[] = [];
	for (
		let index = result.content.length - 1, seen = 0;
		index >= 0 && seen < SAMPLE_ITEM_LIMIT && tailRemaining > 0;
		index--
	) {
		const item = result.content[index];
		seen++;
		if (item?.type !== "text") continue;
		const itemText = item.text;
		const text = itemText.slice(-tailRemaining);
		tail.unshift(text);
		tailRemaining -= text.length;
	}
	return { text: head.join("\n") + tail.join("\n"), truncated: true };
}

function stripBashTrailer(text: string): { output: string; status?: string } {
	const normalized = text.replace(/\r\n?/g, "\n").trimEnd();
	const exit = /(?:\n\n?)?Command exited with code (\d+)$/.exec(normalized);
	if (exit) return { output: normalized.slice(0, exit.index).trimEnd(), status: `exit ${exit[1]}` };
	const timeout = /(?:\n\n?)?Command timed out(?: after \d+(?:\.\d+)? seconds)?$/.exec(normalized);
	if (timeout) return { output: normalized.slice(0, timeout.index).trimEnd(), status: "timed out" };
	const aborted = /(?:\n\n?)?Command aborted$/.exec(normalized);
	if (aborted) return { output: normalized.slice(0, aborted.index).trimEnd(), status: "aborted" };
	return { output: normalized };
}

function countLines(text: string): number {
	if (!text || text === "(no output)") return 0;
	return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

export function observedBashLines(
	result: ToolExecutionResult | undefined,
): { count: number; truncated: boolean } | undefined {
	if (!result) return undefined;
	const totalLines = nonNegativeNumber(record(record(result.details)?.truncation)?.totalLines);
	if (totalLines !== undefined && Number.isInteger(totalLines)) return { count: totalLines, truncated: false };
	const observed = resultText(result);
	const text = result.isError ? stripBashTrailer(observed.text).output : observed.text;
	return { count: countLines(text), truncated: observed.truncated };
}

export function bashFailureStatus(result: ToolExecutionResult | undefined): string | undefined {
	return result?.isError ? (stripBashTrailer(resultText(result).text).status ?? "failed") : undefined;
}

function applyPatchTarget(args: unknown): string | undefined {
	const input = typeof args === "string" ? args : record(args)?.input;
	if (typeof input !== "string" || !input) return undefined;
	const seen = new Set<string>();
	const names: string[] = [];
	for (const rawPath of extractPatchedPaths(input.slice(0, CHAR_LIMIT))) {
		const normalized = rawPath.replace(/\\/g, "/").replace(/\/+$/, "");
		const name = sanitizeAtomicLabel(normalized.slice(normalized.lastIndexOf("/") + 1));
		if (!name || seen.has(name)) continue;
		seen.add(name);
		names.push(name);
		if (names.length === TARGET_ITEM_LIMIT) break;
	}
	return names.join(", ") || undefined;
}

export function atomicTarget(identity: ToolExecutionIdentity, args: unknown): string | undefined {
	const fields = record(args);
	if (identity.toolName === "apply_patch") return applyPatchTarget(args);
	if (identity.toolName === "bash") {
		const description = stringField(fields?.description);
		if (description !== undefined) return description;
		const command = fields?.command;
		if (typeof command !== "string") return undefined;
		return sanitizeAtomicLabel(command.slice(0, CHAR_LIMIT).split(/\r?\n/, 1)[0] ?? "");
	}
	if (identity.toolName === "eval") {
		const title = stringField(fields?.title);
		if (title) return title;
		const action = stringField(fields?.action);
		const cellId = stringField(fields?.cell_id);
		if (action && cellId) return `${action} ${cellId}`;
		return stringField(fields?.language);
	}
	for (const field of TARGET_FIELDS) {
		const value = stringField(fields?.[field]);
		if (value) return value;
	}
	return undefined;
}
