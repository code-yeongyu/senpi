import { describe, expect, it } from "vitest";
import { buildLookAtUserMessage, LOOK_AT_SYSTEM_PROMPT } from "../../src/core/extensions/builtin/look-at/prompts.ts";

describe("look_at prompts", () => {
	it("requires evidence-based OCR and a body-only response", () => {
		expect(LOOK_AT_SYSTEM_PROMPT).toMatch(/transcribe.*visible.*text.*verbatim/is);
		expect(LOOK_AT_SYSTEM_PROMPT).toMatch(/never fabricate.*occluded.*blurry/is);
		expect(LOOK_AT_SYSTEM_PROMPT).toMatch(/only.*response body.*no.*preamble.*postscript/is);
	});

	it("puts the requested goal and every attached source label in the user message", () => {
		const message = buildLookAtUserMessage("Compare the warning states", ["before.png", "after.png"]);

		expect(message).toContain("Compare the warning states");
		expect(message).toContain("before.png");
		expect(message).toContain("after.png");
	});
});
