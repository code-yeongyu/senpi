// Pipeline witness reader (plan §6.3). The witness is never part of the EQ equality: it is a separate receipt field,
// `witness.pipeline`, asserted on its own.
//
// The witness comes from the session's explicit sink (S18b part 3), never from its entries: the runner points
// `SENPI_EXECUTION_PIPELINE_WITNESS` at a per-run file, and the session appends one JSON line `{ pipeline, toolCallId }` per
// call entering the pipeline. Since S36 the loop has one pipeline, so every line must say `prepared`. A run whose sessions
// made tool calls but wrote no line is `missing` (a failure, never a pipeline); a run that made no tool call is `no-calls`.
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

/**
 * @param {string | undefined} witnessFile the run's sink file
 * @param {readonly (string | undefined)[]} sessionFiles the run's session files, to tell `missing` from `no-calls`
 * @returns {{ pipeline: string, source: "sink" | "none", calls: Array<{ toolCallId: string, pipeline: string }> }}
 */
export function readWitness(witnessFile, sessionFiles = []) {
	const lines = witnessFile && existsSync(witnessFile) ? readJsonl(readFileSync(witnessFile, "utf8")) : [];
	const calls = lines.map((line) => ({ toolCallId: line.toolCallId, pipeline: line.pipeline }));
	if (calls.length === 0) return { pipeline: sessionFiles.some(madeToolCalls) ? "missing" : "no-calls", source: "none", calls };
	const kinds = new Set(calls.map((call) => call.pipeline));
	return { pipeline: kinds.size === 1 ? [...kinds][0] : "mixed", source: "sink", calls };
}

/** Every EQ run must show this witness: each call on the prepared pipeline, or no tool call at all. */
export function witnessOk(witness) {
	return witness.pipeline === "prepared" || witness.pipeline === "no-calls";
}

function madeToolCalls(sessionFile) {
	if (!sessionFile || !existsSync(sessionFile)) return false;
	return readJsonl(readFileSync(sessionFile, "utf8")).some(
		(entry) =>
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			Array.isArray(entry.message.content) &&
			entry.message.content.some((part) => part?.type === "toolCall"),
	);
}
