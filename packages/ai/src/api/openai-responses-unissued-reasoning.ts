import type { ResponseCreateParamsStreaming, ResponseInputItem } from "openai/resources/responses/responses.js";
import { registerSessionResourceCleanup } from "../session-resources.ts";

/**
 * A replayed reasoning item's `encrypted_content` is bound to the caller (account or key) it was issued to
 * (senpi#1836). Same-model replay sends it back verbatim, so once a request is served as another caller every later
 * request fails with "reasoning encrypted_content was not issued to this caller" and the session is stuck. Removing
 * only `encrypted_content` still fails while the item `id` remains, so recovery drops the whole reasoning item.
 *
 * Only the items replayed by the rejected request are dropped, and they stay dropped for the rest of the session on
 * that route; reasoning issued later (to the current caller) keeps replaying. The local transcript is untouched.
 */

const UNISSUED_REASONING = /encrypted_content was not issued to this caller/i;

// `${sessionId}\u0000${baseUrl}\u0000${modelId}\u0000${reasoningItemId}`
const unissuedReasoningItems = new Set<string>();

registerSessionResourceCleanup((sessionId?: string) => {
	if (sessionId === undefined) {
		unissuedReasoningItems.clear();
		return;
	}
	const prefix = `${sessionId}\u0000`;
	for (const key of unissuedReasoningItems) {
		if (key.startsWith(prefix)) unissuedReasoningItems.delete(key);
	}
});

export function isUnissuedReasoningError(error: unknown): boolean {
	if (!(error instanceof Error) || !UNISSUED_REASONING.test(error.message)) return false;
	const status = (error as { status?: unknown }).status;
	return status === undefined || status === 400;
}

function reasoningItemId(item: ResponseInputItem): string | undefined {
	return item.type === "reasoning" && typeof item.id === "string" ? item.id : undefined;
}

export class UnissuedReasoningReplay {
	private readonly dropped = new Set<string>();
	private readonly prefix: string | undefined;

	constructor(model: { readonly baseUrl: string; readonly id: string }, sessionId: string | undefined) {
		this.prefix = sessionId === undefined ? undefined : `${sessionId}\u0000${model.baseUrl}\u0000${model.id}\u0000`;
		if (this.prefix === undefined) return;
		for (const key of unissuedReasoningItems) {
			if (key.startsWith(this.prefix)) this.dropped.add(key.slice(this.prefix.length));
		}
	}

	/** The payload without the reasoning items this session already saw rejected on this route. */
	strip<T extends Pick<ResponseCreateParamsStreaming, "input">>(params: T): T {
		if (this.dropped.size === 0 || !Array.isArray(params.input)) return params;
		const input = params.input.filter((item) => {
			const id = reasoningItemId(item);
			return id === undefined || !this.dropped.has(id);
		});
		return input.length === params.input.length ? params : { ...params, input };
	}

	/** True when `error` is the caller-binding rejection and `params` replayed reasoning not yet dropped. */
	learnFrom(error: unknown, params: Pick<ResponseCreateParamsStreaming, "input">): boolean {
		if (!isUnissuedReasoningError(error) || !Array.isArray(params.input)) return false;
		let learned = false;
		for (const item of params.input) {
			const id = reasoningItemId(item);
			if (id === undefined || this.dropped.has(id)) continue;
			this.dropped.add(id);
			if (this.prefix !== undefined) unissuedReasoningItems.add(this.prefix + id);
			learned = true;
		}
		return learned;
	}
}
