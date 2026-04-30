import { describe, expect, it } from "vitest";
import { CODEX_APPLY_PATCH_DESCRIPTION } from "../../src/core/extensions/builtin/gpt-apply-patch.js";

describe("gpt apply_patch codex JSON description", () => {
	it("contains codex context rules and grammar markers", () => {
		// given
		const description = CODEX_APPLY_PATCH_DESCRIPTION;

		// when
		const requiredPhrases = [
			"NEVER ABSOLUTE",
			"Patch :=",
			"Begin :=",
			"End :=",
			"3 lines of code immediately above and 3 lines immediately below",
		];

		// then
		for (const phrase of requiredPhrases) {
			expect(description).toContain(phrase);
		}
	});
});
