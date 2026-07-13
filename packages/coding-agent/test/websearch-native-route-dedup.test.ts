import { describe, expect, it } from "vitest";

import {
	buildNativeEntries,
	type NativeModelInfo,
	type NativeModelRegistry,
} from "../src/core/extensions/builtin/websearch/websearch/native.ts";

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
		const firstIds = firstEntries.map((entry) => entry.id);
		expect(firstIds).toEqual(secondEntries.map((entry) => entry.id));
		expect(new Set(firstIds).size).toBe(2);
		expect(firstIds.every((id) => id?.startsWith("native-"))).toBe(true);
		expect(firstIds.join(" ")).not.toMatch(/gateway|claude|glm|native-test/);
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

	it("#given unavailable aliases on one route #when discovering native entries #then resolves auth for only the first alias", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: false, error: "unavailable" };
			},
			getAvailable() {
				return anthropicAliases("https://gateway.example.com/v1");
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toEqual([]);
		expect(authModels).toEqual(["claude-opus-4"]);
	});

	it("#given dotted private route spellings #when discovering native entries #then rejects them before auth", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{ provider: "openai", id: "gpt-5.5", baseUrl: "https://localhost./v1" },
					{ provider: "openai", id: "gpt-4.1", baseUrl: "https://127.1../v1" },
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toEqual([]);
		expect(authModels).toEqual([]);
	});

	it("#given dotted and undotted public aliases #when discovering native entries #then emits one route", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{ provider: "openai", id: "gpt-5.5", baseUrl: "https://gateway.example.com./v1" },
					{ provider: "openai", id: "gpt-4.1", baseUrl: "https://gateway.example.com/v1" },
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toHaveLength(1);
		expect(entries[0]?.baseUrl).toBe("https://gateway.example.com./v1/responses");
		expect(authModels).toEqual(["gpt-5.5"]);
	});

	it("#given one provider on distinct endpoints #when discovering native entries #then preserves both route candidates", async () => {
		// given
		const authModels: string[] = [];
		const modelRegistry: DiscoveryRegistry = {
			async getApiKeyAndHeaders(model) {
				authModels.push(model.id);
				return { ok: true, apiKey: "native-test" };
			},
			getAvailable() {
				return [
					{ provider: "openai", id: "gpt-4.1", baseUrl: "https://openai-a.example.com/v1" },
					{ provider: "openai", id: "gpt-5.5", baseUrl: "https://openai-b.example.com/v1" },
				];
			},
		};

		// when
		const entries = await buildNativeEntries(undefined, modelRegistry);

		// then
		expect(entries).toHaveLength(2);
		expect(entries.map((entry) => entry.baseUrl)).toEqual([
			"https://openai-a.example.com/v1/responses",
			"https://openai-b.example.com/v1/responses",
		]);
		expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
		expect(authModels).toEqual(["gpt-4.1", "gpt-5.5"]);
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
		expect(entries[0]?.id).toBeTruthy();
		expect(entries[0]?.id).not.toContain("secret");
		expect(authModels).toEqual(["gpt-5.5"]);
	});
});
