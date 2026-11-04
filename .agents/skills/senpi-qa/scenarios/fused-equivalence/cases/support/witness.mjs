// Pipeline witness reader (plan §6.3). The witness is never part of the EQ equality: it is a separate receipt field,
// `witness.pipeline`, asserted on its own.
//
// The witness comes from the session's explicit sink (S18b part 3), never from its entries: the runner points
// `SENPI_EXECUTION_PIPELINE_WITNESS` at a per-run file, and the session appends one JSON line `{ pipeline, toolCallId }` per
// call entering the selected pipeline. A run that wrote no line reports `legacy` with `source: "no-seam"`.
// `withoutWitnessEntries` still drops `execution-pipeline` entries a session file recorded before part 3.
import { existsSync, readFileSync } from "node:fs";
import { readJsonl } from "../../../../scripts/lib/common.mjs";

export const WITNESS_CUSTOM_TYPE = "execution-pipeline";

/** Receipt entries do not change behavioral history, including its parent links. */
export function withoutWitnessEntries(entries) {
	const parents = new Map(
		entries
			.filter((entry) => entry.type === "custom" && entry.customType === WITNESS_CUSTOM_TYPE)
			.map((entry) => [entry.id, entry.parentId]),
	);
	return entries
		.filter((entry) => !(entry.type === "custom" && entry.customType === WITNESS_CUSTOM_TYPE))
		.map((entry) => {
			let parentId = entry.parentId;
			while (parents.has(parentId)) parentId = parents.get(parentId);
			return parentId === entry.parentId ? entry : { ...entry, parentId };
		});
}

/** @returns {{ pipeline: string, source: "sink" | "no-seam", calls: Array<{ toolCallId: string, pipeline: string }> }} */
export function readWitness(witnessFile) {
	const lines = witnessFile && existsSync(witnessFile) ? readJsonl(readFileSync(witnessFile, "utf8")) : [];
	const calls = lines.map((line) => ({ toolCallId: line.toolCallId, pipeline: line.pipeline }));
	if (calls.length === 0) return { pipeline: "legacy", source: "no-seam", calls };
	const kinds = new Set(calls.map((call) => call.pipeline));
	return { pipeline: kinds.size === 1 ? [...kinds][0] : "mixed", source: "sink", calls };
}

/** The tool results a run's session recorded: a run with any must have its witness from the sink. */
export function toolCallCount(sessionFile) {
	const entries = sessionFile && existsSync(sessionFile) ? readJsonl(readFileSync(sessionFile, "utf8")) : [];
	return entries.filter((entry) => entry.type === "message" && entry.message?.role === "toolResult").length;
}

/** A run's witness is right when it names the requested pipeline and, if the run made tool calls, came from the sink. */
export function witnessMatches(witness, requested) {
	if (witness.pipeline !== expectedWitness(requested)) return false;
	return witness.toolCalls === 0 || witness.source === "sink";
}

/** The pipeline a `--pipeline` request must be witnessed as: `default` is legacy until the default flips (S21a). */
export function expectedWitness(requested) {
	if (requested === "legacy" || requested === "default") return "legacy";
	if (requested === "prepared") return "prepared";
	throw new Error(`--pipeline must be legacy, prepared or default, got ${JSON.stringify(requested)}`);
}
