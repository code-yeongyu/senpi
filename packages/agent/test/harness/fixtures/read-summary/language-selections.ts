import { languages } from "./corpus.ts";
import type { Prototype } from "./heuristic.ts";
import { type CandidateEngine, type Fold, type Sample, type Selection, selectEngine } from "./scorer.ts";
import { isWasmCandidateLanguage } from "./wasm-candidate.ts";

type EngineMeasurement = {
	readonly candidate: Prototype;
	readonly tokens: number;
	readonly valid: boolean;
	readonly exact: boolean;
};
type ScoredRow = {
	readonly entry: {
		readonly id: string;
		readonly language: string;
		readonly file: string;
		readonly source: string;
		readonly sha256: string;
	};
	readonly allowed: readonly Fold[];
	readonly rawTokens: number;
	readonly ompTokens: number;
	readonly defaultReadTokens: number;
	readonly minimumOracleSkeleton: number;
	readonly engines: { readonly heuristic: EngineMeasurement; readonly wasm?: EngineMeasurement };
};

/** No grammar candidate exists for a language whose oracle proves no protected declaration intervals. */
const UNEVALUATED_REASON = "wasm_candidate_unevaluated_no_signature_oracle";

function score(
	rows: readonly ScoredRow[],
	engine: CandidateEngine,
	measurement: (row: ScoredRow) => EngineMeasurement | undefined,
	budget: number,
	invalidIds: readonly string[],
) {
	const measured = rows.map((row) => ({ row, engine: measurement(row) }));
	if (measured.some((entry) => !entry.engine)) return undefined;
	const samples: Sample[] = measured.map(({ row, engine: value }) => ({
		path: row.entry.file,
		source: row.entry.source,
		sha256: row.entry.sha256,
		folds: value?.candidate.folds ?? [],
		allowed: row.allowed,
		retainedExact: value?.exact ?? false,
		rawTokens: row.rawTokens,
		ompTokens: row.ompTokens,
		candidateTokens: value?.tokens ?? row.rawTokens,
	}));
	const invalid = [
		...measured.filter(({ engine: value }) => value && !value.valid).map(({ row }) => row.entry.id),
		...invalidIds,
	];
	const result: Selection = invalid.length
		? { engine: "raw", status: "conclusive", reason: "invalid_boundaries" }
		: selectEngine({ samples, referenceAvailable: true, tokenizerExact: true, embeddedBytes: 0, budget, engine });
	return {
		...result,
		engine_name: engine,
		invalid_boundaries: invalid,
		files_with_folds: measured.filter(({ engine: value }) => (value?.candidate.folds.length ?? 0) > 0).length,
		discovered_folds: measured.reduce((sum, { engine: value }) => sum + (value?.candidate.scanned_folds ?? 0), 0),
		file_outcomes: measured.map(({ row, engine: value }) => ({
			id: row.entry.id,
			emitted_folds: value?.candidate.folds.length ?? 0,
			fallback_reason: value?.candidate.fallback_reason,
			minimum_oracle_skeleton_lines: row.minimumOracleSkeleton,
		})),
		total_saved_tokens: measured.reduce(
			(sum, { row, engine: value }) => sum + row.rawTokens - (value?.tokens ?? row.rawTokens),
			0,
		),
	};
}

/**
 * Per-language selection from the numbers: the heuristic keeps a language it already wins, the
 * grammar engine takes one it wins, and a measured shortfall stays raw with the measured reason.
 */
export function selectLanguages(
	samples: readonly ScoredRow[],
	budget: number,
	adversarial: readonly { readonly id: string; readonly language: string; readonly valid: boolean }[] = [],
) {
	return languages.map((language) => {
		if (language === "markdown")
			return { language, engine: "raw", status: "prose_exempt", reason: "markdown_and_txt_remain_raw" };
		const real = samples.filter((row) => row.entry.language === language && !row.entry.id.startsWith("boundary-"));
		const adversarialInvalid = adversarial
			.filter((row) => row.language === language && !row.valid)
			.map((row) => row.id);
		const heuristic = score(real, "heuristic", (row) => row.engines.heuristic, budget, adversarialInvalid);
		const wasm = isWasmCandidateLanguage(language)
			? score(real, "wasm", (row) => row.engines.wasm, budget, adversarialInvalid)
			: undefined;
		const winner = heuristic?.engine === "heuristic" ? heuristic : wasm?.engine === "wasm" ? wasm : undefined;
		const decided = winner ?? heuristic ?? wasm;
		const reason = winner
			? winner.reason
			: wasm
				? wasm.reason === "invalid_boundaries"
					? "wasm_candidate_invalid_boundaries"
					: "wasm_candidate_below_threshold"
				: isWasmCandidateLanguage(language)
					? "wasm_grammar_unavailable"
					: UNEVALUATED_REASON;
		const status = winner ? "conclusive" : wasm ? "conclusive" : "pending_owner";
		const candidates = {
			heuristic: heuristic ?? { engine: "raw", status: "inconclusive", reason: "measurement_unavailable" },
			wasm: wasm ?? {
				engine: "raw",
				status: "pending_owner",
				reason: isWasmCandidateLanguage(language) ? "wasm_grammar_unavailable" : UNEVALUATED_REASON,
			},
		};
		if (language === "go")
			return {
				language,
				engine: "raw",
				status: "pending_owner",
				reason: "measurement_blocked_insufficient_corpus (2 tracked Go files, both <100 lines)",
				owner_action: "additional source corpus under OQ1",
				measured_files: 0,
				candidates,
			};
		return {
			language,
			engine: winner ? winner.engine : "raw",
			status,
			reason,
			medianSaving: decided?.medianSaving,
			referenceMedianSaving: decided?.referenceMedianSaving,
			candidates,
			measured_files: real.length,
			default_read_median_saving: real
				.map((row) => (row.rawTokens - row.defaultReadTokens) / row.rawTokens)
				.sort((a, b) => a - b)[2],
			default_read_saved_tokens: real.reduce((sum, row) => sum + row.rawTokens - row.defaultReadTokens, 0),
			files_with_folds: (winner ?? heuristic)?.files_with_folds ?? 0,
			discovered_folds: (winner ?? heuristic)?.discovered_folds ?? 0,
			file_outcomes: (winner ?? heuristic)?.file_outcomes ?? [],
			invalid_boundaries: [
				...new Set([...(heuristic?.invalid_boundaries ?? []), ...(wasm?.invalid_boundaries ?? [])]),
			],
			heuristic_rejection: heuristic?.reason ?? "measurement_unavailable",
			total_saved_tokens: (winner ?? heuristic)?.total_saved_tokens ?? 0,
		};
	});
}
