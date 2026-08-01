import { describe, expect, it } from "vitest";

import {
	buildNativeEntry,
	type NativeModelInfo,
	type NativeModelRegistry,
} from "../src/core/extensions/builtin/websearch/websearch/native.ts";

interface MatrixCase {
	provider: string;
	id: string;
	baseUrl?: string;
	expected: { provider: string; resource: string; baseUrl?: string } | null;
}

const registry: NativeModelRegistry = {
	async getApiKeyAndHeaders() {
		return { ok: true, apiKey: "native-test" };
	},
};

const MATRIX: readonly MatrixCase[] = [
	// openai mapped -> openai/responses
	{ provider: "openai", id: "gpt-5.6-sol", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5.6-terra", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5.5", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5.5-fast", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5.4", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5-pro", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-5", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-4.1-mini", expected: { provider: "openai", resource: "responses" } },
	{ provider: "openai", id: "gpt-4o-mini-2026-01-01", expected: { provider: "openai", resource: "responses" } },
	// openai null (codex variants, legacy 4x, o-series)
	{ provider: "openai", id: "gpt-5.3-codex", expected: null },
	{ provider: "openai", id: "gpt-5.3-codex-spark", expected: null },
	{ provider: "openai", id: "gpt-4-turbo", expected: null },
	{ provider: "openai", id: "o3", expected: null },
	// anthropic mapped -> anthropic/messages
	{ provider: "anthropic", id: "claude-opus-5", expected: { provider: "anthropic", resource: "messages" } },
	{ provider: "anthropic", id: "claude-sonnet-5", expected: { provider: "anthropic", resource: "messages" } },
	{ provider: "anthropic", id: "claude-fable-5", expected: { provider: "anthropic", resource: "messages" } },
	{ provider: "anthropic", id: "claude-haiku-4-5", expected: { provider: "anthropic", resource: "messages" } },
	{ provider: "anthropic", id: "claude-opus-4-8", expected: { provider: "anthropic", resource: "messages" } },
	{
		provider: "anthropic",
		id: "claude-sonnet-4-5-20250929",
		expected: { provider: "anthropic", resource: "messages" },
	},
	// anthropic null
	{ provider: "anthropic", id: "not-a-claude-model", expected: null },
	// xai mapped -> xai/responses
	{ provider: "xai", id: "grok-4.3", expected: { provider: "xai", resource: "responses" } },
	// openrouter vendor recursion -> anthropic/messages
	{
		provider: "openrouter",
		id: "anthropic/claude-opus-5",
		baseUrl: "https://openrouter.example.com/v1",
		expected: { provider: "anthropic", resource: "messages" },
	},
	// deepseek mapped -> deepseek/messages on the Anthropic-compatible route
	{
		provider: "deepseek",
		id: "deepseek-v4-flash",
		baseUrl: "https://api.deepseek.com",
		expected: {
			provider: "deepseek",
			resource: "messages",
			baseUrl: "https://api.deepseek.com/anthropic/v1/messages",
		},
	},
	{
		provider: "deepseek",
		id: "deepseek-v4-pro",
		baseUrl: "https://api.deepseek.com",
		expected: {
			provider: "deepseek",
			resource: "messages",
			baseUrl: "https://api.deepseek.com/anthropic/v1/messages",
		},
	},
	// deepseek null (non-v4 ids)
	{ provider: "deepseek", id: "deepseek-v3", baseUrl: "https://api.deepseek.com", expected: null },
	{ provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com", expected: null },
];

describe("vendored websearch native model matrix", () => {
	for (const testCase of MATRIX) {
		const label = testCase.expected
			? `maps to ${testCase.expected.provider}/${testCase.expected.resource}`
			: "yields no native route";
		it(`#given ${testCase.provider}/${testCase.id} #when building the native entry #then ${label}`, async () => {
			// given
			const model: NativeModelInfo = {
				provider: testCase.provider,
				id: testCase.id,
				baseUrl: testCase.baseUrl ?? "https://gateway.example.com/v1",
			};

			// when
			const entry = await buildNativeEntry(model, registry, "native");

			// then
			if (testCase.expected) {
				expect(entry).not.toBeNull();
				expect(entry?.provider).toBe(testCase.expected.provider);
				expect(entry?.baseUrl).toBe(testCase.expected.baseUrl ?? `${model.baseUrl}/${testCase.expected.resource}`);
				expect(entry?.model).toBe(testCase.id);
				expect(entry?.apiKey).toBe("native-test");
				expect(entry?.priority).toBe(-1);
			} else {
				expect(entry).toBeNull();
			}
		});
	}
});
