import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";
import { MOCK_API_KEY, MOCK_PROVIDER, startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { hermeticProviderEnv } from "./helpers/rpc-hermetic.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));

const syntheticModels = [
	{
		id: "test-reasoning-model",
		api: "anthropic-messages" as const,
		reasoning: true,
		contextWindow: 200_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "test-non-reasoning-model",
		api: "anthropic-messages" as const,
		reasoning: false,
		contextWindow: 48_000,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
	{
		id: "test-xhigh-excluded-model",
		api: "anthropic-messages" as const,
		reasoning: true,
		thinkingLevelMap: { xhigh: null },
		contextWindow: 200_000,
		maxTokens: 8192,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

describe("get_available_models supported thinking levels", () => {
	let client: RpcClient;
	let cleanup: (() => Promise<void>) | undefined;

	beforeEach(async () => {
		const fakeModelServer = await startFakeModelServer();
		const agentDirectory = join(tmpdir(), `senpi-rpc-models-${Date.now()}`);
		mkdirSync(agentDirectory, { recursive: true });
		writeFileSync(
			join(agentDirectory, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						[MOCK_PROVIDER]: {
							baseUrl: fakeModelServer.origin,
							apiKey: MOCK_API_KEY,
							api: "anthropic-messages",
							models: syntheticModels.map((model) => ({ ...model, baseUrl: fakeModelServer.origin })),
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		writeFileSync(
			join(agentDirectory, "settings.json"),
			`${JSON.stringify({ compaction: { keepRecentTokens: 1 } })}\n`,
		);
		client = new RpcClient({
			cliPath: join(testDirectory, "..", "src", "cli.ts"),
			cwd: join(testDirectory, ".."),
			env: {
				...hermeticProviderEnv(),
				ANTHROPIC_API_KEY: MOCK_API_KEY,
				PI_OFFLINE: "1",
				SENPI_CODING_AGENT_DIR: agentDirectory,
			},
			provider: MOCK_PROVIDER,
			model: syntheticModels[0].id,
		});
		cleanup = async () => {
			await client.stop();
			await fakeModelServer.close();
			rmSync(agentDirectory, { recursive: true, force: true });
		};
		await client.start();
	});

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test("returns the standard levels for a synthetic reasoning model", async () => {
		const models = await client.getAvailableModels();
		const model = models.find((candidate) => candidate.id === "test-reasoning-model");

		expect(model?.supportedThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high"]);
	});

	test("returns off only for a synthetic non-reasoning model", async () => {
		const models = await client.getAvailableModels();
		const model = models.find((candidate) => candidate.id === "test-non-reasoning-model");

		expect(model?.supportedThinkingLevels).toEqual(["off"]);
	});

	test("excludes xhigh when a synthetic model explicitly maps it to null", async () => {
		const models = await client.getAvailableModels();
		const model = models.find((candidate) => candidate.id === "test-xhigh-excluded-model");

		expect(model?.supportedThinkingLevels).not.toContain("xhigh");
	});
});
