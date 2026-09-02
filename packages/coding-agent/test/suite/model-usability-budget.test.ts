import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "large live context ".repeat(30_000) }],
		timestamp: timestamp - 3,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "earlier response" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 150_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 151_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: timestamp - 2,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "still working" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("model usability budget", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("rejects a selected model whose context cannot hold the assembled session budget", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "primary", contextWindow: 128_000, maxTokens: 4_000 },
				{ id: "low-context", contextWindow: 16_000, maxTokens: 4_000 },
			],
		});
		harnesses.push(harness);
		harness.agent.state.systemPrompt = "x";
		const lowContextModel = harness.getModel("low-context");
		if (!lowContextModel) throw new Error("missing low-context model fixture");

		// when
		const error = await harness.session.setModel(lowContextModel).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		// then
		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected model budget rejection");
		expect(error.message).toBe(
			'Model "faux/low-context" cannot start: context window 16000 tokens is 21464 tokens short of the 37464-token minimum (system prompt 1, active tool schemas 695, output reserve 4000, compaction reserve 16384, speculation lead 8192, safety margin 8192 [default]).',
		);
	});

	it("rejects a downswitch before committing when live context exceeds the target budget", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing downswitch target fixture");
		seedLiveContext(harness, 321_000);

		// when
		const error = await harness.session.setModel(target).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		// then
		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected downswitch budget rejection");
		expect(error.projection).toMatchObject({
			model: "faux/372k",
			contextWindow: 372_000,
			outputReserveTokens: 32_000,
			compactionReserveTokens: 16_384,
			safetyMarginTokens: 8_192,
			usable: false,
		});
		expect(error.projection.liveContextTokens).toBeGreaterThanOrEqual(318_380);
		expect(error.projection.liveContextTokens).toBeLessThanOrEqual(318_410);
		expect(error.projection.speculationLeadTokens).toBeGreaterThan(0);
		expect(error.projection.requiredTokens).toBe(
			error.projection.liveContextTokens +
				error.projection.systemPromptTokens +
				error.projection.activeToolSchemaTokens +
				error.projection.outputReserveTokens +
				error.projection.compactionReserveTokens +
				error.projection.speculationLeadTokens +
				error.projection.safetyMarginTokens,
		);
		expect(harness.session.model?.id).toBe("million");
		expect(harness.settingsManager.getDefaultModel()).not.toBe("372k");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("accepts a downswitch when live context fits the target budget", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 200_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing accepted downswitch target fixture");

		// when
		await harness.session.setModel(target);

		// then
		expect(harness.session.model?.id).toBe("372k");
	});

	it("revalidates and accepts a rejected downswitch after explicit compaction", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compact summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing compact-retry target fixture");
		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		// when
		await harness.session.compact();
		await harness.session.setModel(target);

		// then
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(1);
	});

	it("rejects an unusable initial model after SDK session assembly", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = { ...harness.getModel(), contextWindow: 16_000, maxTokens: 4_000 };

		// when / then
		await expect(
			createAgentSession({ cwd: harness.tempDir, agentDir: join(harness.tempDir, "sdk-agent"), model }),
		).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: `${model.provider}/${model.id}`,
				usable: false,
				contextWindow: 16_000,
			},
		});
	});

	it("recovers an oversized implicit saved-model restore onto the candidate with the largest remaining budget", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "saved-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "usable-medium", contextWindow: 600_000, maxTokens: 32_000 },
				{ id: "usable-largest", contextWindow: 1_000_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "saved-small");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});
		const originalEntries = sessionManager.getEntries();

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			authStorage: harness.authStorage,
			modelRuntime: harness.session.modelRuntime,
			sessionManager,
			settingsManager: harness.settingsManager,
			noTools: "all",
		});

		// then
		expect(resumed.session.model?.id).toBe("usable-largest");
		expect(resumed.modelFallbackMessage).toContain("faux/saved-small");
		expect(resumed.modelFallbackMessage).toContain("faux/usable-largest");
		expect(sessionManager.getEntries().slice(0, originalEntries.length)).toEqual(originalEntries);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ provider: "faux", modelId: "saved-small" },
			{
				provider: "faux",
				modelId: "usable-largest",
				originalProvider: "faux",
				originalModelId: "saved-small",
			},
		]);
		resumed.session.dispose();
	});

	it("skips an unauthenticated largest candidate and recovers onto the next capable provider", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "saved-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "candidate-medium", contextWindow: 600_000, maxTokens: 32_000 },
				{ id: "candidate-largest", contextWindow: 1_000_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "saved-small");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});
		const modelRuntime = harness.session.modelRuntime;
		const saved = harness.getModel("saved-small");
		const mediumSource = harness.getModel("candidate-medium");
		const largestSource = harness.getModel("candidate-largest");
		if (!saved || !mediumSource || !largestSource) throw new Error("missing auth recovery model fixture");
		const medium = { ...mediumSource, provider: "available-provider" };
		const largest = { ...largestSource, provider: "expired-provider" };
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([saved, medium, largest]);
		const checkAuth = vi
			.spyOn(modelRuntime, "checkAuth")
			.mockImplementation(async (provider) => (provider === "available-provider" ? { type: "api_key" } : undefined));

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			authStorage: harness.authStorage,
			modelRuntime,
			sessionManager,
			settingsManager: harness.settingsManager,
			noTools: "all",
		});

		// then
		expect(checkAuth.mock.calls.map(([provider]) => provider)).toEqual(["expired-provider", "available-provider"]);
		expect(resumed.session.model).toMatchObject({ provider: "available-provider", id: "candidate-medium" });
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ provider: "faux", modelId: "saved-small" },
			{
				provider: "available-provider",
				modelId: "candidate-medium",
				originalProvider: "faux",
				originalModelId: "saved-small",
			},
		]);
		resumed.session.dispose();
	});

	it("continues after a larger candidate fails post-select budget admission", async () => {
		// given
		initTheme("dark");
		const harness = await createHarness({
			models: [
				{ id: "saved-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "candidate-medium", contextWindow: 600_000, maxTokens: 32_000 },
				{ id: "candidate-largest", contextWindow: 1_000_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("model_select", (event) =>
						event.model.id === "candidate-largest"
							? { systemPrompt: "oversized model prompt ".repeat(300_000) }
							: undefined,
					);
				},
			],
			harness.tempDir,
		);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "saved-small");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});
		const authCheck = vi.spyOn(harness.session.modelRuntime, "checkAuth");

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			authStorage: harness.authStorage,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			sessionManager,
			settingsManager: harness.settingsManager,
			noTools: "all",
		});

		// then
		expect(resumed.session.model).toMatchObject({ id: "candidate-medium" });
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ provider: "faux", modelId: "saved-small" },
			{ provider: "faux", modelId: "candidate-medium" },
		]);
		expect(authCheck.mock.calls.filter(([provider]) => provider === "faux")).toHaveLength(1);
		resumed.session.dispose();
	});

	it("rolls back rejected candidate tools and extension state before trying the next model", async () => {
		// given
		initTheme("dark");
		const harness = await createHarness({
			models: [
				{ id: "saved-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "candidate-medium", contextWindow: 600_000, maxTokens: 32_000 },
				{ id: "candidate-largest", contextWindow: 1_000_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const selections: Array<{ id: string; provisional: boolean | undefined }> = [];
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					let rejectedCandidateState = false;
					pi.registerTool({
						name: "stable-tool",
						label: "Stable tool",
						description: "Tool for the restored and accepted models",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "stable" }], details: {} }),
					});
					pi.registerTool({
						name: "candidate-tool",
						label: "Candidate tool",
						description: "Tool exposed only by the rejected candidate",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "candidate" }], details: {} }),
					});
					pi.on("session_start", () => {
						pi.setActiveTools(["stable-tool"]);
					});
					pi.on("model_select", (event) => {
						selections.push({ id: event.model.id, provisional: event.provisional });
						if (event.model.id === "candidate-largest") {
							rejectedCandidateState = true;
							pi.setActiveTools(["candidate-tool"]);
							return { systemPrompt: "oversized model prompt ".repeat(300_000) };
						}
						if (event.model.id === "saved-small") {
							rejectedCandidateState = false;
							pi.setActiveTools(["stable-tool"]);
							return undefined;
						}
						if (event.model.id === "candidate-medium" && rejectedCandidateState) {
							return { systemPrompt: "leaked extension state ".repeat(300_000) };
						}
						return undefined;
					});
				},
			],
			harness.tempDir,
		);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "saved-small");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			authStorage: harness.authStorage,
			modelRuntime: harness.session.modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			sessionManager,
			settingsManager: harness.settingsManager,
			tools: ["stable-tool"],
		});

		// then
		expect(resumed.session.model).toMatchObject({ id: "candidate-medium" });
		expect(resumed.session.getActiveToolNames()).toEqual(["stable-tool"]);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ provider: "faux", modelId: "saved-small" },
			{ provider: "faux", modelId: "candidate-medium" },
		]);
		expect(selections).toEqual([
			{ id: "candidate-largest", provisional: true },
			{ id: "saved-small", provisional: true },
			{ id: "candidate-medium", provisional: true },
			{ id: "candidate-medium", provisional: undefined },
		]);
		resumed.session.dispose();
	});

	it("rejects a resumed session whose restored transcript exceeds the startup budget", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "startup", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "startup");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(200_000) }],
			timestamp: Date.now(),
		});

		// when / then
		const error = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			authStorage: harness.authStorage,
			modelRuntime: harness.session.modelRuntime,
			sessionManager,
			settingsManager: harness.settingsManager,
			noTools: "all",
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toMatchObject({
			name: "SessionResumeModelUnavailableError",
			message:
				"Cannot resume this session: no authenticated model has enough usable context budget for the restored history. " +
				"Configure a larger-context model or start a new session.",
			projection: {
				model: "faux/startup",
				liveContextTokens: expect.any(Number),
				usable: false,
			},
		});
	});

	it("keeps an explicit oversized startup model strict instead of selecting a recovery model", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "explicit-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "available-large", contextWindow: 1_000_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "available-large");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});

		// when / then
		await expect(
			createAgentSession({
				cwd: harness.tempDir,
				agentDir: join(harness.tempDir, "sdk-agent"),
				authStorage: harness.authStorage,
				model: harness.getModel("explicit-small"),
				modelRuntime: harness.session.modelRuntime,
				sessionManager,
				settingsManager: harness.settingsManager,
				noTools: "all",
			}),
		).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: "faux/explicit-small",
				usable: false,
			},
		});
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toMatchObject([
			{ provider: "faux", modelId: "available-large" },
		]);
	});

	it("does not persist a recovery model when model-select admission rejects it", async () => {
		// given
		initTheme("dark");
		const harness = await createHarness({
			models: [
				{ id: "saved-small", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "candidate-large", contextWindow: 600_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendModelChange("faux", "saved-small");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(80_000) }],
			timestamp: Date.now(),
		});
		const originalModelChanges = sessionManager.getEntries().filter((entry) => entry.type === "model_change");
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi) => {
					pi.on("model_select", () => ({ systemPrompt: "oversized model prompt ".repeat(80_000) }));
				},
			],
			harness.tempDir,
		);

		// when / then
		await expect(
			createAgentSession({
				cwd: harness.tempDir,
				agentDir: join(harness.tempDir, "sdk-agent"),
				authStorage: harness.authStorage,
				modelRuntime: harness.session.modelRuntime,
				resourceLoader: createTestResourceLoader({ extensionsResult }),
				sessionManager,
				settingsManager: harness.settingsManager,
				noTools: "all",
			}),
		).rejects.toBeInstanceOf(ModelUsabilityBudgetError);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual(
			originalModelChanges,
		);
		expect(sessionManager.getEntries().filter((entry) => entry.type === "thinking_level_change")).toHaveLength(1);
	});

	it("keeps fresh and fitting resumed sessions accepted", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "startup", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		harnesses.push(harness);
		const model = harness.getModel();

		// when / then
		const fresh = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "fresh-agent"),
			model,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		expect(fresh.session.agent.state.messages).toHaveLength(0);
		fresh.session.dispose();

		const fittingSessionManager = SessionManager.inMemory(harness.tempDir);
		fittingSessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "small restored transcript" }],
			timestamp: Date.now(),
		});
		const fitting = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "fitting-agent"),
			model,
			sessionManager: fittingSessionManager,
		});
		expect(fitting.session.agent.state.messages).toHaveLength(1);
		fitting.session.dispose();
	});

	it("accepts the exact minimum and rejects one token below it", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = harness.getModel();
		const compaction = harness.settingsManager.getCompactionSettings();
		// when
		const atBoundary = projectModelUsabilityBudget({
			model: { ...model, contextWindow: 36_769, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction,
		});
		const belowBoundary = projectModelUsabilityBudget({
			model: { ...model, contextWindow: 36_768, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction,
		});
		// then
		expect(atBoundary).toMatchObject({ usable: true, requiredTokens: 36_769, shortfallTokens: 0 });
		expect(belowBoundary).toMatchObject({ usable: false, requiredTokens: 36_769, shortfallTokens: 1 });
	});

	it("preserves disabled compaction and speculation opt-outs", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = { ...harness.getModel(), contextWindow: 20_000, maxTokens: 4_000 };
		const settings = harness.settingsManager.getCompactionSettings();
		// when
		const disabled = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			compaction: { ...settings, enabled: false },
		});
		const speculationDisabled = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			compaction: {
				...settings,
				reserveTokens: 1_000,
				reserveScalingEnabled: false,
				speculativeEnabled: false,
			},
		});
		// then
		expect(disabled).toMatchObject({ compactionReserveTokens: 0, speculationLeadTokens: 0, usable: true });
		expect(speculationDisabled).toMatchObject({
			compactionReserveTokens: 1_000,
			speculationLeadTokens: 0,
			usable: true,
		});
	});

	it("selects a safety margin from model-family data", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		// when
		const projection = projectModelUsabilityBudget({
			model: { ...harness.getModel(), id: "vendor/claude-small", contextWindow: 64_000, maxTokens: 4_000 },
			systemPrompt: "x",
			tools: [],
			compaction: harness.settingsManager.getCompactionSettings(),
		});
		// then
		expect(projection).toMatchObject({ safetyMarginProfile: "anthropic", safetyMarginTokens: 16_384 });
	});
});
