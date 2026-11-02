import { describe, expect, it } from "vitest";
import { enumerateBoundaries } from "./fixtures/read-summary/adversarial-enumeration.ts";

describe("deterministic adversarial read grammar (#1639)", () => {
	it("qualifies every generated program against independent protected intervals and exact boundaries", () => {
		// Given fixed contexts, value expressions and enclosing bodies, including the review counterexamples.
		// When every hierarchical candidate range is checked against the compiler AST.
		const receipt = enumerateBoundaries();
		// Then both overlap and boundary safety hold, with non-vacuous value folds and protected programs.
		expect(receipt.programs).toBe(1440);
		expect(receipt.emittedRanges).toBe(244);
		expect(receipt.protectedPrograms).toBe(1432);
		expect(receipt.counterexamples).toEqual([]);
	});
});
