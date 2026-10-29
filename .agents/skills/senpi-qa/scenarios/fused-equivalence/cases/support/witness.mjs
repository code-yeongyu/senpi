// Pipeline witness reader (plan §6.3). The witness is never part of the EQ equality: it is a separate receipt field,
// `witness.pipeline`, asserted on its own.
//
// Contract for the seam that will write it: one session entry `{ type: "custom", customType: "execution-pipeline",
// data: { pipeline: "legacy" | "prepared", toolCallId } }` per dispatched tool call. Before that seam exists no entry is
// written, and every call runs the legacy agent loop, so the reader reports `legacy` with `source: "no-seam"`.
import { existsSync, readFileSync } from "node:fs";
import { readJsonl } from "../../../../scripts/lib/common.mjs";

export const WITNESS_CUSTOM_TYPE = "execution-pipeline";

/** @returns {{ pipeline: string, source: "entries" | "no-seam", calls: Array<{ toolCallId: string, pipeline: string }> }} */
export function readWitness(sessionFile) {
	const entries = sessionFile && existsSync(sessionFile) ? readJsonl(readFileSync(sessionFile, "utf8")) : [];
	const calls = entries
		.filter((entry) => entry.type === "custom" && entry.customType === WITNESS_CUSTOM_TYPE)
		.map((entry) => ({ toolCallId: entry.data?.toolCallId, pipeline: entry.data?.pipeline }));
	if (calls.length === 0) return { pipeline: "legacy", source: "no-seam", calls };
	const kinds = new Set(calls.map((call) => call.pipeline));
	return { pipeline: kinds.size === 1 ? [...kinds][0] : "mixed", source: "entries", calls };
}

/** The pipeline a `--pipeline` request must be witnessed as: `default` is legacy until the default flips (S21a). */
export function expectedWitness(requested) {
	if (requested === "legacy" || requested === "default") return "legacy";
	if (requested === "prepared") return "prepared";
	throw new Error(`--pipeline must be legacy, prepared or default, got ${JSON.stringify(requested)}`);
}
