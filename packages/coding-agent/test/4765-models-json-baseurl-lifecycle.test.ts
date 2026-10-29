import type { Credential, RefreshModelsContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { composeModelProvider, type ProviderConfigInput } from "../src/core/provider-composer.ts";
import {
	chatDefinition,
	createRuntime,
	EXTENSION_HOST,
	type ModelsJsonFile,
	modelsJsonFile,
	requireModel,
} from "./support/baseurl-override-fixture.ts";

const USER_URL = "http://127.0.0.1:9/user/v1";

let models: ModelsJsonFile | undefined;

afterEach(() => {
	models?.remove();
	models = undefined;
});

function refreshContext(credential?: Credential): RefreshModelsContext {
	return {
		credential,
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	};
}

const extension: ProviderConfigInput = {
	baseUrl: EXTENSION_HOST,
	apiKey: "ext-key",
	api: "openai-completions",
	models: [chatDefinition("chat-a")],
};

describe("senpi#4765 models.json baseUrl survives provider lifecycle steps", () => {
	it("re-applies the user baseUrl after the extension re-registers with a new baseUrl", async () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider("ext-proxy", extension, { refresh: false });
		await runtime.registerProvider("ext-proxy", { baseUrl: "https://second-host.invalid/v1" }, { refresh: false });

		expect(requireModel(runtime, "ext-proxy", "chat-a").baseUrl).toBe(USER_URL);
	});

	it("applies the user baseUrl to models published by refreshModels", async () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), {
			...extension,
			refreshModels: async () => [chatDefinition("chat-refreshed", "https://refreshed-host.invalid/v1")],
		});

		await provider.refreshModels?.(refreshContext());

		expect(provider.getModels().map((model) => [model.id, model.baseUrl])).toEqual([["chat-refreshed", USER_URL]]);
	});

	it("keeps the user baseUrl when oauth.modifyModels rewrites it", async () => {
		models = modelsJsonFile({ "ext-proxy": { baseUrl: USER_URL } });
		const provider = composeModelProvider("ext-proxy", undefined, models.config(), {
			...extension,
			oauth: {
				name: "Ext OAuth",
				login: async () => {
					throw new Error("not used");
				},
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
				modifyModels: (current) =>
					current.map((model) => ({ ...model, name: "rewritten", baseUrl: "https://oauth-rewrite.invalid/v1" })),
			},
		});

		await provider.refreshModels?.(
			refreshContext({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
		);

		expect(provider.getModels().map((model) => [model.name, model.baseUrl])).toEqual([["rewritten", USER_URL]]);
	});

	it("follows a models.json reload that adds and then removes the baseUrl", async () => {
		models = modelsJsonFile({ "ext-proxy": { headers: { "x-team": "a" } } });
		const runtime = await createRuntime(models.path);
		await runtime.registerProvider("ext-proxy", extension, { refresh: false });
		expect(requireModel(runtime, "ext-proxy", "chat-a").baseUrl).toBe(EXTENSION_HOST);

		models.write({ "ext-proxy": { headers: { "x-team": "a" }, baseUrl: USER_URL } });
		await runtime.refresh({ allowNetwork: false });
		expect(requireModel(runtime, "ext-proxy", "chat-a").baseUrl).toBe(USER_URL);

		models.write({ "ext-proxy": { headers: { "x-team": "a" } } });
		await runtime.refresh({ allowNetwork: false });
		expect(requireModel(runtime, "ext-proxy", "chat-a").baseUrl).toBe(EXTENSION_HOST);
	});
});
