import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOAuthProvider, resetOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { RADIUS_PROVIDER_ID } from "../src/core/radius.ts";

function radiusOAuthCredential(gatewayBaseUrl: string) {
	return {
		type: "oauth" as const,
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		gatewayConfig: {
			baseUrl: gatewayBaseUrl,
			models: [
				{
					id: "auto",
					name: "Radius Auto",
					reasoning: false,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
				{
					id: "byok/gpt-5.5",
					name: "GPT-5.5 (BYOK)",
					reasoning: true,
					input: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 256000,
					maxTokens: 32000,
				},
			],
		},
	};
}

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-test-radius-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	resetOAuthProviders();
});

afterEach(() => {
	if (tempDir && existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true });
	}
	resetOAuthProviders();
});

describe("radius oauth provider", () => {
	it("is registered as a built-in OAuth provider", () => {
		expect(getOAuthProvider(RADIUS_PROVIDER_ID)?.name).toBe("Radius");
	});
});

describe("radius models via ModelRegistry", () => {
	it("injects catalog models from the stored credential", () => {
		const registry = ModelRegistry.inMemory(
			AuthStorage.inMemory({ radius: radiusOAuthCredential("https://radius.example.com/v1") }),
		);

		const auto = registry.find(RADIUS_PROVIDER_ID, "auto");
		expect(auto).toBeDefined();
		expect(auto?.api).toBe("pi-messages");
		expect(auto?.baseUrl).toBe("https://radius.example.com/v1");
		expect(auto?.name).toBe("Radius Auto");

		// byok ids are registered verbatim
		const byok = registry.find(RADIUS_PROVIDER_ID, "byok/gpt-5.5");
		expect(byok).toBeDefined();
		expect(byok?.contextWindow).toBe(256000);

		expect(registry.hasConfiguredAuth(auto!)).toBe(true);
		expect(registry.getProviderDisplayName(RADIUS_PROVIDER_ID)).toBe("Radius");
	});

	it("exposes no radius models without credentials", () => {
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());

		expect(registry.getAll().filter((model) => model.provider === RADIUS_PROVIDER_ID)).toHaveLength(0);
		expect(getOAuthProvider(RADIUS_PROVIDER_ID)).toBeDefined();
	});

	it("keeps radius models across registry refresh", () => {
		const registry = ModelRegistry.inMemory(
			AuthStorage.inMemory({ radius: radiusOAuthCredential("https://radius.example.com/v1") }),
		);

		registry.refresh();

		expect(registry.find(RADIUS_PROVIDER_ID, "auto")).toBeDefined();
	});
});

describe("custom radius gateways via models.json", () => {
	function createRegistry(providers: Record<string, unknown>, authStorage: AuthStorage): ModelRegistry {
		const modelsJsonPath = join(tempDir, "models.json");
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
		return ModelRegistry.create(authStorage, modelsJsonPath);
	}

	it("registers an independent radius-style provider", () => {
		const registry = createRegistry(
			{ "radius-dev": { name: "Radius (dev)", baseUrl: "http://localhost:8788", oauth: "radius" } },
			AuthStorage.inMemory({ "radius-dev": radiusOAuthCredential("http://localhost:8788/v1") }),
		);

		expect(registry.getError()).toBeUndefined();
		expect(getOAuthProvider("radius-dev")?.name).toBe("Radius (dev)");
		expect(getOAuthProvider(RADIUS_PROVIDER_ID)?.name).toBe("Radius");

		// Dev gateway models are injected under the custom provider id only.
		const devAuto = registry.find("radius-dev", "auto");
		expect(devAuto).toBeDefined();
		expect(devAuto?.api).toBe("pi-messages");
		expect(devAuto?.baseUrl).toBe("http://localhost:8788/v1");
		expect(registry.find(RADIUS_PROVIDER_ID, "auto")).toBeUndefined();

		expect(registry.getProviderDisplayName("radius-dev")).toBe("Radius (dev)");
	});

	it("survives registry refresh", () => {
		const registry = createRegistry(
			{ "radius-dev": { baseUrl: "http://localhost:8788", oauth: "radius" } },
			AuthStorage.inMemory({ "radius-dev": radiusOAuthCredential("http://localhost:8788/v1") }),
		);

		registry.refresh();

		expect(getOAuthProvider("radius-dev")).toBeDefined();
		expect(registry.find("radius-dev", "auto")).toBeDefined();
	});

	it("requires baseUrl when oauth is set", () => {
		const registry = createRegistry({ "radius-dev": { oauth: "radius" } }, AuthStorage.inMemory());

		expect(registry.getError()).toContain('"baseUrl" is required when "oauth" is set');
	});
});
