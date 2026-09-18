import { describe, expect, it } from "vitest";
import {
	type NativeImageGenModel,
	supportsNativeOpenAiImageGeneration,
} from "../../src/core/extensions/builtin/openai-image-gen/gate.ts";

const codex: NativeImageGenModel = {
	id: "gpt-5.5",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

describe("Codex native image generation capability", () => {
	it.each([
		["official Codex", {}, true],
		["official opt-out", { compat: { supportsImageGeneration: false } }, false],
		["proxy", { baseUrl: "https://codex-proxy.example.test/backend-api" }, false],
		[
			"proxy opt-in",
			{ baseUrl: "https://codex-proxy.example.test/backend-api", compat: { supportsImageGeneration: true } },
			true,
		],
		["lookalike", { baseUrl: "https://chatgpt.com.example.test/backend-api" }, false],
		["userinfo lookalike", { baseUrl: "https://chatgpt.com@proxy.example.test/backend-api" }, false],
		["malformed", { baseUrl: "https://[chatgpt.com" }, false],
		["relative", { baseUrl: "/backend-api" }, false],
		["empty Codex URL", { baseUrl: "" }, false],
		["Responses host on Codex", { baseUrl: "https://api.openai.com/v1" }, false],
		["Codex host on Responses", { api: "openai-responses" }, false],
		["official Responses", { api: "openai-responses", baseUrl: "https://api.openai.com/v1" }, true],
		["default Responses URL", { api: "openai-responses", baseUrl: "" }, true],
		["completions opt-in", { api: "openai-completions", compat: { supportsImageGeneration: true } }, false],
		["Azure opt-in", { api: "azure-openai-responses", compat: { supportsImageGeneration: true } }, false],
		["unrelated API", { api: "anthropic-messages" }, false],
	] satisfies [string, Partial<NativeImageGenModel>, boolean][])("%s", (_label, fields, expected) => {
		const model = { ...codex, ...fields };
		const original = structuredClone(model);
		expect(supportsNativeOpenAiImageGeneration(model)).toBe(expected);
		expect(model).toEqual(original);
	});

	it("does not infer capability without a model", () => {
		expect(supportsNativeOpenAiImageGeneration(undefined)).toBe(false);
	});
});
