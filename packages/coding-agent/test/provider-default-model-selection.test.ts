import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, test } from "vitest";
import { defaultModelPerProvider, findInitialModel, restoreModelFromSession } from "../src/core/model-resolver.ts";
import type { AuthStatus } from "../src/core/provider-composer.ts";

type InitialModelRuntime = Parameters<typeof findInitialModel>[0]["modelRuntime"];

function runtimeFor(availableModels: Model<Api>[]): InitialModelRuntime {
	return {
		getAvailableSnapshot: () => availableModels,
		getModel: (provider: string, modelId: string) =>
			availableModels.find((model) => model.provider === provider && model.id === modelId),
		hasConfiguredAuth: () => true,
	} as unknown as InitialModelRuntime;
}

describe("OpenAI provider defaults", () => {
	test("prefers GPT-6.1 Sol automatically while preserving explicit GPT-5.5", async () => {
		const openAiModels = getModels("openai");
		const codexModels = getModels("chatgpt-subscription");
		const availableModels: Model<Api>[] = [
			openAiModels.find((model) => model.id === "gpt-6.1-sol"),
			codexModels.find((model) => model.id === "gpt-6.1-sol"),
			openAiModels.find((model) => model.id === "gpt-6-sol"),
			codexModels.find((model) => model.id === "gpt-6-sol"),
			openAiModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.6-sol"),
			codexModels.find((model) => model.id === "gpt-5.5"),
		].filter((model) => model !== undefined);
		const runtime = runtimeFor(availableModels);

		const automatic = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });
		const explicit = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "chatgpt-subscription",
			defaultModelId: "gpt-5.5",
			modelRuntime: runtime,
		});

		expect(automatic.model?.id).toBe("gpt-6.1-sol");
		expect(automatic.provenance).toBe("provider-default");
		expect(explicit.model?.id).toBe("gpt-5.5");
		expect(explicit.provenance).toBe("settings");
	});

	test("falls through to first-available when the registry carries GPT-6 Sol but not GPT-6.1 Sol", async () => {
		const openAiModels = getModels("openai");
		const availableModels: Model<Api>[] = [openAiModels.find((model) => model.id === "gpt-6-sol")].filter(
			(model) => model !== undefined,
		);

		const automatic = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtimeFor(availableModels),
		});

		expect(automatic.model?.id).toBe("gpt-6-sol");
		expect(automatic.provenance).toBe("first-available");
	});

	test("falls through to first-available when the registry carries GPT-5.6 Sol but not GPT-6.1 Sol", async () => {
		const openAiModels = getModels("openai");
		const availableModels: Model<Api>[] = [openAiModels.find((model) => model.id === "gpt-5.6-sol")].filter(
			(model) => model !== undefined,
		);

		const automatic = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRuntime: runtimeFor(availableModels),
		});

		expect(automatic.model?.id).toBe("gpt-5.6-sol");
		expect(automatic.provenance).toBe("first-available");
	});
});

// #2327: a provider available only through a shared cloud credential chain (ambient AWS env)
// must never become the automatic default over a provider the user configured.
describe("ambient cloud credentials never outrank configured providers", () => {
	const findDefault = (provider: Parameters<typeof getModels>[0]): Model<Api> => {
		const model = getModels(provider).find((candidate) => candidate.id === defaultModelPerProvider[provider]);
		if (!model) throw new Error(`no catalog default for ${provider}`);
		return model;
	};
	const bedrock = findDefault("amazon-bedrock");
	const deepseek = findDefault("deepseek");
	const anthropic = findDefault("anthropic");
	const claudeSubscription: Model<Api> = { ...anthropic, provider: "anthropic-subscription" };
	const ambientAws: AuthStatus = { configured: true, source: "environment", label: "AWS access keys", ambient: true };
	const stored: AuthStatus = { configured: true, source: "stored" };

	function runtimeWithAuth(models: Model<Api>[], statuses: Record<string, AuthStatus>): InitialModelRuntime {
		return {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
			hasConfiguredAuth: (provider: string) => statuses[provider]?.configured === true,
			getProviderAuthStatus: (provider: string) => statuses[provider] ?? { configured: false },
		} as unknown as InitialModelRuntime;
	}

	test("#given AWS env and a Claude subscription login #when no default is saved #then the subscription default wins", async () => {
		const runtime = runtimeWithAuth([bedrock, claudeSubscription], {
			"amazon-bedrock": ambientAws,
			"anthropic-subscription": stored,
		});

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model?.provider).toBe("anthropic-subscription");
		expect(result.model?.id).toBe(defaultModelPerProvider["anthropic-subscription"]);
		expect(result.provenance).toBe("provider-default");
	});

	test("#given AWS env and a stored key for a later provider #when no default is saved #then that provider wins", async () => {
		const runtime = runtimeWithAuth([bedrock, deepseek], { "amazon-bedrock": ambientAws, deepseek: stored });

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model).toBe(deepseek);
		expect(result.provenance).toBe("provider-default");
	});

	test("#given AWS env and a provider-dedicated API key env var #when no default is saved #then the key's provider wins", async () => {
		const runtime = runtimeWithAuth([bedrock, anthropic], {
			"amazon-bedrock": ambientAws,
			anthropic: { configured: true, source: "environment", label: "ANTHROPIC_API_KEY" },
		});

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model).toBe(anthropic);
	});

	test("#given AWS env and a configured provider with no table default #when no default is saved #then its first model wins", async () => {
		const local: Model<Api> = { ...deepseek, provider: "local-server", id: "local-model" };
		const runtime = runtimeWithAuth([bedrock, local], { "amazon-bedrock": ambientAws, "local-server": stored });

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model).toBe(local);
		expect(result.provenance).toBe("first-available");
	});

	test("#given only AWS env #when no default is saved #then bedrock is still the default", async () => {
		const runtime = runtimeWithAuth([bedrock], { "amazon-bedrock": ambientAws });

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model).toBe(bedrock);
		expect(result.provenance).toBe("provider-default");
	});

	test("#given a saved bedrock default #when a login also exists #then the explicit choice wins", async () => {
		const runtime = runtimeWithAuth([bedrock, deepseek], { "amazon-bedrock": ambientAws, deepseek: stored });

		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "amazon-bedrock",
			defaultModelId: bedrock.id,
			modelRuntime: runtime,
		});

		expect(result.model).toBe(bedrock);
		expect(result.provenance).toBe("settings");
	});

	test("#given a session model that can no longer be restored #when falling back #then the configured provider wins over AWS env", async () => {
		const runtime = runtimeWithAuth([bedrock, deepseek], { "amazon-bedrock": ambientAws, deepseek: stored });

		const result = await restoreModelFromSession("gone", "gone-model", undefined, false, runtime);

		expect(result.model).toBe(deepseek);
	});
});
