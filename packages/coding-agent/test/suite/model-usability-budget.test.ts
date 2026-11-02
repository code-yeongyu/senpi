import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ModelUsabilityBudgetError,
	projectModelUsabilityBudget,
} from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { fallbackCircuitsFor } from "../../src/core/retry-fallback/circuit.ts";
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
		// #1526: `setModel` derives the admission from the session instead of
		// declaring a switch, so an empty session keeps the cold-start contract - the
		// switch wording would promise a compaction remedy with nothing to compact.
		expect(error.projection.admission).toBe("start");
		// #1678: the restored default grep, rebuilt on the engine contract, adds 240
		// schema units. D-15: the adopted structured bash result declares its
		// `outputSchema` on the tool, which the tool estimate counts (+134 units).
		// Assert the machine projection rather than pinning the human-readable
		// error sentence.
		expect(error.projection).toMatchObject({
			model: "faux/low-context",
			contextWindow: 16_000,
			liveContextTokens: 0,
			systemPromptTokens: 1,
			activeToolSchemaTokens: 1_132,
			outputReserveTokens: 4_000,
			compactionReserveTokens: 16_384,
			speculationLeadTokens: 8_192,
			safetyMarginTokens: 8_192,
			safetyMarginProfile: "default",
			requiredTokens: 37_901,
			shortfallTokens: 21_901,
			usable: false,
		});
	});

	it("classifies admission as fits-now, fits-after-compaction, or impossible (#1873)", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
				{ id: "overhead-bound", contextWindow: 16_000, maxTokens: 4_000 },
			],
		});
		harnesses.push(harness);
		const compaction = harness.session.settingsManager.getCompactionSettings();
		const systemPrompt = harness.session.agent.state.systemPrompt;
		const tools = harness.session.agent.state.tools;
		const target = harness.getModel("372k");
		const overheadBound = harness.getModel("overhead-bound");
		if (!target || !overheadBound) throw new Error("missing verdict fixtures");

		// when: the same model is projected against a live context it can hold, one it
		// cannot hold until the transcript is reduced, and a window whose fixed overhead
		// alone leaves no room for any transcript at all.
		const headroom =
			target.contextWindow -
			projectModelUsabilityBudget({ model: target, systemPrompt, tools, compaction }).requiredTokens;
		const fitsNow = projectModelUsabilityBudget({
			model: target,
			systemPrompt,
			tools,
			liveContextTokens: Math.floor(headroom / 2),
			compaction,
		});
		const needsCompaction = projectModelUsabilityBudget({
			model: target,
			systemPrompt,
			tools,
			liveContextTokens: headroom + 1_000,
			compaction,
		});
		const impossible = projectModelUsabilityBudget({
			model: overheadBound,
			systemPrompt,
			tools,
			liveContextTokens: 0,
			compaction,
		});

		// then: the verdict separates "repairable by reducing the transcript" from
		// "this model can never serve this session", so only the latter may refuse.
		expect(fitsNow.verdict).toBe("fits-now");
		expect(fitsNow.usable).toBe(true);
		expect(needsCompaction.verdict).toBe("fits-after-compaction");
		expect(needsCompaction.usable).toBe(false);
		expect(impossible.verdict).toBe("impossible");
		expect(impossible.usable).toBe(false);
	});

	it("admits a switch that only the speculation lead would have rejected (#1873)", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
		});
		harnesses.push(harness);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing lead-parity switch target fixture");
		const compaction = harness.session.settingsManager.getCompactionSettings();
		const systemPrompt = harness.session.agent.state.systemPrompt;
		const tools = harness.session.agent.state.tools;
		const withoutLead = projectModelUsabilityBudget({
			model: target,
			systemPrompt,
			tools,
			compaction,
			includeSpeculationLead: false,
		});
		const withLead = projectModelUsabilityBudget({
			model: target,
			systemPrompt,
			tools,
			compaction,
			includeSpeculationLead: true,
		});
		expect(withLead.speculationLeadTokens).toBeGreaterThan(1_000);

		// A live context that clears the budget once the lead is not charged, and that
		// only the lead pushes over the window. #1339 removed the lead from resume
		// admission because speculation cannot shrink history it has not admitted yet;
		// the same holds for a switch, which only has to fit the next single request.
		const liveContextTokens = target.contextWindow - withoutLead.requiredTokens - 1_000;
		expect(liveContextTokens).toBeGreaterThan(target.contextWindow - withLead.requiredTokens);
		seedLiveContext(harness, liveContextTokens + withoutLead.systemPromptTokens + withoutLead.activeToolSchemaTokens);

		// when
		await harness.session.setModel(target);

		// then
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(1);
	});

	it("holds a downswitch before committing when live context exceeds the target budget", async () => {
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
		await harness.session.setModel(target);

		// then: #1873 holds the switch instead of discarding it, and the projection it
		// was held on still describes the same shortfall the refusal used to report.
		const pending = harness.session.pendingModelSwitch;
		if (!pending) throw new Error("expected the downswitch to be held");
		expect(pending.projection).toMatchObject({
			model: "faux/372k",
			contextWindow: 372_000,
			outputReserveTokens: 32_000,
			compactionReserveTokens: 16_384,
			safetyMarginTokens: 8_192,
			usable: false,
			verdict: "fits-after-compaction",
		});
		const error = { projection: pending.projection };
		// The usage estimate includes the current prompt and schemas; live messages
		// exclude them exactly, including restored grep's schema and guidance.
		expect(error.projection.liveContextTokens).toBe(
			321_000 - error.projection.systemPromptTokens - error.projection.activeToolSchemaTokens,
		);
		// #1873: a switch no longer charges the speculation lead, so the rejection
		// here is the transcript genuinely not fitting rather than the lead margin.
		// The shortfall must therefore survive without the lead in the requirement.
		expect(error.projection.speculationLeadTokens).toBe(0);
		expect(error.projection.verdict).toBe("fits-after-compaction");
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

	it("accepts a downswitch outright once an explicit compaction has made room", async () => {
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

		// when: the transcript is reduced first, so the switch needs no deferral
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
		const agentDir = join(harness.tempDir, "sdk-agent");
		const breaker = fallbackCircuitsFor(agentDir);

		// when / then
		await expect(createAgentSession({ cwd: harness.tempDir, agentDir, model })).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				model: `${model.provider}/${model.id}`,
				usable: false,
				contextWindow: 16_000,
			},
		});
		// then: the refused session keeps no hold on the agent dir's fallback breaker
		fallbackCircuitsFor(`${agentDir}-unrelated`);
		expect(fallbackCircuitsFor(agentDir)).not.toBe(breaker);
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
				admission: "resume",
				speculationLeadTokens: 0,
			},
		});
		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected resume budget rejection");
		expect(error.message).toContain("cannot resume");
		expect(error.message).not.toContain("cannot switch");
		expect(error.message).not.toContain("retry the model switch");
	});

	it("resumes a restored transcript that only the speculation lead would have rejected", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "startup", contextWindow: 1_050_000, maxTokens: 128_000 }],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const probe = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "resume-lead-probe"),
			model,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		const compaction = probe.session.settingsManager.getCompactionSettings();
		const empty = projectModelUsabilityBudget({
			model,
			systemPrompt: probe.session.agent.state.systemPrompt,
			tools: probe.session.agent.state.tools,
			compaction,
			includeSpeculationLead: false,
			admission: "resume",
		});
		const withLead = projectModelUsabilityBudget({
			model,
			systemPrompt: probe.session.agent.state.systemPrompt,
			tools: probe.session.agent.state.tools,
			compaction,
			includeSpeculationLead: true,
			admission: "resume",
		});
		const systemPrompt = probe.session.agent.state.systemPrompt;
		const tools = probe.session.agent.state.tools;
		probe.session.dispose();
		expect(withLead.speculationLeadTokens).toBeGreaterThan(1_000);
		const liveContextTokens = model.contextWindow - empty.requiredTokens - withLead.speculationLeadTokens + 1_000;
		expect(liveContextTokens).toBeGreaterThan(0);
		expect(
			projectModelUsabilityBudget({
				model,
				systemPrompt,
				tools,
				liveContextTokens,
				compaction,
				includeSpeculationLead: true,
				admission: "resume",
			}).usable,
		).toBe(false);
		expect(
			projectModelUsabilityBudget({
				model,
				systemPrompt,
				tools,
				liveContextTokens,
				compaction,
				includeSpeculationLead: false,
				admission: "resume",
			}).usable,
		).toBe(true);
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		sessionManager.appendMessage({
			role: "user",
			// Spaces break the base64-run weighting so chars/4 stays 1:1 with liveContextTokens.
			content: [{ type: "text", text: "! ".repeat(liveContextTokens * 2) }],
			timestamp: Date.now(),
		});

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "resume-lead-gap"),
			model,
			sessionManager,
		});

		// then
		expect(resumed.session.agent.state.messages).toHaveLength(1);
		resumed.session.dispose();
	});

	it("resumes a restored transcript whose uncompacted context requires compaction to hold output reserves", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "astra-shaped", contextWindow: 400_000, maxTokens: 128_000 }],
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const liveTokens = 346_286;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "! ".repeat(liveTokens * 2) }],
			timestamp: Date.now(),
		});

		// when
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "astra-resume"),
			model,
			sessionManager,
		});

		// then
		expect(resumed.session.agent.state.messages).toHaveLength(1);
		resumed.session.dispose();
	});

	it("rejects an uncompacted transcript on resume when compaction is disabled", async () => {
		// given
		const harness = await createHarness({
			models: [{ id: "astra-shaped", contextWindow: 400_000, maxTokens: 128_000 }],
			settings: { compaction: { enabled: false } },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const liveTokens = 346_286;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "! ".repeat(liveTokens * 2) }],
			timestamp: Date.now(),
		});

		// when / then
		await expect(
			createAgentSession({
				cwd: harness.tempDir,
				agentDir: join(harness.tempDir, "astra-disabled-resume"),
				model,
				sessionManager,
				settingsManager: harness.settingsManager,
			}),
		).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: {
				usable: false,
				admission: "resume",
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

	it("omits speculation lead from a restored-transcript projection when asked", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		const model = { ...harness.getModel(), contextWindow: 1_050_000, maxTokens: 128_000 };
		const compaction = harness.settingsManager.getCompactionSettings();
		const liveContextTokens = 850_000;

		// when
		const charged = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			liveContextTokens,
			compaction,
			admission: "resume",
		});
		const omitted = projectModelUsabilityBudget({
			model,
			systemPrompt: "x",
			tools: [],
			liveContextTokens,
			compaction,
			includeSpeculationLead: false,
			admission: "resume",
		});

		// then
		expect(charged.speculationLeadTokens).toBeGreaterThan(0);
		expect(omitted).toMatchObject({
			speculationLeadTokens: 0,
			admission: "resume",
			liveContextTokens,
		});
		expect(charged.requiredTokens - omitted.requiredTokens).toBe(charged.speculationLeadTokens);
		expect(charged.usable).toBe(false);
		expect(omitted.usable).toBe(true);
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
