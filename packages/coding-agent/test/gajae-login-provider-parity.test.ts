import { describe, expect, it } from "vitest";
import { buildLoginProviderInfos } from "../src/core/auth-providers.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

const GAJAE_PROVIDER_IDS = [
	"kimi-code",
	"openai-codex-device",
	"minimax-code",
	"minimax-code-cn",
	"moonshot",
	"opencode-zen",
] as const;

describe("Gajae /login provider parity", () => {
	it("lists the six remaining Gajae provider IDs", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const providers = buildLoginProviderInfos(registry);
		const providerIds = new Set(providers.map((provider) => provider.id));

		// Use set membership: login list is larger than the Gajae subset.
		for (const id of GAJAE_PROVIDER_IDS) {
			expect(providerIds.has(id), `missing login provider ${id}`).toBe(true);
		}
		expect(providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "kimi-code", authType: "oauth" }),
				expect.objectContaining({ id: "openai-codex-device", authType: "oauth" }),
				expect.objectContaining({ id: "minimax-code", authType: "api_key" }),
				expect.objectContaining({ id: "minimax-code-cn", authType: "api_key" }),
				expect.objectContaining({ id: "moonshot", authType: "api_key" }),
				expect.objectContaining({ id: "opencode-zen", authType: "api_key" }),
			]),
		);
		expect(providers.filter((provider) => provider.id === "openai-codex-device")).toHaveLength(1);
	});

	it("stores device-code credentials under the OpenAI Codex provider", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.set("openai-codex-device", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});

		// Canonical storage key is openai-codex; aliases resolve through storageKey.
		expect(Object.keys(authStorage.getAll())).toEqual(["openai-codex"]);
		expect(authStorage.get("openai-codex-device")).toEqual(authStorage.get("openai-codex"));
		const listed = await authStorage.list();
		expect(listed).toEqual([{ providerId: "openai-codex", type: "oauth" }]);
		authStorage.remove("openai-codex-device");
		expect(authStorage.has("openai-codex")).toBe(false);
	});
});
