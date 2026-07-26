import type { AssistantMessage } from "../types.ts";
import { appendAssistantMessageDiagnostic } from "./diagnostics.ts";

export const SERVER_FALLBACK_ABORTED_DIAGNOSTIC = "server_fallback_aborted";
export const BILLING_INCOMPLETE_DIAGNOSTIC = "billing_incomplete_after_client_abort";

export interface ServerFallbackReceipt {
	readonly from: string;
	readonly to: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModel(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	return typeof value.model === "string" && value.model.length > 0 ? value.model : undefined;
}

/**
 * Anthropic marks a classifier handoff with `{type:"fallback", from:{model}, to:{model}}`
 * (`server-side-fallback-*` betas). Returns undefined for anything else, so an
 * unrelated or malformed provider-native block falls through to normal handling.
 */
export function parseServerFallbackReceipt(block: unknown): ServerFallbackReceipt | undefined {
	if (!isRecord(block) || block.type !== "fallback") return undefined;
	const from = readModel(block.from);
	const to = readModel(block.to);
	return from !== undefined && to !== undefined ? { from, to } : undefined;
}

/**
 * Sticky routing serves later turns of a fallen-back conversation from the
 * substitute model with no `fallback` block at all; a `fallback_message` entry
 * in `usage.iterations` is the documented signal. A served-model string
 * comparison is deliberately NOT used: gateways and Bedrock-style endpoints
 * rewrite model ids, so a mismatch is not evidence of a fallback.
 */
export function parseStickyFallbackReceipt(
	usage: unknown,
	requestedModel: string,
	servedModel?: string,
): ServerFallbackReceipt | undefined {
	if (!isRecord(usage) || !Array.isArray(usage.iterations)) return undefined;
	for (let index = usage.iterations.length - 1; index >= 0; index--) {
		const entry: unknown = usage.iterations[index];
		if (!isRecord(entry) || entry.type !== "fallback_message") continue;
		const entryModel = typeof entry.model === "string" && entry.model.length > 0 ? entry.model : undefined;
		const to = entryModel ?? servedModel;
		return to !== undefined ? { from: requestedModel, to } : undefined;
	}
	return undefined;
}

export function serverFallbackRefusalExplanation(receipt: ServerFallbackReceipt): string {
	return `Server-side fallback (${receipt.from} -> ${receipt.to}) aborted by client policy`;
}

/**
 * Rewrites an aborted turn into the same shape a pre-output classifier refusal
 * has, so `isClassifierRefusal()` routes it through the caller's fallback chain.
 * Content is dropped: the substitute model's partial output was never requested,
 * and replaying a half-turn containing a fallback marker breaks Anthropic replay.
 */
export function applyServerFallbackAbort(message: AssistantMessage, receipt: ServerFallbackReceipt): void {
	const explanation = serverFallbackRefusalExplanation(receipt);
	message.content = [];
	message.stopReason = "error";
	message.stopDetails = { type: "refusal", explanation };
	message.errorMessage = explanation;
	appendAssistantMessageDiagnostic(message, {
		type: SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { from: receipt.from, to: receipt.to },
	});
	appendAssistantMessageDiagnostic(message, {
		type: BILLING_INCOMPLETE_DIAGNOSTIC,
		timestamp: Date.now(),
		details: { reason: "per-attempt usage does not arrive after a client abort" },
	});
}
