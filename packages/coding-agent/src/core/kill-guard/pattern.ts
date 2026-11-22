import { readPattern } from "./ere.ts";

export type PatternMode = "exact" | "substring";

export type PatternVerdict = { readonly broad: false } | { readonly broad: true; readonly why: string };

/** R1 on one pattern: our own ERE reader, independent of the host engine (amendment A2's literal-count rule). */
export function judgePattern(pattern: string, mode: PatternMode): PatternVerdict {
	const reading = readPattern(pattern);
	if (reading.kind === "unparsable")
		return { broad: true, why: `cannot be read as a regular expression (${reading.why})` };
	if (reading.emptyBranch) return { broad: true, why: "has an empty alternative, which matches every process" };
	if (reading.nullable) return { broad: true, why: "can match the empty string, so it matches every process" };
	const needed = mode === "exact" ? 1 : 2;
	if (reading.minLiterals >= needed) return { broad: false };
	const plural = reading.minLiterals === 1 ? "" : "s";
	return {
		broad: true,
		why: `has a match with ${reading.minLiterals} literal character${plural}, so it matches nearly every process`,
	};
}
