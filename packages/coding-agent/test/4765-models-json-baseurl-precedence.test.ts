import type { AnyModel, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	chatDefinition,
	chatModel,
	EXTENSION_HOST,
	type ModelsJsonFile,
	modelsJsonFile,
} from "./support/baseurl-override-fixture.ts";

const USER_URL = "http://127.0.0.1:9/user/v1";
const USER_MODEL_URL = "http://127.0.0.1:9/per-model/v1";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

let models: ModelsJsonFile | undefined;

afterEach(() => {
	models?.remove();
	models = undefined;
});

function baseUrls(provider: Provider): [string, string][] {
	const all: readonly AnyModel[] = provider.getAllModels?.() ?? provider.getModels();
	return all.map((model) => [model.id, model.baseUrl]);
}

const extension: ProviderConfigInput = {
	baseUrl: EXTENSION_HOST,
	apiKey: "ext-key",
	api: "openai-completions",
	models: [chatDefinition("chat-a"), chatDefinition("chat-b", "https://extension-model-host.invalid/v1")],
};

describe("senpi#4765 models.json baseUrl precedence over an extension", () => {
	it("applies a models.json per-model baseUrl over the provider baseUrl and the extension's", () => {
		models = modelsJsonFile({
			"ext-proxy": { baseUrl: USER_URL, models: [{ id: "chat-b", baseUrl: USER_MODEL_URL }] },
		});
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), extension);

		expect(baseUrls(provider)).toEqual([
			["chat-a", USER_URL],
			["chat-b", USER_MODEL_URL],
		]);
	});

	it("applies a per-model baseUrl alone and leaves the other models on the extension host", () => {
		models = modelsJsonFile({ "ext-proxy": { models: [{ id: "chat-b", baseUrl: USER_MODEL_URL }] } });
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), extension);

		expect(baseUrls(provider)).toEqual([
			["chat-a", EXTENSION_HOST],
			["chat-b", USER_MODEL_URL],
		]);
	});

	it("applies the provider baseUrl to extension-declared image and classifier models", () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), {
			...extension,
			models: [
				chatDefinition("chat-a"),
				{
					type: "image",
					id: "img-a",
					name: "img-a",
					api: "openai-images",
					input: ["text"],
					output: ["image"],
					cost: ZERO_COST,
				},
				{
					type: "classifier",
					id: "cls-a",
					name: "cls-a",
					api: "typesafe-system-one",
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 8192,
				},
			],
		});

		expect(baseUrls(provider)).toEqual([
			["chat-a", USER_URL],
			["img-a", USER_URL],
			["cls-a", USER_URL],
		]);
	});

	it("applies the provider baseUrl over an extension that only retargets a base provider's models", () => {
		models = modelsJsonFile({ "base-like": { baseUrl: USER_URL } });
		const image: AnyModel = {
			type: "image",
			id: "base-image",
			name: "base-image",
			api: "openai-images",
			provider: "base-like",
			baseUrl: "https://base-host.invalid/v1",
			input: ["text"],
			output: ["image"],
			cost: ZERO_COST,
		};
		const chat = chatModel("base-like", "base-chat", "https://base-host.invalid/v1");
		const base: Provider = {
			id: "base-like",
			name: "Base",
			auth: { apiKey: { name: "Base key", resolve: async () => ({ auth: { apiKey: "base-key" } }) } },
			getModels: () => [chat],
			getAllModels: () => [chat, image],
			stream: () => {
				throw new Error("not streamed");
			},
			streamSimple: () => {
				throw new Error("not streamed");
			},
		};
		const provider = composeModelProvider("base-like", base, models.config(), { baseUrl: EXTENSION_HOST });

		expect(baseUrls(provider)).toEqual([
			["base-chat", USER_URL],
			["base-image", USER_URL],
		]);
	});

	it("sets the models.json baseUrl on every model served by extension-supplied transports", () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		const notCalled = () => {
			throw new Error("not called");
		};
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), {
			baseUrl: EXTENSION_HOST,
			apiKey: "ext-key",
			api: "custom-transport-api",
			streamSimple: notCalled,
			images: { "openai-images": { generateImages: notCalled } },
			classifiers: { "typesafe-system-one": { classify: notCalled } },
			models: [
				chatDefinition("chat-a", "https://extension-model-host.invalid/v1"),
				{
					type: "image",
					id: "img-a",
					name: "img-a",
					api: "openai-images",
					input: ["text"],
					output: ["image"],
					cost: ZERO_COST,
				},
				{
					type: "classifier",
					id: "cls-a",
					name: "cls-a",
					api: "typesafe-system-one",
					input: ["text"],
					cost: ZERO_COST,
					contextWindow: 8192,
				},
			],
		});

		expect(baseUrls(provider)).toEqual([
			["chat-a", USER_URL],
			["img-a", USER_URL],
			["cls-a", USER_URL],
		]);
		expect(provider.baseUrl).toBe(USER_URL);
	});

	it("reports the models.json baseUrl as the composed Provider.baseUrl", () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		expect(composeModelProvider("ext-proxy", undefined, models.config(), extension).baseUrl).toBe(USER_URL);
	});

	it("keeps the extension baseUrl when the models.json entry sets no baseUrl", () => {
		models = modelsJsonFile({ "ext-proxy": { headers: { "x-team": "a" } } });
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), extension);

		expect(provider.baseUrl).toBe(EXTENSION_HOST);
		expect(baseUrls(provider)).toEqual([
			["chat-a", EXTENSION_HOST],
			["chat-b", "https://extension-model-host.invalid/v1"],
		]);
	});
});
