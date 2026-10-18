import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2196: an endpoint-advertised default effort becomes the model's default thinking level.
function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`${what} is missing`);
	return value;
}

const ENDPOINT_LEVELS = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null };

function withEndpointDefault<TApi extends Api>(model: Model<TApi>): Model<TApi> {
	return { ...model, reasoning: true, thinkingLevelMap: ENDPOINT_LEVELS, defaultThinkingLevel: "low" };
}

describe("model defaultThinkingLevel at startup", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;
	const base = required(getModel("chatgpt-subscription", "gpt-5.5"), "catalog model chatgpt-subscription/gpt-5.5");

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-2196-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function settings(values: Record<string, unknown>): SettingsManager {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(values));
		return SettingsManager.create(cwd, agentDir);
	}

	it("starts at the model default instead of the global default", async () => {
		const model = withEndpointDefault(base);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager: settings({ defaultThinkingLevel: "high" }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("keeps a remembered per-model level above the model default", async () => {
		const model = withEndpointDefault(base);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model,
			settingsManager: settings({ modelThinkingLevels: { [`${model.provider}/${model.id}`]: "high" } }),
			sessionManager: SessionManager.inMemory(cwd),
		});

		expect(session.thinkingLevel).toBe("high");
		session.dispose();
	});
});

describe("model defaultThinkingLevel on model switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("switches to the model default when the target has no remembered level", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "One", reasoning: true },
				{ id: "faux-2", name: "Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		harness.session.setThinkingLevel("high");

		await harness.session.setModel(withEndpointDefault(required(harness.getModel("faux-2"), "faux-2")));

		expect(harness.session.thinkingLevel).toBe("low");
	});
});

describe("models.json defaultThinkingLevel", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `senpi-2196-models-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("carries a custom model's defaultThinkingLevel onto the runtime model", async () => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"local-endpoint": {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test-key",
						compat: { supportsReasoningEffort: true },
						models: [
							{
								id: "endpoint-model",
								reasoning: true,
								thinkingLevelMap: ENDPOINT_LEVELS,
								defaultThinkingLevel: "low",
							},
						],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(tempDir, "auth.json"),
			allowModelNetwork: false,
		});

		expect(runtime.getError()).toBeUndefined();
		expect(runtime.getModel("local-endpoint", "endpoint-model")?.defaultThinkingLevel).toBe("low");
	});

	it("rejects an unknown defaultThinkingLevel", async () => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"local-endpoint": {
						baseUrl: "http://127.0.0.1:9/v1",
						api: "openai-completions",
						apiKey: "test-key",
						models: [{ id: "endpoint-model", defaultThinkingLevel: "turbo" }],
					},
				},
			}),
		);
		const runtime = await ModelRuntime.create({
			modelsPath,
			authPath: join(tempDir, "auth.json"),
			allowModelNetwork: false,
		});

		expect(runtime.getError()).toContain("defaultThinkingLevel");
	});
});
