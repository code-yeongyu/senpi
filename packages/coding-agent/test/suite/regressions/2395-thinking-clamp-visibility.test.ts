import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const PROVIDER = "local-example";

function createRegistry(): ModelRegistry {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory({ [PROVIDER]: { type: "api_key", key: "test-key" } }));
	const model = (id: string, reasoning: boolean) => ({
		id,
		name: id,
		api: "openai-completions" as const,
		reasoning,
		input: ["text" as const],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
	registry.registerProvider(PROVIDER, {
		baseUrl: "https://example.test/v1",
		apiKey: "test-key",
		api: "openai-completions",
		models: [model("plain-model", false), model("reasoning-model", true)],
	});
	return registry;
}

// Regression for code-yeongyu/senpi#2395: a clamped explicit thinking level is recorded and warned about once.
describe("explicit thinking level clamps stay visible (#2395)", () => {
	const roots: string[] = [];
	const sessions: AgentSession[] = [];

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	async function startSession(
		modelId: string,
		thinkingLevel?: ThinkingLevel,
		settings?: Parameters<typeof SettingsManager.inMemory>[0],
	): Promise<AgentSession> {
		const root = mkdtempSync(join(tmpdir(), "senpi-2395-clamp-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const modelRegistry = createRegistry();
		const model = modelRegistry.find(PROVIDER, modelId) as Model<Api>;
		const { session } = await createAgentSession({
			cwd: root,
			agentDir,
			modelRegistry,
			settingsManager: SettingsManager.inMemory(settings),
			model,
			thinkingLevel,
		});
		sessions.push(session);
		return session;
	}

	function lastThinkingEntrySelection(session: AgentSession): unknown {
		const entries = session.sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change");
		return entries.at(-1)?.thinkingSelection;
	}

	function clampEvents(session: AgentSession): AgentSessionEvent[] {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			if (event.type === "thinking_level_clamped") events.push(event);
		});
		return events;
	}

	it("records the requested level and the reason when a startup request is clamped", async () => {
		const session = await startSession("plain-model", "high");

		const clamped = { level: "off", source: "explicit", requested: "high", clampReason: "model-not-reasoning" };
		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toEqual(clamped);
		expect(lastThinkingEntrySelection(session)).toEqual(clamped);
		expect(session.startupThinkingClamp).toEqual({
			provider: PROVIDER,
			modelId: "plain-model",
			requestedLevel: "high",
			appliedLevel: "off",
			reason: "model-not-reasoning",
		});
	});

	it("records no clamp fields when the model is marked reasoning", async () => {
		const session = await startSession("reasoning-model", "high");

		expect(session.thinkingSelection).toEqual({ level: "high", source: "explicit" });
		expect(lastThinkingEntrySelection(session)).toEqual({ level: "high", source: "explicit" });
		expect(session.startupThinkingClamp).toBeUndefined();
	});

	it("does not treat an unrequested default as a clamp", async () => {
		const session = await startSession("plain-model");

		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toBeUndefined();
		expect(session.startupThinkingClamp).toBeUndefined();
	});

	it("does not treat the global default thinking level as a clamp request at startup", async () => {
		const session = await startSession("plain-model", undefined, { defaultThinkingLevel: "high" });

		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toEqual({ level: "off", source: "explicit" });
		expect(session.startupThinkingClamp).toBeUndefined();
	});

	it("does not warn when a model switch clamps the global default thinking level", async () => {
		const session = await startSession("reasoning-model", undefined, { defaultThinkingLevel: "high" });
		const events = clampEvents(session);

		await session.setModel(session.modelRegistry.find(PROVIDER, "plain-model") as Model<Api>);

		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toEqual({ level: "off", source: "explicit" });
		expect(events).toEqual([]);
	});

	it("still warns when a model switch clamps a remembered per-model level", async () => {
		const session = await startSession("reasoning-model", undefined, {
			modelThinkingLevels: { [`${PROVIDER}/plain-model`]: "high" },
		});
		const events = clampEvents(session);

		await session.setModel(session.modelRegistry.find(PROVIDER, "plain-model") as Model<Api>);

		expect(events).toEqual([
			{
				type: "thinking_level_clamped",
				provider: PROVIDER,
				modelId: "plain-model",
				requestedLevel: "high",
				appliedLevel: "off",
				reason: "model-not-reasoning",
			},
		]);
	});

	it("warns once per clamped request after startup", async () => {
		const session = await startSession("plain-model");
		const events = clampEvents(session);

		session.setThinkingLevel("high");
		session.setThinkingLevel("high");
		session.setSessionThinkingLevel("medium");

		const warning = {
			type: "thinking_level_clamped",
			provider: PROVIDER,
			modelId: "plain-model",
			appliedLevel: "off",
		};
		expect(events).toEqual([
			{ ...warning, requestedLevel: "high", reason: "model-not-reasoning" },
			{ ...warning, requestedLevel: "medium", reason: "model-not-reasoning" },
		]);
		expect(lastThinkingEntrySelection(session)).toEqual({
			level: "off",
			source: "explicit",
			requested: "medium",
			clampReason: "model-not-reasoning",
		});
	});

	it("does not warn again for a request already clamped at startup", async () => {
		const session = await startSession("plain-model", "high");
		const events = clampEvents(session);

		session.setThinkingLevel("high");

		expect(events).toEqual([]);
		expect(session.thinkingSelection).toEqual({
			level: "off",
			source: "explicit",
			requested: "high",
			clampReason: "model-not-reasoning",
		});
	});

	it("drops the clamp fields once an explicit request is applied as asked", async () => {
		const session = await startSession("plain-model", "high");

		session.setThinkingLevel("off");

		expect(session.thinkingSelection).toEqual({ level: "off", source: "explicit" });
		expect(lastThinkingEntrySelection(session)).toEqual({ level: "off", source: "explicit" });
	});
});
