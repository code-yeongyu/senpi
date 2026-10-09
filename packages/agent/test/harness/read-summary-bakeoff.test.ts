import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadTool } from "../../../coding-agent/src/core/tools/read.ts";
import { heuristic } from "./fixtures/read-summary/heuristic.ts";
import { retainedSourceExact } from "./fixtures/read-summary/oracle.ts";
import { readRawBaseline } from "./fixtures/read-summary/raw-baseline.ts";
import { type Measurement, type Sample, selectEngine, sha256 } from "./fixtures/read-summary/scorer.ts";

function measurement(): Measurement {
	const source = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
	return {
		samples: Array.from({ length: 5 }, (_, i) => ({
			path: `repo/file-${i}.ts`,
			source,
			sha256: sha256(source),
			folds: [{ start: 3, end: 8 }],
			allowed: [{ start: 3, end: 8 }],
			rawTokens: 100,
			ompTokens: 50,
			candidateTokens: 54,
			retainedExact: true,
		})),
		referenceAvailable: true,
		tokenizerExact: true,
		embeddedBytes: 0,
		budget: 12582912,
	};
}
function changeSamples(change: (sample: Sample) => Sample): Measurement {
	const input = measurement();
	return { ...input, samples: input.samples.map(change) };
}

describe("read-summary bake-off gate (#1639)", () => {
	it("keeps the raw comparator verbatim when the public default read summarizes", async () => {
		// Given a foldable file and the actual integrated reader, not a replacement tool.
		const cwd = await mkdtemp(join(tmpdir(), "read-raw-baseline-"));
		const path = join(cwd, "input.json");
		const source = JSON.stringify(
			Array.from({ length: 20 }, () => Array.from({ length: 12 }, () => "raw comparator source bytes")),
			null,
			2,
		);
		try {
			await writeFile(path, source);
			const defaultRead = await createReadTool(cwd).execute("default-control", { path });
			expect(defaultRead.content).not.toEqual([{ type: "text", text: source }]);
			// When reading through the bake-off's raw arm; then the independent source is unchanged.
			expect(await readRawBaseline(cwd, path)).toBe(source);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
	it.each(["ts", "js", "rust", "python"])(
		"folds real lexical constructs rather than abandoning %s files",
		(language) => {
			const body =
				language === "rust"
					? [
							"fn example<'a>(value: &'a str) -> &'a str {",
							"  /* outer /* nested } */ comment */",
							"  let character = '}';",
							'  let raw = r##"{ raw }"##;',
							'  let escaped = "\\\\\\"}";',
							"  let ratio = 4 / 2;",
							"  let another = 3;",
							"  value",
							"}",
						]
					: language === "python"
						? [
								"def example(value):",
								'    """A docstring with { braces }.',
								'    Another line."""',
								'    text = f"value {value}"',
								"    ratio = 4 / 2",
								"    other = 3",
								"    value += other",
								"    return value",
								"",
							]
						: [
								"function example(value) {",
								"  /* a } comment */",
								"  const ratio = 4 / 2;",
								"  const regex = /[{}\\\\/]+/g;",
								`  const text = \`value \${(() => { return \`nested \${1}\`; })()}\`;`,
								'  const escaped = "\\\\\\"}";',
								"  const other = 3;",
								"  return value;",
								"}",
							];
			const source = Array.from({ length: 20 }, (_, i) => body.join("\n").replace("example", `example${i}`)).join(
				"\n",
			);
			const result = heuristic(source, language);
			expect(result.folds.length).toBeGreaterThan(0);
			expect(retainedSourceExact(source, result)).toBe(true);
			for (const fold of result.folds) {
				expect(fold.start % 9).toBe(2);
				expect(fold.end % 9).toBe(language === "python" ? 7 : 8);
			}
		},
	);
	it("falls back on a malformed Python file instead of exposing invalid folds", () => {
		const source = `${Array.from({ length: 20 }, (_, i) =>
			[`def f${i}():`, ...Array.from({ length: 6 }, () => "    x = 1")].join("\n"),
		).join("\n")}\n"unterminated`;
		const result = heuristic(source, "python");
		expect(result.folds).toEqual([]);
		expect(result.text).toBe(source);
		expect(result.reason).toBe("python_unterminated_string");
		expect(result.fallback_reason).toBe("python_unterminated_string");
	});
	it("prototype retains exact bytes and is deterministic on strings containing braces", () => {
		const source = Array.from({ length: 20 }, (_, i) =>
			[`function f${i}() {`, ...Array.from({ length: 6 }, () => '  let x = "} {";'), "}"].join("\n"),
		).join("\n");
		const result = heuristic(source, "js");
		expect(result.folds.length).toBeGreaterThan(0);
		expect(retainedSourceExact(source, result)).toBe(true);
		expect(heuristic(source, "js")).toEqual(result);
	});
	it("real reader isolates repeated interrupts from a fresh invocation and rereads edited bytes", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "read-bakeoff-"));
		const path = join(cwd, "source.ts");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const controller = new AbortController();
		try {
			await writeFile(path, "before");
			const reader = createReadTool(cwd, {
				operations: {
					access: async () => {},
					readFile: async (file) => {
						started.resolve();
						await release.promise;
						const bytes = await readFile(file);
						completed.resolve();
						return bytes;
					},
				},
			});
			const pending = reader.execute("interrupted", { path }, controller.signal);
			const failure = expect(pending).rejects.toBeInstanceOf(Error);
			await started.promise;
			controller.abort();
			controller.abort();
			release.resolve();
			await failure;
			await completed.promise;
			await writeFile(path, "after");
			const result = await createReadTool(cwd).execute("fresh", { path });
			expect(result.content).toEqual([{ type: "text", text: "after" }]);
		} finally {
			release.resolve();
			await rm(cwd, { recursive: true, force: true });
		}
	});
	it("selects safe savings meeting ninety percent of reference", () => {
		const input = measurement();
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "heuristic", status: "conclusive" });
	});
	it.each([
		["reference_unavailable", { referenceAvailable: false }],
		["exact_tokenizer_required", { tokenizerExact: false }],
		["embedded_budget_exceeded", { embeddedBytes: 12582913 }],
	] as const)("refuses adoption when %s", (reason, patch) => {
		const input = { ...measurement(), ...patch };
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason });
	});
	it("keeps a short corpus pending owner without claiming a measured winner", () => {
		const input = { ...measurement(), samples: measurement().samples.slice(0, 4) };
		const result = selectEngine(input);
		expect(result).toMatchObject({
			engine: "raw",
			status: "pending_owner",
			reason: "measurement_blocked_insufficient_corpus",
		});
	});
	it("rejects stale corpus bytes", () => {
		const input = changeSamples((sample) => ({ ...sample, source: `${sample.source}\nchanged` }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "stale_corpus_hash" });
	});
	it("rejects duplicate corpus paths", () => {
		const input = changeSamples((sample) => ({ ...sample, path: "same.ts" }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "duplicate_corpus_path" });
	});
	it.each([
		[{ start: 0, end: 8 }],
		[{ start: 3, end: 121 }],
		[{ start: 3, end: 7 }],
		[{ start: 8, end: 3 }],
		[
			{ start: 3, end: 8 },
			{ start: 3, end: 8 },
		],
	])("rejects bad or unannotated coordinates %j", (...folds) => {
		const input = changeSamples((sample) => ({ ...sample, folds }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "invalid_boundaries" });
	});
	it("rejects altered retained source text", () => {
		const input = changeSamples((sample) => ({ ...sample, retainedExact: false }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "invalid_boundaries" });
	});
	it("rejects nonfinite token figures rather than misleading success", () => {
		const input = changeSamples((sample) => ({ ...sample, ompTokens: Number.NaN }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "invalid_token_counts" });
	});
	it("records a measured shortfall as a decided raw outcome (#1685)", () => {
		const input = changeSamples((sample) => ({ ...sample, candidateTokens: 56 }));
		const result = selectEngine(input);
		expect(result).toMatchObject({
			engine: "raw",
			status: "conclusive",
			reason: "candidate_below_reference_threshold",
		});
	});

	it("names the grammar engine when the grammar candidate wins (#1685)", () => {
		const result = selectEngine({ ...measurement(), engine: "wasm" });
		expect(result).toMatchObject({ engine: "wasm", status: "conclusive", reason: "safe_quality_threshold_met" });
		expect(selectEngine({ ...changeSamples((s) => ({ ...s, candidateTokens: 56 })), engine: "wasm" })).toMatchObject({
			engine: "raw",
			reason: "candidate_below_reference_threshold",
		});
	});
	it("accepts safe positive savings when reference has zero savings", () => {
		const input = changeSamples((sample) => ({ ...sample, ompTokens: 100, candidateTokens: 99 }));
		const result = selectEngine(input);
		expect(result.engine).toBe("heuristic");
	});
	it("does not adopt a candidate with no positive total saving", () => {
		const input = changeSamples((sample) => ({ ...sample, candidateTokens: 100 }));
		const result = selectEngine(input);
		expect(result).toMatchObject({ engine: "raw", reason: "candidate_below_reference_threshold" });
	});
});
