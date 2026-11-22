/**
 * A combiner's boolean branches in object form, with the same meaning: `true` accepts anything, which is the empty
 * schema (it adds no properties and makes no name required); `false` matches nothing, so a union drops it. An `allOf`
 * keeps `false`, since nothing can satisfy it and no object root can say so.
 */
export function objectFormBranches(branches: readonly unknown[], combiner: "anyOf" | "oneOf" | "allOf"): unknown[] {
	const kept: unknown[] = [];
	for (const branch of branches) {
		if (branch === true) kept.push({});
		else if (branch !== false || combiner === "allOf") kept.push(branch);
	}
	return kept;
}
