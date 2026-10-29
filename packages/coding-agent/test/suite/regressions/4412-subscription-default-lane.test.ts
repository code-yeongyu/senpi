import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type Model, providerCredentialEnvNames } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	defaultModelPerProvider,
	findInitialModel,
	restoreModelFromSession,
} from "../../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import type { AuthStatus } from "../../../src/core/provider-composer.ts";

// #4412: a subscription sign-in plus a metered API key for the same vendor must start new sessions on the
// subscription lane, never on the API lane that bills per token.

type InitialModelRuntime = Parameters<typeof findInitialModel>[0]["modelRuntime"];

const temporaryDirectories: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function runtimeWithChatGptSignInAndOpenAiKey(): Promise<ModelRuntime> {
	const agentDir = mkdtempSync(join(tmpdir(), "senpi-subscription-default-"));
	temporaryDirectories.push(agentDir);
	const authPath = join(agentDir, "auth.json");
	const signIn = { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 4102444800000 };
	writeFileSync(authPath, JSON.stringify({ "chatgpt-subscription": signIn }), { mode: 0o600 });
	// ModelRuntime.create reads process env; clear every provider credential the host may carry so only
	// the synthetic OpenAI key below configures a second lane.
	for (const name of providerCredentialEnvNames()) vi.stubEnv(name, undefined);
	vi.stubEnv("OPENAI_API_KEY", "sk-synthetic-test-key");
	return ModelRuntime.create({ authPath, agentDir, modelsPath: null });
}

describe("subscription lanes win the automatic default over their metered API twins", () => {
	it("starts a new session on the ChatGPT subscription when an OpenAI API key is also configured", async () => {
		const runtime = await runtimeWithChatGptSignInAndOpenAiKey();
		expect(runtime.hasConfiguredAuth("openai")).toBe(true);
		expect(runtime.hasConfiguredAuth("chatgpt-subscription")).toBe(true);

		const initial = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(initial.model).toMatchObject({ provider: "chatgpt-subscription", id: "gpt-6.1-sol" });
		expect(initial.provenance).toBe("provider-default");
	});

	it("falls back to the ChatGPT subscription when a saved session model no longer exists", async () => {
		const runtime = await runtimeWithChatGptSignInAndOpenAiKey();
		// A saved model that still exists is kept on resume even when its provider is signed out (#4410);
		// only a retired id, absent from every catalog, falls back to the automatic default.
		expect(runtime.getModel("deepseek", "deepseek-retired-4412")).toBeUndefined();

		const restored = await restoreModelFromSession("deepseek", "deepseek-retired-4412", undefined, false, runtime);

		expect(restored.model).toMatchObject({ provider: "chatgpt-subscription", id: "gpt-6.1-sol" });
	});

	const stored: AuthStatus = { configured: true, source: "stored" };
	const environment: AuthStatus = { configured: true, source: "environment", label: "API key env var" };

	function providerDefault(provider: string): Model<Api> {
		const modelId = defaultModelPerProvider[provider];
		const model = getModels(provider as Parameters<typeof getModels>[0]).find((entry) => entry.id === modelId);
		// anthropic-subscription registers its catalog through a builtin extension, so the static
		// catalog has no rows for it; it serves the same Claude ids as the API lane.
		if (!model && provider === "anthropic-subscription") return { ...providerDefault("anthropic"), provider };
		if (!model) throw new Error(`no catalog default for ${provider}`);
		return model;
	}

	function runtimeWith(models: Model<Api>[], statuses: Record<string, AuthStatus>): InitialModelRuntime {
		return {
			getAvailableSnapshot: () => models,
			getModel: (provider: string, modelId: string) =>
				models.find((model) => model.provider === provider && model.id === modelId),
			hasConfiguredAuth: (provider: string) => statuses[provider]?.configured === true,
			getProviderAuthStatus: (provider: string) => statuses[provider] ?? { configured: false },
		} as unknown as InitialModelRuntime;
	}

	it.each([
		["openai", "chatgpt-subscription"],
		["anthropic", "anthropic-subscription"],
		["moonshotai", "kimi-coding"],
		["moonshotai-cn", "kimi-coding"],
		["xiaomi", "xiaomi-token-plan-cn"],
		["xiaomi", "xiaomi-token-plan-ams"],
		["xiaomi", "xiaomi-token-plan-sgp"],
	])("a configured %s key never outranks the %s plan", async (metered, subscription) => {
		const meteredDefault = providerDefault(metered);
		const subscriptionDefault = providerDefault(subscription);
		for (const meteredStatus of [stored, environment]) {
			for (const models of [
				[meteredDefault, subscriptionDefault],
				[subscriptionDefault, meteredDefault],
			]) {
				const runtime = runtimeWith(models, { [metered]: meteredStatus, [subscription]: stored });

				const initial = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

				expect(initial.model).toBe(subscriptionDefault);
				expect(initial.provenance).toBe("provider-default");
			}
		}
	});
});
