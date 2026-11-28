/**
 * Whether a branch can never match a tool's input. Tool input is always a JSON object, so a branch whose `type`
 * admits no object (a scalar, null or array type, or a type list without "object") is provably impossible.
 */
function rejectsEveryObject(branch: unknown): boolean {
	if (branch === false) return true;
	if (typeof branch !== "object" || branch === null || !("type" in branch)) return false;
	const { type } = branch;
	if (typeof type === "string") return type !== "object";
	return Array.isArray(type) && type.length > 0 && !type.includes("object");
}

/**
 * The branches of a root combiner, rewritten for an object root with the same meaning: `true` accepts anything, which
 * is the empty schema (no properties, nothing required); a union drops a branch that can never match an object, since
 * it adds no accepted input. An `allOf` keeps such a branch, because nothing can satisfy it and no object root can say
 * so. Every satisfiable branch is kept unchanged.
 */
export function rootCombinerBranches(branches: readonly unknown[], combiner: "anyOf" | "oneOf" | "allOf"): unknown[] {
	const kept: unknown[] = [];
	for (const branch of branches) {
		if (branch === true) kept.push({});
		else if (combiner === "allOf" || !rejectsEveryObject(branch)) kept.push(branch);
	}
	return kept;
}
