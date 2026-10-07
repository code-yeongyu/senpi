import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { languages } from "./corpus.ts";
import { referenceSchema } from "./reference.ts";
import { sha256 } from "./scorer.ts";

const annotationSchema = z.object({
	id: z.string(),
	source_sha256: z.string(),
	ranges: z.array(
		z.object({
			start: z.number(),
			end: z.number(),
			kind: z.string(),
			startByte: z.number(),
			endByte: z.number(),
			header: z.string(),
			tail: z.string(),
		}),
	),
	reference_annotation_errors: z.array(z.string()),
});

// Authenticate original ReadTool captures and historical annotations. The caller
// recomputes the corrected TS/JS/JSON oracle; historical ranges are not its authority.
export function loadFrozenBaseline(root: string) {
	const selection = z
		.object({
			corpus_sha256: z.string(),
			annotations_sha256: z.string(),
			output_bindings_sha256: z.string(),
			settings: z.record(z.string(), z.unknown()),
			tokenizer: referenceSchema.shape.tokenizer,
			reference_reader_sha256: z.string(),
		})
		.parse(JSON.parse(readFileSync(join(root, "selection.json"), "utf8")));
	if (
		selection.corpus_sha256 !== "7341450565d0c56ac07ef676eb6e43a79cab7a012fefe73612a7e2cab1ba43fa" ||
		selection.annotations_sha256 !== "2b779490c747ecb23cd927646a9c312447026d77e7433dcb92a39c25ab0fb333"
	)
		throw new Error("frozen_baseline_identity_drift");
	if (
		sha256(readFileSync(join(root, "corpus.json"))) !== selection.corpus_sha256 ||
		sha256(readFileSync(join(root, "output-bindings.json"))) !== selection.output_bindings_sha256
	)
		throw new Error("frozen_baseline_hash_drift");
	const annotations = z
		.object({ annotations: z.array(annotationSchema) })
		.parse(JSON.parse(readFileSync(join(root, "source-annotations.json"), "utf8"))).annotations;
	if (sha256(JSON.stringify(annotations)) !== selection.annotations_sha256) throw new Error("frozen_oracle_drift");
	const bindings = z
		.array(z.object({ id: z.string(), source_sha256: z.string(), raw_sha256: z.string(), omp_sha256: z.string() }))
		.parse(JSON.parse(readFileSync(join(root, "output-bindings.json"), "utf8")));
	const csv = readFileSync(join(root, "per-file.csv"), "utf8")
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => line.split(","));
	const raw = new Map<string, string>();
	const results = bindings.map((binding) => {
		const text = readFileSync(join(root, "omp", `${binding.id}.txt`), "utf8");
		const rawText = readFileSync(join(root, "raw", `${binding.id}.txt`), "utf8");
		if (sha256(text) !== binding.omp_sha256 || sha256(rawText) !== binding.raw_sha256)
			throw new Error("frozen_output_drift");
		raw.set(binding.id, rawText);
		return {
			id: binding.id,
			sourceSha256: binding.source_sha256,
			text,
			result: JSON.parse(readFileSync(join(root, "omp", `${binding.id}.json`), "utf8")),
			latencyMs: Number(csv.find((row) => row[0] === binding.id)?.[11]),
			nodes: [],
			annotationErrors: annotations.find((row) => row.id === binding.id)?.reference_annotation_errors ?? [],
		};
	});
	return {
		raw,
		annotations,
		corpusSha256: selection.corpus_sha256,
		reference: {
			...referenceSchema.parse({ settings: selection.settings, tokenizer: selection.tokenizer, results }),
			command: ["frozen actual ReadTool capture", join(root, "selection.json")],
			readToolSha256: selection.reference_reader_sha256,
		},
	};
}

export function loadReadGate(path: string) {
	const bytes = readFileSync(path);
	const receipt = z
		.object({
			gate: z.literal("OQ1"),
			approved: z.literal(true),
			owner: z.string().min(1),
			source_message: z.string().min(1),
			approved_at: z.string(),
			decision: z
				.object({
					languages: z.array(z.string()),
					// #1685 answered the WASM question; the receipt records the owner's actual answer.
					wasm_allowed: z.boolean(),
					candidate_dependencies: z.array(z.string()),
					max_embedded_delta_bytes: z.literal(12582912),
				})
				.passthrough(),
		})
		.parse(JSON.parse(bytes.toString("utf8")));
	if (JSON.stringify(receipt.decision.languages) !== JSON.stringify(languages))
		throw new Error("read_gate_language_drift");
	// An approved grammar engine must name the dependencies it ships; a refusal must name none.
	const declaresDependencies = receipt.decision.candidate_dependencies.length > 0;
	if (receipt.decision.wasm_allowed !== declaresDependencies) throw new Error("read_gate_dependency_drift");
	return { ...receipt, sha256: sha256(bytes) };
}
