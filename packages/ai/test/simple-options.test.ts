import { describe, expect, it } from "vitest";
import { clampMaxForOpenAI } from "../src/providers/simple-options.js";

describe("OpenAI reasoning effort clamping", () => {
	it("maps pi minimal to the lowest OpenAI-compatible effort", () => {
		expect(clampMaxForOpenAI("minimal", true)).toBe("low");
		expect(clampMaxForOpenAI("minimal", false)).toBe("low");
	});

	it("keeps xhigh support when clamping max", () => {
		expect(clampMaxForOpenAI("max", true)).toBe("xhigh");
		expect(clampMaxForOpenAI("max", false)).toBe("high");
	});
});
