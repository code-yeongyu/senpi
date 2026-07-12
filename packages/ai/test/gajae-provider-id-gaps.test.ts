import { describe, expect, it } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";

const API_KEY_ALIASES = [
	["minimax-code", "minimax", "MINIMAX_CODE_API_KEY"],
	["minimax-code-cn", "minimax-cn", "MINIMAX_CODE_CN_API_KEY"],
	["moonshot", "moonshotai", "MOONSHOT_API_KEY"],
	["opencode-zen", "opencode", "OPENCODE_API_KEY"],
] as const;

describe("Gajae provider ID gaps", () => {
	it("keeps API-key aliases aligned with their canonical model catalogs", async () => {
		const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));

		for (const [aliasId, sourceId, envVar] of API_KEY_ALIASES) {
			const alias = providers.get(aliasId);
			const source = providers.get(sourceId);
			expect(alias?.getModels().map((model) => model.id)).toEqual(source?.getModels().map((model) => model.id));
			expect(alias?.getModels().every((model) => model.provider === aliasId)).toBe(true);
			const auth = alias?.auth.apiKey;
			const model = alias?.getModels()[0];
			if (!auth || !model) throw new Error(`Missing provider alias: ${aliasId}`);
			const resolved = await auth.resolve({
				model,
				ctx: { env: async (name) => (name === envVar ? "test-key" : undefined), fileExists: async () => false },
			});
			expect(resolved).toMatchObject({ auth: { apiKey: "test-key" }, source: envVar });
		}
	});

	it("registers Kimi OAuth models and the OpenAI device-code model alias", () => {
		const providers = new Map(builtinProviders().map((provider) => [provider.id, provider]));
		const kimi = providers.get("kimi-code");
		expect(kimi?.auth.oauth?.name).toBe("Kimi Code");
		expect(kimi?.getModels().map((model) => model.id)).toEqual([
			"kimi-for-coding",
			"kimi-k2",
			"kimi-k2-turbo-preview",
			"kimi-k2.5",
			"kimi-k2.7-code",
		]);

		const codex = providers.get("openai-codex");
		const device = providers.get("openai-codex-device");
		expect(device?.auth.oauth).toBeDefined();
		expect(device?.getModels().map((model) => model.id)).toEqual(codex?.getModels().map((model) => model.id));
	});
});
