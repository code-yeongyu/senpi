import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { runSetModel } from "../../src/modes/rpc/effect-commands.ts";
import { EffectLedger } from "../../src/modes/rpc/effect-ledger.ts";
import { lookupEffectInTranscript } from "../../src/modes/rpc/effect-transcript-lookup.ts";
import { RpcSessionRegistry } from "../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "./harness.ts";

// The #1873 deferred-switch geometry: the transcript fits the current model but not the target.
describe("RPC held model effect settlement", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});
	const setup = async (refuseAfterRepair = false, sessionManager?: SessionManager) => {
		const harness = await createHarness({
			sessionManager,
			persistSession: true,
			autoTitleSessions: false,
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
				{ id: "360k", contextWindow: 360_000, maxTokens: 32_000 },
				{ id: "900k", contextWindow: 900_000, maxTokens: 32_000 },
				{ id: "tiny", contextWindow: 16_000, maxTokens: 4_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) =>
						refuseAfterRepair && event.model.id === "372k"
							? { systemPrompt: "oversized fixed prefix ".repeat(400_000) }
							: undefined,
					);
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
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "large live context ".repeat(30_000) }],
			timestamp: Date.now() - 1,
		});
		const earlier = fauxAssistantMessage("earlier");
		harness.sessionManager.appendMessage({
			...earlier,
			usage: { ...earlier.usage, input: 320_000, output: 1_000, totalTokens: 321_000 },
		});
		harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		return harness;
	};
	const switchTo = (harness: Harness, modelId: string, effectId: string) => {
		const model = harness.getModel(modelId);
		if (!model) throw new Error(`missing fixture ${modelId}`);
		return runSetModel(
			{ session: harness.session, by: { connectionId: "operator" } },
			{ type: "set_model", provider: model.provider, modelId, effectId },
		);
	};

	it.each(["held overwrite", "direct switch", "cycle"])("fails a superseded effect on %s", async (path) => {
		const harness = await setup();
		await switchTo(harness, "372k", "held");
		const ledger = EffectLedger.forSession(harness.session);
		expect(ledger.status("held")).toMatchObject({ state: "accepted" });
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		if (path === "cycle") {
			const current = harness.getModel("million");
			const roomy = harness.getModel("900k");
			if (!current || !roomy) throw new Error("missing cycle fixtures");
			harness.session.setFavoriteModels([{ model: current }, { model: roomy }]);
			await harness.session.cycleModel();
		} else {
			await switchTo(harness, path === "held overwrite" ? "360k" : "900k", "newer");
		}
		expect(ledger.status("held")).toMatchObject({
			state: "failed",
			outcome: { kind: "superseded", reason: "superseded", action: expect.any(String) },
		});
		expect(await switchTo(harness, "372k", "held")).toMatchObject({
			success: true,
			data: { replayed: true, state: "failed" },
		});
	});

	// senpi#3199: replacement must settle the outgoing receipt before disposing its writer.
	it.each(["new_session", "switch_session", "fork"] as const)(
		"fails a held effect in its outgoing transcript on %s",
		async (path) => {
			const base = await setup();
			let current: Harness | undefined;
			const registry = new RpcSessionRegistry({
				agentDir: base.session.agentDir,
				createRuntime: async (options) => {
					const harness = await setup(false, options.sessionManager);
					current = harness;
					return {
						session: harness.session,
						extensionsResult: harness.session.resourceLoader.getExtensions(),
						diagnostics: [],
						services: {
							cwd: options.cwd,
							agentDir: options.agentDir,
							authStorage: harness.authStorage,
							modelRegistry: harness.modelRegistry,
							modelRuntime: harness.session.modelRuntime,
							settingsManager: harness.settingsManager,
							resourceLoader: harness.session.resourceLoader,
							diagnostics: [],
						},
					};
				},
			});
			const opened = await registry.openSession({ cwd: base.tempDir });
			try {
				const harness = current;
				const runtime = registry.peek(opened.sessionId)?.runtime;
				if (!harness || !runtime || !opened.sessionPath) throw new Error("missing replacement fixture");
				await switchTo(harness, "372k", "held");
				const ledger = EffectLedger.forSession(harness.session);
				expect(ledger.status("held")).toMatchObject({ state: "accepted" });
				const user = harness.sessionManager
					.getEntries()
					.find((entry) => entry.type === "message" && entry.message.role === "user");
				if (!user) throw new Error("missing fork entry");

				if (path === "new_session") await runtime.newSession();
				else if (path === "fork") await runtime.fork(user.id);
				else {
					const target = SessionManager.create(harness.tempDir);
					await target.persistHeaderNow();
					const targetPath = target.getSessionFile();
					if (!targetPath) throw new Error("missing switch target");
					await runtime.switchSession(targetPath);
				}

				const expected = {
					state: "failed",
					outcome: {
						kind: "dropped_by_replace",
						reason: "dropped_by_replace",
						detail: expect.any(String),
						action: expect.any(String),
					},
				};
				expect(ledger.status("held")).toMatchObject(expected);
				expect(await lookupEffectInTranscript(opened.sessionPath, "held")).toMatchObject({
					found: true,
					effect: expected,
				});
			} finally {
				await registry.close(opened.sessionId);
			}
		},
	);

	it("fails a held effect when the repaired target refuses its budget", async () => {
		const harness = await setup();
		await switchTo(harness, "372k", "held");
		// The fixed prefix grows after admission; no transcript reduction can repair it.
		harness.agent.state.systemPrompt = "oversized fixed prefix ".repeat(400_000);
		harness.setResponses([fauxAssistantMessage("unused")]);
		await expect(harness.session.prompt("continue")).rejects.toMatchObject({ name: "ModelUsabilityBudgetError" });
		expect(EffectLedger.forSession(harness.session).status("held")).toMatchObject({
			state: "failed",
			outcome: { kind: "context_budget", reason: "context_budget", action: expect.any(String) },
		});
	});

	it("classifies an immediate budget refusal without suggesting provider login", async () => {
		const harness = await setup();
		expect(await switchTo(harness, "tiny", "budget")).toMatchObject({
			success: false,
			errorCode: "context_budget",
			errorData: { effect: { state: "failed", outcome: { kind: "context_budget" } } },
		});
	});

	it("fails a repaired held effect when the model-select hook refuses the budget", async () => {
		const harness = await setup(true);
		await switchTo(harness, "372k", "held");
		harness.setResponses([fauxAssistantMessage("unused")]);
		await expect(harness.session.prompt("continue")).rejects.toMatchObject({ name: "ModelUsabilityBudgetError" });
		expect(EffectLedger.forSession(harness.session).status("held")).toMatchObject({
			state: "failed",
			outcome: { kind: "context_budget" },
		});
	});

	it("lets unknown model switch errors propagate without a false auth diagnosis", async () => {
		const harness = await setup();
		const error = new TypeError("broken extension");
		harness.session.setModel = async () => {
			throw error;
		};
		await expect(switchTo(harness, "900k", "unknown")).rejects.toBe(error);
		expect(EffectLedger.forSession(harness.session).status("unknown")).toMatchObject({
			state: "failed",
			outcome: { kind: "error", reason: "error", detail: error.message, action: expect.any(String) },
		});
	});

	it("fails a repaired held effect before rethrowing an unknown selection error", async () => {
		const harness = await setup();
		await switchTo(harness, "372k", "held");
		const error = new TypeError("broken model selection");
		const runner = harness.session.extensionRunner;
		vi.spyOn(runner, "emitModelSelect").mockImplementation(async () => {
			throw error;
		});
		harness.setResponses([fauxAssistantMessage("unused")]);

		await expect(harness.session.prompt("continue")).rejects.toBe(error);

		expect(EffectLedger.forSession(harness.session).status("held")).toMatchObject({
			state: "failed",
			outcome: { kind: "error", reason: "error", detail: error.message, action: expect.any(String) },
		});
	});

	it("keeps the login remedy for an actual credential refusal", async () => {
		const harness = await setup();
		harness.session.modelRuntime.checkAuth = async () => undefined;
		expect(await switchTo(harness, "900k", "auth")).toMatchObject({
			success: false,
			errorCode: "provider_unavailable",
			errorData: { effect: { state: "failed", outcome: { kind: "provider_unavailable" } } },
		});
	});

	it("completes a held effect when compaction applies its own switch", async () => {
		const harness = await setup();
		await switchTo(harness, "372k", "held");
		harness.setResponses([fauxAssistantMessage("answered")]);
		await harness.session.prompt("continue");
		expect(EffectLedger.forSession(harness.session).status("held")).toMatchObject({
			state: "done",
			disposition: "applied",
		});
	});
});
