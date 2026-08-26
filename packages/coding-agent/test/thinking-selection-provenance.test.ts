import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveStoredModelReference } from "../src/core/model-resolver.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";
import { createHarness } from "./suite/harness.ts";

const MODEL = getModel("openai-codex", "gpt-5.5")!;
const directories: string[] = [];

function setup() {
	const root = join(tmpdir(), `senpi-thinking-selection-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	directories.push(root);
	return { cwd, agentDir };
}

afterEach(() => {
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("thinking selection provenance", () => {
	it("does not invent a selection for the DEFAULT_THINKING_LEVEL fallback", async () => {
		const { cwd, agentDir } = setup();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});
		expect(session.thinkingLevel).toBe("medium");
		expect(session.thinkingSelection).toBeUndefined();
		expect(session.agent.state.thinkingSelection).toBeUndefined();
		session.dispose();
	});

	it("marks an explicit startup option as explicit", async () => {
		const { cwd, agentDir } = setup();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			thinkingLevel: "high",
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});
		expect(session.thinkingSelection).toEqual({ level: "high", source: "explicit" });
		session.dispose();
	});

	it("setThinkingLevel records and persists explicit provenance even when the effective level is unchanged", async () => {
		const { cwd, agentDir } = setup();
		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});
		session.setThinkingLevel("medium");
		expect(session.thinkingSelection).toEqual({ level: "medium", source: "explicit" });
		expect(sessionManager.getBranch().at(-1)).toMatchObject({
			type: "thinking_level_change",
			thinkingLevel: "medium",
			thinkingSelection: { level: "medium", source: "explicit" },
		});
		session.dispose();
	});

	it("keeps old Cursor synthetic off entries selection-free", async () => {
		const { cwd, agentDir } = setup();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("cursor", "gpt-5.5");
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		sessionManager.appendThinkingLevelChange("off");
		const cursorModel = {
			...MODEL,
			provider: "cursor",
			api: "cursor-agent",
			id: "gpt-5.5",
			name: "GPT 5.5",
			thinkingLevelMap: {
				off: "none",
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "extra-high",
				max: null,
			},
		};
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: cursorModel,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});
		expect(session.thinkingLevel).toBe("off");
		expect(session.thinkingSelection).toBeUndefined();
		session.dispose();
	});

	it("resumes model_change history through the legacy alias projection", async () => {
		const { cwd, agentDir } = setup();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("cursor", "claude-opus-5-thinking-high");
		sessionManager.appendThinkingLevelChange("off");
		sessionManager.appendMessage({ role: "user", content: "resume", timestamp: Date.now() });
		expect(sessionManager.buildSessionContext()).toMatchObject({
			model: { provider: "cursor", modelId: "claude-opus-5-thinking-high" },
			messages: [expect.objectContaining({ role: "user" })],
		});
		const authStorage = AuthStorage.inMemory({
			cursor: { type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000 },
		});
		const registry = await createInMemoryModelRegistry(authStorage);
		registry.registerProvider("cursor", {
			baseUrl: "https://api2.cursor.sh",
			api: "cursor-agent",
			models: [
				{
					id: "claude-opus-5-thinking",
					name: "Claude Opus 5 Thinking",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 300000,
					maxTokens: 64000,
					thinkingLevelMap: {
						off: null,
						minimal: null,
						low: "low",
						medium: "medium",
						high: "high",
						xhigh: "xhigh",
						max: "max",
					},
				},
			],
		});
		expect(registry.modelRuntime.getModel("cursor", "claude-opus-5-thinking")).toBeDefined();
		expect(registry.modelRuntime.hasConfiguredAuth("cursor")).toBe(true);
		expect(
			resolveStoredModelReference("cursor", "claude-opus-5-thinking-high", registry.modelRuntime)?.model.id,
		).toBe("claude-opus-5-thinking");
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: registry.modelRuntime,
			modelRegistry: registry,
			authStorage,
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager,
		});
		expect(registry.modelRuntime.getModel("cursor", "claude-opus-5-thinking")).toBeDefined();
		expect(registry.modelRuntime.hasConfiguredAuth("cursor")).toBe(true);
		expect(modelFallbackMessage).toBeUndefined();
		expect(session.model?.id).toBe("claude-opus-5-thinking");
		expect(session.thinkingLevel).toBe("high");
		expect(session.thinkingSelection).toEqual({
			level: "high",
			source: "legacy-variant",
			legacyVariantId: "claude-opus-5-thinking-high",
		});
		session.dispose();
	});

	it("keeps favorite thinkingSelection provenance while cycling", async () => {
		const harness = await createHarness({
			models: [
				{ id: "graded-a", reasoning: true },
				{ id: "graded-b", reasoning: true },
			],
		});
		const modelA = harness.getModel("graded-a")!;
		const modelB = harness.getModel("graded-b")!;
		harness.session.setFavoriteModels([
			{ model: modelA },
			{
				model: modelB,
				thinkingLevel: "low",
				thinkingSelection: { level: "low", source: "legacy-variant", legacyVariantId: "gpt-5.5-low" },
			},
		]);
		await harness.session.cycleModel();
		expect(harness.session.thinkingSelection).toEqual({
			level: "low",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.5-low",
		});
		harness.cleanup();
	});

	it("refreshes the next turn with a selection value and null-to-clear", async () => {
		const { cwd, agentDir } = setup();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: MODEL,
			thinkingLevel: "high",
			settingsManager: SettingsManager.create(cwd, agentDir),
			sessionManager: SessionManager.inMemory(cwd),
		});
		const prepare = session.agent.prepareNextTurnWithContext!;
		const turn = {
			message: {
				role: "assistant",
				content: [],
				api: MODEL.api,
				provider: MODEL.provider,
				model: MODEL.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
			toolResults: [],
			context: { systemPrompt: "", messages: [], tools: [] },
			newMessages: [],
		} as Parameters<typeof prepare>[0];
		expect(await prepare(turn)).toMatchObject({
			thinkingSelection: { level: "high", source: "explicit" },
		});
		session.agent.state.thinkingSelection = undefined;
		expect(await prepare(turn)).toMatchObject({ thinkingSelection: null });
		session.dispose();
	});
});
