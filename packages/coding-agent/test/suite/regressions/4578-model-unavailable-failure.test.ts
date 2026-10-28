import type { ProviderDiagnostic } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { describeProviderFailure, formatProviderFailure } from "../../../src/core/provider-failure.ts";

const BARE_404: ProviderDiagnostic = { category: "unknown", httpStatus: 404, evidence: "structured_status" };
const ANTHROPIC_NOT_FOUND: ProviderDiagnostic = {
	category: "unknown",
	httpStatus: 404,
	code: "not_found_error",
	evidence: "structured_code",
};

describe("a 404 for the requested model names it as unavailable (senpi#4578)", () => {
	it("turns the Codex backend's bodiless 404 into an actionable model_unavailable failure", () => {
		const failure = describeProviderFailure(BARE_404, "chatgpt-subscription", { model: "gpt-6.1-terra" });

		expect(failure).toMatchObject({
			category: "model_unavailable",
			provider: "chatgpt-subscription",
			model: "gpt-6.1-terra",
			httpStatus: 404,
			reason: "the model is not available for this account",
		});
		expect(formatProviderFailure(failure)).toBe(
			"gpt-6.1-terra on chatgpt-subscription failed: the model is not available for this account. Action: choose another model, or check that your plan or key includes this model.",
		);
	});

	it("reads a structured not-found code on 404 the same way", () => {
		expect(describeProviderFailure(ANTHROPIC_NOT_FOUND, "anthropic", { model: "claude-x" })).toMatchObject({
			category: "model_unavailable",
			code: "not_found_error",
		});
	});

	it.each([
		["a bare 429", { category: "unknown", httpStatus: 429, evidence: "structured_status" }],
		["a bare 403", { category: "unknown", httpStatus: 403, evidence: "structured_status" }],
		["no diagnostic", undefined],
	] as const)("keeps %s unknown", (_label, diagnostic) => {
		expect(describeProviderFailure(diagnostic, "chatgpt-subscription").category).toBe("unknown");
	});
});
