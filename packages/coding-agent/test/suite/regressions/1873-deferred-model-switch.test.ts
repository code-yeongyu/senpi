import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { pendingSwitchKeepRecentTokens } from "../../../src/core/extensions/builtin/compaction/switch-admission.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness, type Harness } from "../harness.ts";

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

async function createDeferralHarness(): Promise<Harness> {
	return await createHarness({
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
}

describe("#1873 deferred model switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("accepts a switch that one compaction makes usable instead of refusing it", async () => {
		// given a transcript the target cannot hold yet
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing deferred switch target fixture");
		expect(buildRpcSessionState(harness.session).pendingModelSwitch).toBeNull();

		// when
		await harness.session.setModel(target);

		// then the switch is recorded as pending rather than thrown away
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		expect(buildRpcSessionState(harness.session).pendingModelSwitch).toEqual({
			provider: target.provider,
			id: target.id,
		});
		expect(harness.eventsOfType("model_change_pending")).toHaveLength(1);
	});

	it("writes nothing durable while the switch is pending", async () => {
		// given
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing pending-write fixture");

		// when
		await harness.session.setModel(target);

		// then the session is still on the model that can serve it, and the switch
		// has left no entry and no global default behind (#1526's ordering).
		expect(harness.session.model?.id).toBe("million");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(harness.settingsManager.getDefaultModel()).not.toBe("372k");
	});

	it("compacts with the original model on the next send, then applies the switch", async () => {
		// given
		const harness = await createDeferralHarness();
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing deferred repair fixture");
		await harness.session.setModel(target);
		harness.setResponses([fauxAssistantMessage("answered on the target model")]);

		// when the user sends the next message
		await harness.session.prompt("continue");

		// then the transcript was reduced first and the switch landed
		expect(harness.eventsOfType("compaction_start").length).toBeGreaterThan(0);
		expect(harness.session.model?.id).toBe("372k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		const changes = harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change");
		expect(changes).toHaveLength(1);
		// senpi#2870: the applied switch names itself held and names who first asked for it.
		expect(changes[0]).toMatchObject({ source: "held-switch", actor: "sdk" });
	});

	it("compacts on the original model, sized for the target's window", async () => {
		// given a harness that records which model each compaction ran on
		const keepRecentTargets: Array<number | undefined> = [];
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					// Observe the geometry only; real summarization still runs so the
					// provider call below records which model was asked for the summary.
					pi.on("session_before_compact", (event) => {
						keepRecentTargets.push(event.preparation.settings.keepRecentTokens);
					});
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("372k");
		if (!target) throw new Error("missing ordering fixture");
		await harness.session.setModel(target);
		const pendingKeepRecent = harness.session.pendingModelSwitch
			? pendingSwitchKeepRecentTokens(harness.session.pendingModelSwitch.projection)
			: undefined;
		const requestedOn: string[] = [];
		harness.setResponses([
			(_context, _options, _state, model) => {
				requestedOn.push(model.id);
				return fauxAssistantMessage("compact summary");
			},
			(_context, _options, _state, model) => {
				requestedOn.push(model.id);
				return fauxAssistantMessage("answered on the target model");
			},
		]);

		// when
		await harness.session.prompt("continue");

		// then the summary was requested from the model that could still hold the
		// transcript - not the target, which by definition could not - the turn that
		// followed ran on the target, and the reduction was sized for the target's
		// window rather than the current model's.
		const callLog = harness.faux.getCallLog().map((call) => call.modelId);
		expect(requestedOn[0]).toBe("million");
		expect(callLog[0]).toBe("million");
		// The message that triggered the repair is answered by the model the user
		// chose, not a turn later.
		expect(callLog.at(-1)).toBe("372k");
		expect(keepRecentTargets).toEqual([pendingKeepRecent]);
		expect(harness.session.model?.id).toBe("372k");
	});

	it("lets a later successful selection win over a held one", async () => {
		// given a held switch to a model that needs compaction first
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
				{ id: "900k", contextWindow: 900_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const held = harness.getModel("372k");
		const roomy = harness.getModel("900k");
		if (!held || !roomy) throw new Error("missing supersede fixture");
		await harness.session.setModel(held);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");

		// when a model that fits right now is chosen afterwards
		await harness.session.setModel(roomy);
		expect(buildRpcSessionState(harness.session).pendingModelSwitch).toBeNull();
		harness.setResponses([fauxAssistantMessage("answered on the roomy model")]);
		await harness.session.prompt("continue");

		// then the newer choice stands; the stale hold must not reclaim the session
		expect(harness.session.model?.id).toBe("900k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(buildRpcSessionState(harness.session).pendingModelSwitch).toBeNull();
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => (entry as { modelId: string }).modelId),
		).toEqual(["900k"]);
	});

	it("lets a successful cycle win over a held one", async () => {
		// given a held switch, and a favourite pair whose other member fits right now
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
				{ id: "900k", contextWindow: 900_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const current = harness.getModel("million");
		const held = harness.getModel("372k");
		const roomy = harness.getModel("900k");
		if (!current || !held || !roomy) throw new Error("missing cycle-supersede fixture");
		harness.session.setFavoriteModels([{ model: current }, { model: roomy }]);
		seedLiveContext(harness, 321_000);
		await harness.session.setModel(held);
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");

		// when the user cycles onto a model that needs no repair
		await harness.session.cycleModel("forward");
		expect(harness.session.model?.id).toBe("900k");
		harness.setResponses([fauxAssistantMessage("answered on the cycled model")]);
		await harness.session.prompt("continue");

		// then the cycle supersedes the hold; the older choice must not reclaim the send
		expect(harness.session.model?.id).toBe("900k");
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(buildRpcSessionState(harness.session).pendingModelSwitch).toBeNull();
		expect(
			harness.faux
				.getCallLog()
				.map((call) => call.modelId)
				.at(-1),
		).toBe("900k");
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "model_change")
				.map((entry) => (entry as { modelId: string }).modelId),
		).toEqual(["900k"]);
	});

	it("holds a cycle candidate one compaction would admit instead of refusing it", async () => {
		// given a favourite pair whose other member cannot hold the transcript yet
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "372k", contextWindow: 372_000, maxTokens: 32_000 },
			],
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const current = harness.getModel("million");
		const other = harness.getModel("372k");
		if (!current || !other) throw new Error("missing cycle fixture");
		harness.session.setFavoriteModels([{ model: current }, { model: other }]);
		seedLiveContext(harness, 321_000);

		// when the user cycles onto it
		await harness.session.cycleModel("forward");

		// then it is held rather than skipped or thrown away (#1378 narrowed by #1873)
		expect(harness.session.pendingModelSwitch?.model.id).toBe("372k");
		expect(harness.session.model?.id).toBe("million");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("keeps refusing a model whose fixed overhead leaves no room for any transcript", async () => {
		// given a window that cannot hold the system prompt, schemas and reserves
		const harness = await createHarness({
			models: [
				{ id: "million", contextWindow: 1_000_000, maxTokens: 32_000 },
				{ id: "overhead-bound", contextWindow: 16_000, maxTokens: 4_000 },
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 321_000);
		const target = harness.getModel("overhead-bound");
		if (!target) throw new Error("missing impossible-target fixture");

		// when / then: no amount of compaction helps, so the refusal stands
		await expect(harness.session.setModel(target)).rejects.toMatchObject({
			name: "ModelUsabilityBudgetError",
			projection: { verdict: "impossible" },
		});
		expect(harness.session.pendingModelSwitch).toBeUndefined();
		expect(harness.session.model?.id).toBe("million");
	});
});
