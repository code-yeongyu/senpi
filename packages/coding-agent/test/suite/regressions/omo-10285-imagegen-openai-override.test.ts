import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { resolveImageGenAuth } from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";

const tempDirs: string[] = [];

const UNRELATED_GATEWAY_SORTED_BEFORE_OPENAI = {
	api: "openai-completions",
	baseUrl: "https://aaa-compat.example/v1",
	apiKey: "aaa-compat-key",
	models: [{ id: "aaa-chat" }],
};

async function registryWith(providers: Record<string, unknown>, storedOpenAiKey?: string): Promise<ModelRegistry> {
	const dir = mkdtempSync(join(tmpdir(), "senpi-omo-10285-"));
	tempDirs.push(dir);
	const modelsJsonPath = join(dir, "models.json");
	writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	const authStorage = AuthStorage.create(join(dir, "auth.json"));
	if (storedOpenAiKey !== undefined) {
		await authStorage.modify("openai", async () => ({ type: "api_key", key: storedOpenAiKey }));
	}
	const registry = ModelRegistry.create(authStorage, modelsJsonPath);
	expect(registry.getError()).toBeUndefined();
	return registry;
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
});

describe("omo#10285: generate_image resolves the openai provider like model calls", () => {
	it("uses a models.json openai override (custom baseUrl + key) instead of an unrelated gateway", async () => {
		const registry = await registryWith({
			openai: { baseUrl: "https://my-proxy.example/v1", apiKey: "proxy-key" },
			"aaa-compat": UNRELATED_GATEWAY_SORTED_BEFORE_OPENAI,
		});

		const auth = await resolveImageGenAuth({ modelRegistry: registry, env: {} });

		expect(auth).toMatchObject({ providerId: "openai", baseUrl: "https://my-proxy.example/v1", apiKey: "proxy-key" });
	});

	it("sends a stored openai key to the overridden baseUrl, as model calls do", async () => {
		const registry = await registryWith({ openai: { baseUrl: "https://my-proxy.example/v1" } }, "sk-stored-test");

		const auth = await resolveImageGenAuth({ modelRegistry: registry, env: {} });

		expect(auth).toMatchObject({
			providerId: "openai",
			baseUrl: "https://my-proxy.example/v1",
			apiKey: "sk-stored-test",
		});
	});

	it("keeps a stored openai key without an override on api.openai.com", async () => {
		const registry = await registryWith({ "aaa-compat": UNRELATED_GATEWAY_SORTED_BEFORE_OPENAI }, "sk-stored-test");

		const auth = await resolveImageGenAuth({ modelRegistry: registry, env: {} });

		expect(auth).toMatchObject({
			kind: "native-openai",
			providerId: "openai",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "sk-stored-test",
		});
	});

	it("lets PI_IMAGE_GEN_PROVIDER win over a models.json openai override", async () => {
		const registry = await registryWith({
			openai: { baseUrl: "https://my-proxy.example/v1", apiKey: "proxy-key" },
			"aaa-compat": UNRELATED_GATEWAY_SORTED_BEFORE_OPENAI,
		});

		const auth = await resolveImageGenAuth({ modelRegistry: registry, env: { PI_IMAGE_GEN_PROVIDER: "aaa-compat" } });

		expect(auth).toMatchObject({ providerId: "aaa-compat", baseUrl: "https://aaa-compat.example/v1" });
	});

	it("reports image generation as not configured when nothing can serve it", async () => {
		const registry = await registryWith({});

		const auth = await resolveImageGenAuth({ modelRegistry: registry, env: {} });

		expect(auth.kind).toBe("none");
	});
});
