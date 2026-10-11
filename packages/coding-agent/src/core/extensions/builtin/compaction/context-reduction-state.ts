export const CONTEXT_REDUCTION_ENTRY_TYPE = "senpi.context-reduction.v1";

export interface ContextReductionState {
	engaged: boolean;
	cutIndex: number;
	prefixHash: string;
	anchorCount?: number;
	anchorCut?: number;
	anchorHash?: string;
	anchorTokens?: number;
	compactionRequired?: boolean;
}

export interface ContextReductionRequest {
	count: number;
	cut: number;
	hash: string;
}

export function createContextReductionState(): ContextReductionState {
	return { engaged: false, cutIndex: 0, prefixHash: "" };
}

export function snapshotReductionState(state: ContextReductionState): ContextReductionState {
	const saved = { ...state };
	delete saved.compactionRequired;
	return saved;
}

export function clearReductionAnchor(state: ContextReductionState): void {
	delete state.anchorCount;
	delete state.anchorCut;
	delete state.anchorHash;
	delete state.anchorTokens;
}

export function recordReductionUsage(
	state: ContextReductionState,
	request: ContextReductionRequest,
	tokens: number,
): void {
	if (
		!Number.isFinite(tokens) ||
		tokens <= 0 ||
		state.compactionRequired ||
		request.cut !== state.cutIndex ||
		request.hash !== state.prefixHash
	)
		return;
	state.anchorCount = request.count;
	state.anchorCut = request.cut;
	state.anchorHash = request.hash;
	state.anchorTokens = tokens;
}

export function readContextReductionState(data: unknown): ContextReductionState | undefined {
	if (
		typeof data !== "object" ||
		data === null ||
		!("engaged" in data) ||
		typeof data.engaged !== "boolean" ||
		!("cutIndex" in data) ||
		typeof data.cutIndex !== "number" ||
		!Number.isSafeInteger(data.cutIndex) ||
		data.cutIndex < 0 ||
		!("prefixHash" in data) ||
		typeof data.prefixHash !== "string"
	)
		return undefined;
	const state: ContextReductionState = { engaged: data.engaged, cutIndex: data.cutIndex, prefixHash: data.prefixHash };
	if ("anchorCount" in data || "anchorCut" in data || "anchorHash" in data || "anchorTokens" in data) {
		if (
			!("anchorCount" in data) ||
			typeof data.anchorCount !== "number" ||
			!Number.isSafeInteger(data.anchorCount) ||
			data.anchorCount < 0 ||
			!("anchorCut" in data) ||
			typeof data.anchorCut !== "number" ||
			!Number.isSafeInteger(data.anchorCut) ||
			data.anchorCut < 0 ||
			data.anchorCut > data.anchorCount ||
			!("anchorHash" in data) ||
			typeof data.anchorHash !== "string" ||
			!("anchorTokens" in data) ||
			typeof data.anchorTokens !== "number" ||
			!Number.isFinite(data.anchorTokens) ||
			data.anchorTokens < 0
		)
			return undefined;
		state.anchorCount = data.anchorCount;
		state.anchorCut = data.anchorCut;
		state.anchorHash = data.anchorHash;
		state.anchorTokens = data.anchorTokens;
	}
	return state;
}
