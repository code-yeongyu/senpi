import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "./scorer.ts";

export const pins = {
	senpi: { root: "/tmp/ulw-plan-20260912/senpi", sha: "6a072f5994ce1df5f7dff12337bec9470707bebf" },
	omo: { root: "/tmp/ulw-plan-20260912/omo", sha: "c6c22332f291422751c299fb3ecd7590033b0dc2" },
	omp: { root: "/Users/yeongyu/local-workspaces/oh-my-pi", sha: "f97fa5c95010b62ac34c7357f9a1cae6975e12d6" },
} as const;
export const languages = ["ts", "tsx", "js", "python", "go", "rust", "json", "markdown"] as const;
const relative = z.string().refine((path) => !path.startsWith("/") && !path.split("/").includes(".."));
const record = z.object({
	repo: z.enum(["senpi", "omo", "omp"]),
	repo_sha: z.string(),
	path: relative,
	language: z.enum(languages),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
	line_count: z.number().int(),
	source_bytes: z.number().int(),
	exclusion: z.string().nullable(),
});
const schema = z
	.object({
		version: z.literal(1),
		gate_status: z.literal("OQ1_unresolved_defaults_used"),
		wasm_allowed: z.literal(false),
		max_embedded_delta_bytes: z.literal(12582912),
		roots: z.record(z.string(), z.object({ root: z.string(), sha: z.string() })),
		entries: z.array(record.extend({ copy: relative, id: z.string().regex(/^[a-z]+-\d+$/) })),
		inventory: z.array(record),
	})
	.passthrough();

export function loadCorpus(input: string, expectedHash: string) {
	const bytes = readFileSync(join(input, "corpus.json"));
	if (sha256(bytes) !== expectedHash) throw new Error("stale_corpus_manifest");
	const corpus = schema.parse(JSON.parse(bytes.toString("utf8")));
	for (const [name, pin] of Object.entries(pins)) {
		if (corpus.roots[name]?.sha !== pin.sha || corpus.roots[name]?.root !== pin.root)
			throw new Error("reference_pin_drift");
	}
	const keys = corpus.inventory.map((row) => `${row.repo}/${row.path}`);
	if (new Set(keys).size !== keys.length) throw new Error("duplicate_corpus_path");
	const sorted = [...corpus.inventory].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0,
	);
	for (const language of languages) {
		const expected = sorted.filter((row) => row.language === language && row.exclusion === null).slice(0, 5);
		const actual = corpus.entries.filter((row) => row.language === language);
		if (
			JSON.stringify(expected.map((row) => `${row.repo}/${row.path}`)) !==
			JSON.stringify(actual.map((row) => `${row.repo}/${row.path}`))
		)
			throw new Error("nondeterministic_corpus_selection");
	}
	const entries = corpus.entries.map((row) => {
		const bytes = readFileSync(join(input, row.copy));
		const source = bytes.toString("utf8");
		const lineCount = source.split("\n").length - Number(source.endsWith("\n"));
		if (sha256(bytes) !== row.sha256 || sha256(source) !== row.sha256) throw new Error("stale_corpus_hash");
		if (
			row.repo_sha !== pins[row.repo].sha ||
			lineCount !== row.line_count ||
			bytes.length !== row.source_bytes ||
			lineCount < 100 ||
			lineCount > 2000 ||
			bytes.length > 51200
		)
			throw new Error("ineligible_corpus");
		return { ...row, source, file: join(input, row.copy) };
	});
	return { corpus, entries, manifestSha256: sha256(bytes) };
}
