import { describe, expect, it } from "vitest";

import {
	buildNativeEntries,
	type NativeModelInfo,
	type NativeModelRegistry,
} from "../../src/core/extensions/builtin/websearch/websearch/native.ts";

type DiscoveryRegistry = NativeModelRegistry & {
	getAvailable(): NativeModelInfo[];
};

function anthropicAliases(baseUrl: string): NativeModelInfo[] {
	return Array.from({ length: 8 }, (_value, index) => ({
		provider: "anthropic",
		id: index === 0 ? "claude-opus-4" : `claude-opus-4-${index}`,
		baseUrl,
	}));
}

function zAiAliases(baseUrl: string): NativeModelInfo[] {
	return Array.from({ length: 6 }, (_value, index) => ({
		provider: "z-ai",
		id: `glm-4.6-${index}`,
		baseUrl,
	}));
}

describe("vendored websearch native route discovery", () => {
	it("#given fourteen aliases across two endpoints #when discovering native entries #then emits one opaque entry per route", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					...anthropicAliases("https://gateway.example.com/v1"),
					...zAiAliases("https://gateway.example.com/v1"),
				];
			},
		};

		// when
		const firstEntries = await buildNativeEntries(undefined, modelRegistry);
		const secondEntries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(firstEntries).toHaveLength(2);
		expect(firstEntries.map((entry) => entry.id)).toEqual(secondEntries.map((entry) => entry.id));
		expect(firstEntries[0]?.id).toMatch(/^native-anthropic-[0-9a-f]{16}$/);
		expect(firstEntries[1]?.id).toMatch(/^native-z-ai-[0-9a-f]{16}$/);
		expect(firstEntries.map((entry) => entry.id).join(" ")).not.toContain("gateway-example");
		expect(authModels).toEqual(["claude-opus-4", "glm-4.6-0", "claude-opus-4", "glm-4.6-0"]);
	});

	it("#given active route auth fails #when a discovered alias shares the route #then does not retry auth through the alias", async () => {
		// given
		const activeModel: NativeModelInfo = {
			provider: "openai",
			id: "gpt-5.5",
			baseUrl: "https://gateway.example.com/v1",
		};
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return model.id === activeModel.id
					? { ok: false, error: "active unavailable" }
					: { ok: true, apiKey: "alias-key" };
			},
			getAvailable() {
				return [{ provider: "openai", id: "gpt-4.1", baseUrl: "https://gateway.example.com/v1" }];
			},
		};

		// when
		const entries = await buildNativeEntries(activeModel, modelRegistry);

		// then
		expect(entries).toEqual([]);
		expect(authModels).toEqual(["gpt-5.5"]);
	});

	it("#given query auth and fragment aliases #when building the endpoint #then preserves query and dedupes fragments", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{
						provider: "openai",
						id: "gpt-5.5",
						baseUrl: "https://gateway.example.com/v1?token=secret#first",
					},
					{
						provider: "openai",
						id: "gpt-4.1",
						baseUrl: "https://gateway.example.com/v1?token=secret#second",
					},
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toHaveLength(1);
		expect(entries[0]?.baseUrl).toBe("https://gateway.example.com/v1/responses?token=secret");
		expect(entries[0]?.id).toMatch(/^native-openai-[0-9a-f]{16}$/);
		expect(entries[0]?.id).not.toContain("secret");
		expect(authModels).toEqual(["gpt-5.5"]);
	});
});
