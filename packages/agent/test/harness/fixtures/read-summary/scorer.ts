import { createHash } from "node:crypto";

export type Fold = { readonly start: number; readonly end: number };
export type Sample = {
	readonly path: string;
	readonly source: string;
	readonly sha256: string;
	readonly folds: readonly Fold[];
	readonly allowed: readonly Fold[];
	readonly protected?: readonly Fold[];
	readonly rawTokens: number;
	readonly ompTokens: number;
	readonly candidateTokens: number;
	readonly retainedExact: boolean;
};
export type CandidateEngine = "heuristic" | "wasm";
export type Measurement = {
	readonly samples: readonly Sample[];
	readonly referenceAvailable: boolean;
	readonly tokenizerExact: boolean;
	readonly embeddedBytes: number;
	readonly budget: number;
	/** Which fold-boundary engine produced `folds`/`candidateTokens`. Default: the heuristic folder. */
	readonly engine?: CandidateEngine;
};
export type Selection = {
	readonly engine: CandidateEngine | "raw";
	readonly status: "conclusive" | "inconclusive" | "pending_owner";
	readonly reason: string;
	readonly medianSaving?: number;
	readonly referenceMedianSaving?: number;
};
export function sha256(source: string | Uint8Array): string {
	return createHash("sha256").update(source).digest("hex");
}
export function overlaps(left: Fold, right: Fold): boolean {
	return left.start <= right.end && left.end >= right.start;
}
export function validBoundaries(
	sample: Pick<Sample, "source" | "folds" | "allowed" | "protected" | "retainedExact">,
): boolean {
	let previousEnd = 0;
	for (const fold of sample.folds) {
		if (
			!Number.isSafeInteger(fold.start) ||
			!Number.isSafeInteger(fold.end) ||
			fold.start <= previousEnd ||
			fold.end < fold.start ||
			fold.end > sample.source.split("\n").length ||
			sample.protected?.some((header) => overlaps(fold, header)) ||
			!sample.allowed.some((range) => range.start === fold.start && range.end === fold.end)
		)
			return false;
		previousEnd = fold.end;
	}
	return sample.retainedExact;
}
export function selectEngine(measurement: Measurement): Selection {
	const raw = (reason: string, status: Selection["status"] = "inconclusive"): Selection => ({
		engine: "raw",
		status,
		reason,
	});
	const { samples } = measurement;
	if (!measurement.referenceAvailable) return raw("reference_unavailable");
	if (!measurement.tokenizerExact) return raw("exact_tokenizer_required");
	if (
		!Number.isSafeInteger(measurement.embeddedBytes) ||
		measurement.embeddedBytes < 0 ||
		!Number.isSafeInteger(measurement.budget) ||
		measurement.budget < 0 ||
		measurement.embeddedBytes > measurement.budget
	)
		return raw("embedded_budget_exceeded");
	if (samples.length !== 5) return raw("measurement_blocked_insufficient_corpus", "pending_owner");
	if (new Set(samples.map((sample) => sample.path)).size !== samples.length) return raw("duplicate_corpus_path");
	if (samples.some((sample) => sha256(sample.source) !== sample.sha256)) return raw("stale_corpus_hash");
	if (
		samples.some((sample) => {
			const lines = sample.source.split("\n").length - Number(sample.source.endsWith("\n"));
			return lines < 100 || lines > 2000 || Buffer.byteLength(sample.source) > 51200;
		})
	)
		return raw("ineligible_corpus");
	if (samples.some((sample) => !validBoundaries(sample))) return raw("invalid_boundaries", "pending_owner");
	if (
		samples.some(
			(sample) =>
				![sample.rawTokens, sample.ompTokens, sample.candidateTokens].every(
					(count) => Number.isSafeInteger(count) && count >= 0,
				) || sample.rawTokens === 0,
		)
	)
		return raw("invalid_token_counts");
	const savings = samples
		.map((sample) => (sample.rawTokens - sample.candidateTokens) / sample.rawTokens)
		.sort((a, b) => a - b);
	const reference = samples
		.map((sample) => (sample.rawTokens - sample.ompTokens) / sample.rawTokens)
		.sort((a, b) => a - b);
	const medianSaving = savings[2];
	const referenceMedianSaving = reference[2];
	const positive = samples.reduce((sum, sample) => sum + sample.rawTokens - sample.candidateTokens, 0) > 0;
	const wins = positive && (referenceMedianSaving <= 0 || medianSaving >= referenceMedianSaving * 0.9);
	// A measured shortfall is a decided outcome, not a pending decision: the owner approved WASM in #1685.
	return {
		engine: wins ? (measurement.engine ?? "heuristic") : "raw",
		status: "conclusive",
		reason: wins ? "safe_quality_threshold_met" : "candidate_below_reference_threshold",
		medianSaving,
		referenceMedianSaving,
	};
}
