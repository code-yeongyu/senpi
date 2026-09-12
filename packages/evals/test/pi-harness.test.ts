import { describe, expect, it } from "vitest";
import { excludePiDocumentation, resolveModelSelection } from "../src/pi-harness.ts";

describe("resolveModelSelection", () => {
	it("prefers an explicit harness model over environment defaults", () => {
		expect(
			resolveModelSelection(
				{ provider: "anthropic", id: "claude-opus-4-6" },
				{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
			),
		).toEqual({ provider: "anthropic", id: "claude-opus-4-6" });
	});

	it("uses trimmed environment defaults when the harness has no explicit model", () => {
		expect(resolveModelSelection(undefined, { PI_PROVIDER: " openai-codex ", PI_MODEL: " gpt-5.6-sol " })).toEqual({
			provider: "openai-codex",
			id: "gpt-5.6-sol",
		});
	});

	it.each([
		[undefined, {}],
		[undefined, { PI_PROVIDER: "openai-codex" }],
		[undefined, { PI_MODEL: "gpt-5.6-sol" }],
		[
			{ provider: "", id: "gpt-5.6-sol" },
			{ PI_PROVIDER: "openai-codex", PI_MODEL: "gpt-5.6-sol" },
		],
	] as const)("rejects an incomplete model selection", (explicitModel, environment) => {
		expect(() => resolveModelSelection(explicitModel, environment)).toThrow(
			"Select a harness model explicitly or set both PI_PROVIDER and PI_MODEL as defaults.",
		);
	});
});

describe("excludePiDocumentation", () => {
	it("removes the documentation block and keeps the working-directory section", () => {
		const prompt = [
			"You are Pi.",
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
			"# Docs",
			"Current working directory: /tmp/workspace",
		].join("\n");
		expect(excludePiDocumentation(prompt)).toBe("You are Pi.\nCurrent working directory: /tmp/workspace");
	});

	it("throws when the documentation section is missing", () => {
		expect(() => excludePiDocumentation("You are Pi.\nCurrent working directory: /tmp")).toThrow(
			"Default Pi system prompt has no Pi documentation section.",
		);
	});

	it("throws when the working-directory section is missing", () => {
		expect(() => excludePiDocumentation("You are Pi.\nPi documentation (read only)\n# Docs")).toThrow(
			"Default Pi system prompt has no working-directory section.",
		);
	});
});
