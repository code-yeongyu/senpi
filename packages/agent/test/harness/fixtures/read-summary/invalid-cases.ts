import { type Measurement, type Sample, selectEngine, sha256 } from "./scorer.ts";

export function invalidCases() {
	const source = Array.from({ length: 120 }, (_, i) => `source ${i}`).join("\n");
	const baseline: Measurement = {
		samples: Array.from({ length: 5 }, (_, i) => ({
			path: `file-${i}.ts`,
			source,
			sha256: sha256(source),
			folds: [{ start: 2, end: 8 }],
			allowed: [{ start: 2, end: 8 }],
			retainedExact: true,
			rawTokens: 100,
			ompTokens: 50,
			candidateTokens: 50,
		})),
		referenceAvailable: true,
		tokenizerExact: true,
		embeddedBytes: 0,
		budget: 12582912,
	};
	const change = (patch: Partial<Sample>): Measurement => ({
		...baseline,
		samples: baseline.samples.map((sample) => ({ ...sample, ...patch })),
	});
	const cases: { name: string; expected: string; input: Measurement }[] = [
		{ name: "stale_hash", expected: "stale_corpus_hash", input: change({ source: `${source}\nchanged` }) },
		{ name: "bad_coordinate", expected: "invalid_boundaries", input: change({ folds: [{ start: 0, end: 8 }] }) },
		{ name: "altered_source", expected: "invalid_boundaries", input: change({ retainedExact: false }) },
		{
			name: "absent_reference",
			expected: "reference_unavailable",
			input: { ...baseline, referenceAvailable: false },
		},
		{ name: "absent_tokenizer", expected: "exact_tokenizer_required", input: { ...baseline, tokenizerExact: false } },
		{ name: "duplicate_path", expected: "duplicate_corpus_path", input: change({ path: "same.ts" }) },
		{ name: "oversized_set", expected: "embedded_budget_exceeded", input: { ...baseline, embeddedBytes: 12582913 } },
		{
			name: "insufficient_corpus",
			expected: "measurement_blocked_insufficient_corpus",
			input: { ...baseline, samples: baseline.samples.slice(0, 4) },
		},
		{ name: "misleading_success", expected: "invalid_token_counts", input: change({ candidateTokens: Number.NaN }) },
	];
	const results = cases.map((item) => {
		const result = selectEngine(item.input);
		return {
			name: item.name,
			expected: item.expected,
			result,
			pass: result.engine === "raw" && result.reason === item.expected,
		};
	});
	return {
		pass: selectEngine(baseline).engine === "heuristic" && results.every((result) => result.pass),
		positiveControl: selectEngine(baseline),
		cases: results,
	};
}
