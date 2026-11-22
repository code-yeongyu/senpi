import { describe, expect, it } from "vitest";
import { isStepCommitError, StepCommitError } from "../src/index.ts";

describe("StepCommitError brand", () => {
	it("recognises an instance and a branded value from another copy of the package, never a look-alike", () => {
		const own = new StepCommitError("s", "generation", { cause: new Error("inner") });
		const otherCopy = Object.defineProperty(
			new Error("step commit failed: fenced"),
			Symbol.for("senpi.StepCommitError"),
			{
				value: true,
			},
		);
		const lookAlike = Object.assign(new Error("step commit failed: fenced"), { name: "StepCommitError" });
		expect(own.code).toBe("generation");
		expect(own.stepId).toBe("s");
		expect(isStepCommitError(own)).toBe(true);
		expect(isStepCommitError(otherCopy)).toBe(true);
		expect(isStepCommitError(lookAlike)).toBe(false);
		expect(isStepCommitError(new Error("x"))).toBe(false);
		expect(isStepCommitError("StepCommitError")).toBe(false);
		expect(isStepCommitError(null)).toBe(false);
	});
});
