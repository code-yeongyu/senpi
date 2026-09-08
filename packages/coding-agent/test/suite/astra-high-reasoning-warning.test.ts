import { describe, expect, it } from "vitest";
import { shouldWarnHighReasoning } from "../../src/core/high-reasoning-warning.ts";

const ASTRA_MODEL_IDS = [
	"gpt-6-astra",
	"gpt-6-astra-fast",
	"gpt-6-astra-pro",
	"openai/gpt-6-astra",
	"openai.gpt-6-astra",
	"openrouter/openai/gpt-6-astra-fast",
	"GPT-6-ASTRA",
] as const;

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

describe.each(ASTRA_MODEL_IDS)("Astra warning parity for %s", (id) => {
	it.each(EFFORTS)("warns only above high when effort is %s", (effort) => {
		// Given an Astra model variant and a selected effort.
		const model = { id };
		// When the existing warning policy is evaluated.
		const warns = shouldWarnHighReasoning(model, effort);
		// Then Astra uses the same effort threshold as Sol.
		expect(warns).toBe(effort === "xhigh" || effort === "max");
	});
});

describe("Astra warning negative controls", () => {
	it.each(["gpt-6-astral", "gpt-6-astrafoo", "gpt-6", "gpt-6-luna", "gpt-5.6-astra", "upstage/solar-pro-3"])(
		"does not warn for unrelated model %s",
		(id) => {
			// Given a model outside the existing Sol and requested Astra families.
			const model = { id };
			// When either warning-level effort is selected, then no warning is requested.
			expect(shouldWarnHighReasoning(model, "xhigh")).toBe(false);
			expect(shouldWarnHighReasoning(model, "max")).toBe(false);
		},
	);
});
