import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { READ_FOLDER_SELECTION, selectedReadFolder } from "../../../../src/harness/utils/read-folders/index.ts";
import {
	TREE_SITTER_FOLDER_ID,
	TREE_SITTER_FOLDER_VERSION,
} from "../../../../src/harness/utils/read-folders/tree-sitter/engine.ts";
import type { BakeoffOptions } from "./bakeoff-types.ts";
import { boundaryFixtures } from "./boundary-fixtures.ts";
import { candidateSourceHashes } from "./candidate-source-hashes.ts";
import { loadCorpus } from "./corpus.ts";
import { loadFrozenBaseline, loadReadGate } from "./frozen-baseline.ts";
import { selectLanguages } from "./language-selections.ts";
import { annotate, compareOmp, retainedSourceExact } from "./oracle.ts";
import { typescriptOracle } from "./oracle-typescript.ts";
import { heuristicCandidate, productionCandidate } from "./production-candidate.ts";
import { qualifyEnumeration, qualifySignatures } from "./qualification.ts";
import { readRawBaseline } from "./raw-baseline.ts";
import { runReference, tokenize } from "./reference.ts";
import { sha256, validBoundaries } from "./scorer.ts";
import { treeSitterAssets } from "./tree-sitter-assets.ts";
import { wasmCandidate } from "./wasm-candidate.ts";

export async function bakeoff(options: BakeoffOptions) {
	const startedAt = new Date().toISOString();
	const out = dirname(options.out);
	const { corpus, entries, manifestSha256 } = loadCorpus(options.input, options.manifestHash);
	for (const dir of ["raw", "omp", "candidate", "wasm-candidate", "default-read", "synthetic"])
		mkdirSync(join(out, dir), { recursive: true });
	const json = (name: string, value: unknown) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 2)}\n`);
	const synthetic = boundaryFixtures().map((fixture) => {
		const ext =
			fixture.language === "python"
				? "py"
				: fixture.language === "rust"
					? "rs"
					: fixture.language === "markdown"
						? "md"
						: fixture.language;
		const file = join(out, "synthetic", `${fixture.id}.${ext}`);
		writeFileSync(file, fixture.source);
		return { ...fixture, file, sha256: sha256(fixture.source), path: fixture.id };
	});
	const all = [...entries, ...synthetic];
	const frozen = options.baseline ? loadFrozenBaseline(options.baseline) : undefined;
	const gateReceipt = options.gate ? loadReadGate(options.gate) : undefined;
	const reference = frozen?.reference ?? runReference(options.omp, all);
	json("reference-command.json", {
		command: reference.command,
		readToolSha256: reference.readToolSha256,
		settings: reference.settings,
	});
	// Freeze source-derived annotations before executing or scoring any candidate.
	const annotations = all.map((entry) => {
		const ref = reference.results.find((result) => result.id === entry.id);
		if (!ref) throw new Error("reference_unavailable");
		if (ref.sourceSha256 !== entry.sha256) throw new Error("reference_source_hash_mismatch");
		return {
			id: entry.id,
			source_sha256: entry.sha256,
			ranges:
				frozen && entry.language === "rust"
					? (frozen.annotations.find((item) => item.id === entry.id)?.ranges ?? [])
					: annotate(entry.source, entry.language, ref.nodes),
			protected: ["ts", "tsx", "js"].includes(entry.language)
				? typescriptOracle(entry.source, entry.language).protected
				: [],
			reference_annotation_errors: ref.annotationErrors,
		};
	});
	const annotationsHash = sha256(JSON.stringify(annotations));
	json("source-annotations.json", { sha256: annotationsHash, annotations });
	const rows = [];
	for (const entry of all) {
		const ref = reference.results.find((result) => result.id === entry.id);
		const annotation = annotations.find((item) => item.id === entry.id);
		if (!ref || !annotation) throw new Error("missing_reference_or_annotation");
		if (annotation.source_sha256 !== entry.sha256 || ref.sourceSha256 !== entry.sha256)
			throw new Error("frozen_source_mismatch");
		if (sha256(readFileSync(entry.file)) !== entry.sha256) throw new Error("stale_corpus_hash");
		const rawStart = performance.now();
		const raw = await readRawBaseline(options.input, entry.file);
		const rawMs = performance.now() - rawStart;
		if (frozen && frozen.raw.get(entry.id) !== raw) throw new Error("frozen_raw_output_changed");
		const defaultRead = await productionCandidate(options.input, entry.file, entry.source);
		const candidateStart = performance.now();
		const candidate = heuristicCandidate(entry.file, entry.source);
		const candidateMs = performance.now() - candidateStart;
		const wasmStart = performance.now();
		const wasm = await wasmCandidate(entry.file, entry.source, entry.language);
		const wasmMs = performance.now() - wasmStart;
		const exact = retainedSourceExact(entry.source, candidate);
		const boundaryInput = {
			source: entry.source,
			allowed: annotation.ranges,
			protected: annotation.protected,
			retainedExact: exact,
		};
		const valid =
			validBoundaries({ ...boundaryInput, folds: candidate.folds }) &&
			candidate.discoveredFolds.every((fold) => validBoundaries({ ...boundaryInput, folds: [fold] }));
		const wasmExact = wasm ? retainedSourceExact(entry.source, wasm) : false;
		const wasmBoundaryInput = { ...boundaryInput, retainedExact: wasmExact };
		const wasmValid = wasm
			? validBoundaries({ ...wasmBoundaryInput, folds: wasm.folds }) &&
				wasm.discoveredFolds.every((fold) => validBoundaries({ ...wasmBoundaryInput, folds: [fold] }))
			: false;
		writeFileSync(join(out, "raw", `${entry.id}.txt`), raw);
		writeFileSync(join(out, "omp", `${entry.id}.txt`), ref.text);
		writeFileSync(join(out, "candidate", `${entry.id}.txt`), candidate.text);
		if (wasm) writeFileSync(join(out, "wasm-candidate", `${entry.id}.txt`), wasm.text);
		writeFileSync(join(out, "default-read", `${entry.id}.txt`), defaultRead.defaultReadText);
		json(`omp/${entry.id}.json`, ref.result);
		const oracleHidden = new Set(
			annotation.ranges
				.filter((range) => range.end - range.start + 1 >= 4)
				.flatMap((range) => Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i)),
		);
		rows.push({
			minimumOracleSkeleton: entry.source.split("\n").length - oracleHidden.size,
			entry,
			raw,
			candidate,
			defaultRead,
			omp: ref.text,
			rawMs,
			candidateMs,
			ompMs: ref.latencyMs,
			valid,
			exact,
			wasm,
			wasmValid,
			wasmExact,
			wasmMs,
			allowed: annotation.ranges,
			protected: annotation.protected,
			referenceComparison: compareOmp(entry.source, ref.text, annotation.ranges),
		});
	}
	json(
		"output-bindings.json",
		rows.map((row) => ({
			id: row.entry.id,
			source_sha256: row.entry.sha256,
			raw_sha256: sha256(row.raw),
			omp_sha256: sha256(row.omp),
			candidate_sha256: sha256(row.candidate.text),
			wasm_candidate_sha256: row.wasm ? sha256(row.wasm.text) : null,
			default_read_sha256: sha256(row.defaultRead.defaultReadText),
			default_read_engine: row.defaultRead.engineId,
		})),
	);
	const tokens = tokenize(
		options.omp,
		rows.flatMap((row) => [
			row.raw,
			row.omp,
			row.candidate.text,
			row.defaultRead.defaultReadText,
			row.wasm?.text ?? row.raw,
		]),
		reference.tokenizer,
	);
	const samples = rows.map((row, index) => ({
		...row,
		rawTokens: tokens[index * 5],
		ompTokens: tokens[index * 5 + 1],
		candidateTokens: tokens[index * 5 + 2],
		defaultReadTokens: tokens[index * 5 + 3],
		wasmTokens: tokens[index * 5 + 4],
		engines: {
			heuristic: { candidate: row.candidate, tokens: tokens[index * 5 + 2], valid: row.valid, exact: row.exact },
			wasm: row.wasm
				? { candidate: row.wasm, tokens: tokens[index * 5 + 4], valid: row.wasmValid, exact: row.wasmExact }
				: undefined,
		},
	}));
	json("boundaries.json", {
		annotations_sha256: annotationsHash,
		source_oracle:
			"TypeScript 6.0.2 AST; Python ast; Rust source AST matches plus byte verification, independent of summary rendering",
		limitations:
			"Rust source parser is shared with omp, not an independent parser. Unannotated omp sibling folds are recorded, never promoted to candidate truth.",
		files: samples.map((row) => ({
			id: row.entry.id,
			sha256: row.entry.sha256,
			synthetic: row.entry.id.startsWith("boundary-"),
			allowed: row.allowed,
			protected: row.protected,
			discovered: row.candidate.discoveredFolds,
			candidate: row.candidate.folds,
			wasm_discovered: row.wasm?.discoveredFolds ?? null,
			wasm_candidate: row.wasm?.folds ?? null,
			wasm_fallback_reason: row.wasm?.fallback_reason ?? null,
			wasm_valid: row.wasm ? row.wasmValid : null,
			fallback_reason: row.candidate.fallback_reason,
			scanned_folds: row.candidate.scanned_folds,
			minimum_oracle_skeleton_lines: row.minimumOracleSkeleton,
			retained_exact: row.exact,
			valid: row.valid,
			omp: row.referenceComparison,
		})),
	});
	const enumeration = await qualifyEnumeration(join(out, "adversarial-enumeration.json"));
	const adversarial = await qualifySignatures();
	json("adversarial-boundaries.json", adversarial);
	const selections = selectLanguages(samples, corpus.max_embedded_delta_bytes, adversarial);
	const csv = [
		"id,language,sha256,synthetic,source_bytes,raw_tokens,omp_tokens,candidate_tokens,saved_token_fraction,omp_saved_token_fraction,raw_ms,omp_ms,candidate_ms,valid_boundaries,candidate_reason,fallback_reason,scanned_folds,emitted_folds,minimum_oracle_skeleton_lines,default_read_tokens,wasm_tokens,wasm_saved_token_fraction,wasm_ms,wasm_valid_boundaries,wasm_reason,wasm_emitted_folds",
	];
	for (const row of samples)
		csv.push(
			[
				row.entry.id,
				row.entry.language,
				row.entry.sha256,
				row.entry.id.startsWith("boundary-"),
				Buffer.byteLength(row.entry.source),
				row.rawTokens,
				row.ompTokens,
				row.candidateTokens,
				(row.rawTokens - row.candidateTokens) / row.rawTokens,
				(row.rawTokens - row.ompTokens) / row.rawTokens,
				row.rawMs,
				row.ompMs,
				row.candidateMs,
				row.valid,
				row.candidate.reason,
				row.candidate.fallback_reason ?? "",
				row.candidate.scanned_folds,
				row.candidate.folds.length,
				row.minimumOracleSkeleton,
				row.defaultReadTokens,
				row.wasm ? row.wasmTokens : "",
				row.wasm ? (row.rawTokens - row.wasmTokens) / row.rawTokens : "",
				row.wasm ? row.wasmMs : "",
				row.wasm ? row.wasmValid : "",
				row.wasm?.reason ?? "",
				row.wasm ? row.wasm.folds.length : "",
			].join(","),
		);
	writeFileSync(join(out, "per-file.csv"), `${csv.join("\n")}\n`);
	json("corpus.json", { ...corpus, input_manifest_sha256: manifestSha256, tokenizer: reference.tokenizer });
	if (frozen && sha256(readFileSync(join(out, "corpus.json"))) !== frozen.corpusSha256)
		throw new Error("frozen_corpus_changed");
	const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const selection = {
		version: 2,
		candidate_implementation: "production_folder_segmented_view_and_default_read",
		default_read_selection: {
			wasm: READ_FOLDER_SELECTION.wasm,
			rawReasons: READ_FOLDER_SELECTION.rawReasons,
			languages: READ_FOLDER_SELECTION.languages,
			folder: { id: selectedReadFolder.id, version: selectedReadFolder.version },
		},
		candidate_sources_sha256: candidateSourceHashes(),
		enumeration,
		tree_sha: execFileSync("git", ["write-tree"], { encoding: "utf8" }).trim(),
		binary_measurement: "omp-item1 --case compiled-parity (release graph, all shipped targets)",
		gate_status: "OQ1_unresolved_defaults_used",
		gate_receipt: gateReceipt,
		reference_mode: frozen ? "frozen_actual_ReadTool_outputs" : "live_actual_ReadTool",
		reference_latency_scope: frozen ? "original baseline observation, not rerun latency" : "current run",
		wasm_enabled: READ_FOLDER_SELECTION.wasm,
		wasm_engine: { id: TREE_SITTER_FOLDER_ID, version: TREE_SITTER_FOLDER_VERSION, assets: treeSitterAssets() },
		status: "frozen_measurement_with_per_language_raw_fallbacks",
		head_sha: head,
		startedAt,
		finishedAt: new Date().toISOString(),
		corpus_sha256: sha256(readFileSync(join(out, "corpus.json"))),
		annotations_sha256: annotationsHash,
		adversarial_boundaries_sha256: sha256(readFileSync(join(out, "adversarial-boundaries.json"))),
		oracle_mode: "requalified_source_AST_with_protected_intervals",
		tokenizer: reference.tokenizer,
		max_embedded_delta_bytes: corpus.max_embedded_delta_bytes,
		grammar_pins: "grammar-pins.json",
		output_bindings_sha256: sha256(readFileSync(join(out, "output-bindings.json"))),
		raw_reader_sha256: sha256(
			readFileSync(new URL("../../../../../coding-agent/src/core/tools/read.ts", import.meta.url)),
		),
		reference_reader_sha256: reference.readToolSha256,
		settings: reference.settings,
		languages: selections,
		prose_control: samples
			.filter((row) => row.entry.language === "markdown")
			.map((row) => ({
				id: row.entry.id,
				rawTokens: row.rawTokens,
				ompTokens: row.ompTokens,
				candidateTokens: row.candidateTokens,
			})),
		caveat:
			"Per-language selections come from these numbers under the owner's #1685 WASM approval. Go raw is the lead-authorized per-language shortfall outcome. Python/Rust/Go have no protected-interval source oracle, so no grammar candidate is measured for them. Native/reference runtime is excluded from senpi distribution.",
	};
	writeFileSync(options.out, `${JSON.stringify(selection, null, 2)}\n`);
	return selection;
}
