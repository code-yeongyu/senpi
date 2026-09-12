import { type AgentToolResult, sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import type { EvalToolCallSummary } from "./types.ts";

export const MAX_ENRICHED_TOOL_CALLS = 30;
export const MAX_AGGREGATED_TOOL_NAMES = 64;
export const MAX_CAPTURED_IDENTIFIER_CODE_POINTS = 128;
export const MAX_CAPTURED_TOOL_NAME_CODE_POINTS = 128;
export const MAX_RPC_EVENT_BYTES = 32 * 1024;

const MAX_ARGUMENT_STRING_CODE_POINTS = 512;
const MAX_ARGUMENT_ENTRIES = 32;
const MAX_ARGUMENT_DEPTH = 6;
const MAX_SERIALIZED_ARGUMENT_LENGTH = 4096;
const MAX_RESULT_PREVIEW_CODE_POINTS = 160;

type BoundedValue = {
	readonly value: unknown;
	readonly truncated: boolean;
};

export interface EvalToolCallMetric {
	readonly name: string;
	readonly startedAt: number;
	ok: boolean | undefined;
	durationMs: number | undefined;
}

export interface ToolCallCapture {
	readonly callId: string;
	readonly args: unknown;
	readonly startedAt: number;
	readonly metric: EvalToolCallMetric;
	readonly includeDetails: boolean;
	readonly argsTruncated?: true;
}

export function capCodePoints(text: string, max: number): string {
	let end = 0;
	let count = 0;
	while (count < max && end < text.length) {
		const firstCodeUnit = text.charCodeAt(end);
		const secondCodeUnit = text.charCodeAt(end + 1);
		const isSurrogatePair =
			firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff && secondCodeUnit >= 0xdc00 && secondCodeUnit <= 0xdfff;
		end += isSurrogatePair ? 2 : 1;
		count += 1;
	}
	return end === text.length ? text : `${text.slice(0, end)}…`;
}

function boundValue(value: unknown, depth: number, ancestors: WeakSet<object>): BoundedValue {
	if (typeof value === "string") {
		const capped = capCodePoints(value, MAX_ARGUMENT_STRING_CODE_POINTS);
		return { value: capped, truncated: capped !== value };
	}

	if (value === null || typeof value !== "object") return { value, truncated: false };
	if (depth >= MAX_ARGUMENT_DEPTH) return { value: "…", truncated: true };
	if (ancestors.has(value)) throw new Error("cyclic tool-call arguments");

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const retainedLength = Math.min(value.length, MAX_ARGUMENT_ENTRIES);
			const clone: unknown[] = [];
			let truncated = value.length > MAX_ARGUMENT_ENTRIES;
			for (let index = 0; index < retainedLength; index += 1) {
				const bounded = boundValue(value[index], depth + 1, ancestors);
				clone.push(bounded.value);
				truncated ||= bounded.truncated;
			}
			return { value: clone, truncated };
		}

		const entries: [string, unknown][] = [];
		let truncated = false;
		let count = 0;
		for (const [key, nestedValue] of Object.entries(value)) {
			if (count >= MAX_ARGUMENT_ENTRIES) {
				truncated = true;
				break;
			}
			const bounded = boundValue(nestedValue, depth + 1, ancestors);
			entries.push([key, bounded.value]);
			truncated ||= bounded.truncated;
			count += 1;
		}
		return { value: Object.fromEntries(entries), truncated };
	} finally {
		ancestors.delete(value);
	}
}

export function boundToolCallArgs(args: unknown): { args: unknown; truncated: boolean } {
	try {
		const bounded = boundValue(args, 0, new WeakSet<object>());
		const serialized = JSON.stringify(bounded.value);
		if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_ARGUMENT_LENGTH) {
			return { args: undefined, truncated: true };
		}
		return { args: bounded.value, truncated: bounded.truncated };
	} catch {
		return { args: undefined, truncated: true };
	}
}

export function createToolCallMetric(name: string, startedAt: number): EvalToolCallMetric {
	return {
		name: capCodePoints(name, MAX_CAPTURED_TOOL_NAME_CODE_POINTS),
		startedAt,
		ok: undefined,
		durationMs: undefined,
	};
}

export function settleToolCallMetric(metric: EvalToolCallMetric, ok: boolean, completedAt: number): void {
	metric.ok = ok;
	metric.durationMs = Math.max(0, completedAt - metric.startedAt);
}

export function recordToolCall(
	toolCalls: EvalToolCallSummary[],
	ok: boolean,
	capture: ToolCallCapture,
	resultPreview: string | undefined,
	error: string | undefined,
): void {
	const completedAt = Date.now();
	settleToolCallMetric(capture.metric, ok, completedAt);
	const summary = {
		name: capture.metric.name,
		ok,
		...(error === undefined ? {} : { error: capCodePoints(error, 512) }),
		...(capture.includeDetails ? { durationMs: completedAt - capture.startedAt } : {}),
	};
	const enrichedCount = toolCalls.filter((toolCall) => toolCall.callId !== undefined).length;
	if (!capture.includeDetails || enrichedCount >= MAX_ENRICHED_TOOL_CALLS) {
		toolCalls.push(summary);
		return;
	}
	toolCalls.push({
		...summary,
		callId: capture.callId,
		args: capture.args,
		...(capture.argsTruncated === true ? { argsTruncated: true } : {}),
		...(resultPreview === undefined ? {} : { resultPreview }),
	});
}

export function toolCallResultPreview(result: AgentToolResult<unknown>): string | undefined {
	for (const part of result.content) {
		if (part.type !== "text") continue;
		const preview = sanitizeTerminalLabel(part.text).replace(/\s+/gu, " ").trim();
		return preview.length === 0 ? undefined : capCodePoints(preview, MAX_RESULT_PREVIEW_CODE_POINTS);
	}
	return undefined;
}
