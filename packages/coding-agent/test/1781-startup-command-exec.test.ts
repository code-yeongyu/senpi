import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

const PROVIDER = "cmd-provider";

function toShPath(value: string): string {
	return value.replace(/\\/g, "/").replace(/"/g, '\\"');
}

describe("1781 startup does not execute models.json !command API keys", () => {
	let tempDir: string;
	let marker: string;
	let modelsPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-1781-cmd-exec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		marker = join(tempDir, "marker");
		modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					[PROVIDER]: {
						baseUrl: "https://example.invalid/v1",
						api: "openai-completions",
						apiKey: `!touch "${toShPath(marker)}"; echo cmd-key`,
						models: [
							{
								id: "m",
								name: "m",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
				},
			}),
		);
		clearConfigValueCache();
	});

	afterEach(() => {
		clearConfigValueCache();
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createRuntime(credentials = AuthStorage.inMemory()): Promise<ModelRuntime> {
		return ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		});
	}

	test("create, availability, and checkAuth classify the command without executing it", async () => {
		const runtime = await createRuntime();
		expect(existsSync(marker)).toBe(false);
		expect(runtime.getProviderAuthStatus(PROVIDER)).toEqual({
			configured: true,
			source: "models_json_command",
		});
		expect(await runtime.checkAuth(PROVIDER)).toEqual({
			type: "api_key",
			source: "configured API key",
		});
		expect(existsSync(marker)).toBe(false);
	});

	test("a keyless stored credential does not execute the command during startup", async () => {
		const credentials = AuthStorage.inMemory();
		await credentials.modify(PROVIDER, async () => ({ type: "api_key" }));
		const runtime = await createRuntime(credentials);
		expect(existsSync(marker)).toBe(false);
		expect(await runtime.checkAuth(PROVIDER)).toEqual({
			type: "api_key",
			source: "configured API key",
		});
		expect(existsSync(marker)).toBe(false);
	});

	test("the first getAuth / resolveBaseAuth path executes the command once", async () => {
		const runtime = await createRuntime();
		expect(existsSync(marker)).toBe(false);
		const auth = await runtime.getAuth(PROVIDER);
		expect(auth?.auth.apiKey).toBe("cmd-key");
		expect(auth?.source).toBe("configured API key");
		expect(existsSync(marker)).toBe(true);
	});

	test("getAuth still resolves a models.json command when a keyless stored credential is present", async () => {
		const credentials = AuthStorage.inMemory();
		await credentials.modify(PROVIDER, async () => ({ type: "api_key" }));
		const runtime = await createRuntime(credentials);
		expect(existsSync(marker)).toBe(false);
		const auth = await runtime.getAuth(PROVIDER);
		expect(auth?.auth.apiKey).toBe("cmd-key");
		expect(existsSync(marker)).toBe(true);
	});
});
