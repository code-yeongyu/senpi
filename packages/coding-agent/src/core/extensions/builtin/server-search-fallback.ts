import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

// Request-local metadata: Symbols survive hook-to-hook object spreads, but are
// omitted by JSON.stringify and never reach the provider or stored transcript.
export const SERVER_SEARCH_FALLBACK = Symbol.for("senpi.serverSearchFallback");
export const SERVER_SEARCH_DISABLED = Symbol.for("senpi.serverSearchDisabled");

const failedModels = new WeakMap<object, Set<string>>();

function modelKey(model: Pick<Model<Api>, "api" | "provider" | "id" | "baseUrl">): string {
	return JSON.stringify([model.api, model.provider, model.id, model.baseUrl]);
}

export function resetServerSearchFailures(session: object): void {
	failedModels.delete(session);
}

export function rememberServerSearchFailure(session: object, model: Model<Api>): void {
	let failures = failedModels.get(session);
	if (!failures) {
		failures = new Set();
		failedModels.set(session, failures);
	}
	failures.add(modelKey(model));
}

export function hasServerSearchFailed(session: object, model: Model<Api> | undefined): boolean {
	return model !== undefined && failedModels.get(session)?.has(modelKey(model)) === true;
}

export function markServerSearchFallback(payload: unknown): unknown {
	return payload !== null && typeof payload === "object" ? { ...payload, [SERVER_SEARCH_FALLBACK]: true } : payload;
}

export function disableServerSearch(payload: unknown): unknown {
	return payload !== null && typeof payload === "object" ? { ...payload, [SERVER_SEARCH_DISABLED]: true } : payload;
}

export function withoutServerSearch(
	onPayload: SimpleStreamOptions["onPayload"],
	cacheRetention: SimpleStreamOptions["cacheRetention"] = "none",
): SimpleStreamOptions["onPayload"] {
	// Cache-friendly summaries must keep the main-turn hook and tool prefix verbatim.
	if (cacheRetention !== "none") return onPayload;
	return async (payload, model, request) => {
		const disabled = disableServerSearch(payload);
		return (await onPayload?.(disabled, model, request)) ?? disabled;
	};
}

export function isServerSearchDisabled(payload: unknown): boolean {
	return (
		payload !== null &&
		typeof payload === "object" &&
		SERVER_SEARCH_DISABLED in payload &&
		payload[SERVER_SEARCH_DISABLED] === true
	);
}

export function isServerSearchFallback(payload: unknown): boolean {
	return (
		payload !== null &&
		typeof payload === "object" &&
		SERVER_SEARCH_FALLBACK in payload &&
		payload[SERVER_SEARCH_FALLBACK] === true
	);
}
