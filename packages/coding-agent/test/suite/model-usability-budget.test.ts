import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
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

	it("rejects a resumed session whose restored transcript exceeds the startup budget", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "startup", contextWindow: 100_000, maxTokens: 4_000 }],
		});
		harnesses.push(harness);
		const sessionManager = harness.sessionManager;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "restored transcript ".repeat(200_000) }],
			timestamp: Date.now(),
		});
		const model = harness.getModel();

		// when / then
		const error = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "sdk-agent"),
			model,
			sessionManager,
		}).then(
			() => undefined,
			(reason: unknown) => reason,
		);
		expect(error).toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: `${model.provider}/${model.id}`,
				liveContextTokens: expect.any(Number),
				usable: false,
			},
		});
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
