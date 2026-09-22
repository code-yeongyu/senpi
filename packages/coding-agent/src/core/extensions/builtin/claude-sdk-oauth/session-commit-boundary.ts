import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID } from "./account-management.ts";
import { sessionSyncDigest } from "./session-sync.ts";

export type AssistantCommitOutcome = "clean" | "rewritten" | "not-resident";

export type AssistantCommitResult = {
	outcome: AssistantCommitOutcome;
	/** First diverged field path between the provider-final and committed semantic projections. Paths only, never values (senpi#1975). */
	divergedPath?: string;
};

type ContentBlock = AssistantMessage["content"][number];

/**
 * Only the payload the model produced is fingerprinted. Everything the stream
 * pipeline stamps around it (thinking timing, content-block indices, partial
 * JSON) can legitimately differ between the last `message_update` and `message_end`
 * without any extension rewriting the answer; hashing such fields marked plain
 * turns `assistant_rewritten` and forced a full re-send on the next turn
 * (senpi#691, oh-my-openagent#7925). An unknown block shape stays fail-closed.
 */
function semanticContentBlock(block: ContentBlock): unknown {
	switch (block.type) {
		case "text":
			return { type: block.type, text: block.text };
		case "thinking":
			return { type: block.type, thinking: block.thinking, thinkingSignature: block.thinkingSignature };
		case "toolCall":
			return { type: block.type, id: block.id, name: block.name, arguments: block.arguments };
		default:
			return block;
	}
}

type AssistantSemanticProjection = {
	role: AssistantMessage["role"];
	api: AssistantMessage["api"];
	provider: AssistantMessage["provider"];
	model: AssistantMessage["model"];
	content: unknown[];
};

function semanticProjection(message: AssistantMessage): AssistantSemanticProjection {
	return {
		role: message.role,
		api: message.api,
		provider: message.provider,
		model: message.model,
		content: message.content.map(semanticContentBlock),
	};
}

export function assistantContentHash(message: AssistantMessage): string {
	return sessionSyncDigest(semanticProjection(message));
}

export function isResidentAssistant(message: AssistantMessage, modelId: string): boolean {
	return (
		message.api === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.provider === CLAUDE_SDK_OAUTH_PROVIDER_ID &&
		message.model === modelId
	);
}

export function isTerminalFailure(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}

const MAX_DIVERGENCE_DEPTH = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The captured projection must be a snapshot, not a reference: the rewrite
 * class this exists for (#1472, #1975) mutates tool-call arguments in place
 * between `message_update` and `message_end`, and a shared reference would
 * follow the mutation and blind the structural walk to exactly that case.
 */
function snapshotProjection(value: unknown, depth: number): unknown {
	if (depth > MAX_DIVERGENCE_DEPTH) return value;
	if (Array.isArray(value)) return value.map((item) => snapshotProjection(item, depth + 1));
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.keys(value).map((key) => [key, snapshotProjection(value[key], depth + 1)]));
}

function fieldOf(block: unknown, field: string): unknown {
	return isRecord(block) ? block[field] : undefined;
}

/**
 * First diverged sub-path between two JSON-shaped values: objects contribute
 * `.key` (sorted key order, so the path is deterministic), arrays contribute
 * `[n]`, and a length difference names the first index that exists on only one
 * side. Returns "" when the values at this position differ, undefined when they
 * are equal; the walk is depth-capped so pathological inputs name the parent
 * instead of recursing forever.
 */
function firstDivergedSegment(left: unknown, right: unknown, depth: number): string | undefined {
	if (left === right) return undefined;
	if (depth > MAX_DIVERGENCE_DEPTH) return "";
	if (Array.isArray(left) && Array.isArray(right)) {
		const shared = Math.min(left.length, right.length);
		for (let index = 0; index < shared; index += 1) {
			const inner = firstDivergedSegment(left[index], right[index], depth + 1);
			if (inner !== undefined) return `[${index}]${inner}`;
		}
		return left.length === right.length ? undefined : `[${shared}]`;
	}
	if (isRecord(left) && isRecord(right)) {
		for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
			const inner = firstDivergedSegment(left[key], right[key], depth + 1);
			if (inner !== undefined) return `.${key}${inner}`;
		}
		return undefined;
	}
	return "";
}

/**
 * First diverged path between the provider-final and committed projections, in
 * the order the vocabulary fixes: the content array first (`content.length`,
 * then per block `type`, the block's semantic fields, and for toolCall blocks
 * `id` / `name` / `arguments.<dotted key path>` walking objects dot-separated
 * and arrays by index), then the top-level identity fields. No value from
 * either projection is ever embedded (senpi#1975).
 */
function firstDivergedPath(providerFinal: AssistantSemanticProjection, committed: AssistantSemanticProjection): string {
	if (providerFinal.content.length !== committed.content.length) return "content.length";
	const shared = Math.min(providerFinal.content.length, committed.content.length);
	for (let index = 0; index < shared; index += 1) {
		const left = providerFinal.content[index];
		const right = committed.content[index];
		if (fieldOf(left, "type") !== fieldOf(right, "type")) return `content[${index}].type`;
		const kind = fieldOf(left, "type");
		if (kind === "text") {
			if (fieldOf(left, "text") !== fieldOf(right, "text")) return `content[${index}].text`;
		} else if (kind === "thinking") {
			if (fieldOf(left, "thinking") !== fieldOf(right, "thinking")) return `content[${index}].thinking`;
			if (fieldOf(left, "thinkingSignature") !== fieldOf(right, "thinkingSignature")) {
				return `content[${index}].thinkingSignature`;
			}
		} else if (kind === "toolCall") {
			if (fieldOf(left, "id") !== fieldOf(right, "id")) return `content[${index}].id`;
			if (fieldOf(left, "name") !== fieldOf(right, "name")) return `content[${index}].name`;
			const argumentsSegment = firstDivergedSegment(fieldOf(left, "arguments"), fieldOf(right, "arguments"), 0);
			if (argumentsSegment !== undefined) return `content[${index}].arguments${argumentsSegment}`;
		} else {
			const segment = firstDivergedSegment(left, right, 0);
			if (segment !== undefined) return `content[${index}]${segment}`;
		}
	}
	if (providerFinal.api !== committed.api) return "api";
	if (providerFinal.provider !== committed.provider) return "provider";
	if (providerFinal.model !== committed.model) return "model";
	return "content";
}

/**
 * Divergence is decided by comparing what the provider streamed against what the
 * session ledger committed, never by in-flight staging: a result-only turn fills
 * its content at the terminal message with no preceding delta, so a staged-hash
 * comparison reports false divergence on a perfectly valid SDK response shape.
 */
export class AssistantCommitBoundary {
	private readonly providerFinalByKey = new Map<string, { hash: string; projection: AssistantSemanticProjection }>();

	captureProviderFinal(key: string, message: AssistantMessage): void {
		this.providerFinalByKey.set(key, {
			hash: assistantContentHash(message),
			projection: snapshotProjection(semanticProjection(message), 0) as AssistantSemanticProjection,
		});
	}

	commit(key: string, message: AssistantMessage, modelId: string): AssistantCommitResult {
		const providerFinal = this.providerFinalByKey.get(key);
		this.providerFinalByKey.delete(key);
		if (!isResidentAssistant(message, modelId)) return { outcome: "not-resident" };
		if (providerFinal === undefined) return { outcome: "clean" };
		if (providerFinal.hash === assistantContentHash(message)) return { outcome: "clean" };
		return {
			outcome: "rewritten",
			divergedPath: firstDivergedPath(providerFinal.projection, semanticProjection(message)),
		};
	}

	forget(key: string): void {
		this.providerFinalByKey.delete(key);
	}
}
