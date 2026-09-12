import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { buildRpcSessionState } from "../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "./harness.ts";

// https://github.com/code-yeongyu/senpi/issues/1526
// A switch refused by the context-window or auth guard threw before
// `_switchActiveModel` appended its `model_change`, so nothing reached the
// session entries or the event stream: the attempt was indistinguishable from
// never having been made. A refused *cycle* was worse: it appended a real
// `model_change` and wrote the global default before its own post-`model_select`
// guard ran, so the session resumed on a model that was refused and never ran.
describe("rejected model switch", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	function seedUserContext(harness: Harness): void {
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "context ".repeat(3_000) }],
			timestamp: Date.now(),
		});
	}

	function appendAssistant(harness: Harness, text: string): void {
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 10,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
	}

	async function oversizedHarness(options: { persistSession?: boolean } = {}): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", name: "Roomy", contextWindow: 200_000 },
				{ id: "faux-small", name: "Too Small", contextWindow: 5_120 },
				// A second admissible model: the "successful switch" case must move the
				// session somewhere it was not already, or it proves nothing.
				{ id: "faux-spacious", name: "Spacious", contextWindow: 200_000 },
			],
			...options,
		});
		harnesses.push(harness);
		seedUserContext(harness);
		return harness;
	}

	function modelOf(harness: Harness, modelId: string) {
		const model = harness.getModel(modelId);
		if (!model) throw new Error(`expected the ${modelId} faux model`);
		return model;
	}

	function tooSmall(harness: Harness) {
		return modelOf(harness, "faux-small");
	}

	/** A refusal that only the post-`model_select` guard can see: the hook grows the prompt. */
	async function promptGrowingHarness(): Promise<Harness> {
		const harness = await createHarness({
			models: [
				{ id: "current", contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "target", contextWindow: 100_000, maxTokens: 4_000 },
			],
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) =>
						event.model.id === "target" ? { systemPrompt: "large ".repeat(100_000) } : undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		seedUserContext(harness);
		return harness;
	}

	it("#given a target that cannot hold the live context #when the switch is refused #then a rejection entry is appended", async () => {
		const harness = await oversizedHarness();
		const target = tooSmall(harness);
		const before = harness.sessionManager.getBranch().length;

		const error = await harness.session.setModel(target).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		if (!(error instanceof ModelUsabilityBudgetError)) throw new Error("expected a budget refusal");
		// The admission is derived from the branch, not hardcoded: this session
		// carries context, so the refusal is a switch and may name compaction.
		expect(error.projection.admission).toBe("switch");
		const appended = harness.sessionManager.getBranch().slice(before);
		const rejection = appended.find((entry) => entry.type === "model_change_rejected");
		expect(rejection).toMatchObject({
			type: "model_change_rejected",
			provider: target.provider,
			modelId: target.id,
			reason: "context-budget",
			contextWindow: target.contextWindow,
		});
		// The operator-actionable numbers must survive in the record, not only in
		// the transient error message. `liveContextTokens` is deliberately not
		// asserted non-zero: `_getDownswitchLiveContextTokens` reports 0 whenever
		// the target's usable context is not smaller than the current model's, so a
		// fixed expectation there would pin harness geometry rather than behavior.
		const recorded = rejection as unknown as {
			shortfallTokens: number;
			requiredTokens: number;
			liveContextTokens: number;
			detail: string;
		};
		expect(recorded.shortfallTokens).toBeGreaterThan(0);
		expect(recorded.requiredTokens).toBeGreaterThan(target.contextWindow);
		expect(typeof recorded.liveContextTokens).toBe("number");
		// The remedy the guard already names must reach the durable record.
		expect(recorded.detail).toContain("Compact the session");
		// The record is bookkeeping: it must never become context the model sees.
		expect(harness.sessionManager.buildSessionContext().messages).toHaveLength(1);
	});

	it("#given a refused switch #when subscribers observe the session #then a rejection event carries the same numbers", async () => {
		const harness = await oversizedHarness();
		const target = tooSmall(harness);

		await expect(harness.session.setModel(target)).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		const observed = harness.eventsOfType("model_change_rejected");
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ reason: "context-budget", contextWindow: target.contextWindow });
		expect(observed[0]?.model.id).toBe(target.id);
	});

	it("#given the refusal #when the session continues #then the active model is unchanged", async () => {
		const harness = await oversizedHarness();
		const roomy = harness.getModel();

		await expect(harness.session.setModel(tooSmall(harness))).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(harness.session.model?.id).toBe(roomy.id);
		expect(harness.sessionManager.getBranch().filter((entry) => entry.type === "model_change")).toEqual([]);
	});

	it("#given a genuinely different admissible target #when the switch succeeds #then it is recorded as a change, not a refusal", async () => {
		const harness = await oversizedHarness();
		const spacious = modelOf(harness, "faux-spacious");
		expect(harness.session.model?.id).toBe("faux-roomy");
		const before = harness.sessionManager.getBranch().length;

		await harness.session.setModel(spacious);

		const appended = harness.sessionManager.getBranch().slice(before);
		expect(appended.filter((entry) => entry.type === "model_change_rejected")).toEqual([]);
		expect(harness.eventsOfType("model_change_rejected")).toEqual([]);
		expect(appended.find((entry) => entry.type === "model_change")).toMatchObject({ modelId: "faux-spacious" });
		expect(harness.session.model?.id).toBe("faux-spacious");
		expect(harness.settingsManager.getDefaultModel()).toBe("faux-spacious");
	});

	it("#given a refusal from the guard after model_select #when setModel rethrows #then the refusal is recorded too", async () => {
		const harness = await promptGrowingHarness();
		const target = modelOf(harness, "target");

		const error = await harness.session.setModel(target).then(
			() => undefined,
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(ModelUsabilityBudgetError);
		const branch = harness.sessionManager.getBranch();
		expect(branch.filter((entry) => entry.type === "model_change")).toEqual([]);
		const rejections = branch.filter((entry) => entry.type === "model_change_rejected");
		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toMatchObject({ modelId: "target", reason: "context-budget" });
		expect((rejections[0] as unknown as { detail: string }).detail).toContain("cannot switch");
		expect(harness.eventsOfType("model_change_rejected")).toHaveLength(1);
		expect(harness.session.model?.id).toBe("current");
		expect(harness.settingsManager.getDefaultModel()).not.toBe("target");
	});

	it("#given a favorite cycle refused after model_select #when it rethrows #then no model_change and no default are written", async () => {
		const harness = await promptGrowingHarness();
		const current = modelOf(harness, "current");
		const target = modelOf(harness, "target");
		harness.session.setFavoriteModels([{ model: current }, { model: target }]);

		await expect(harness.session.cycleModel()).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		const branch = harness.sessionManager.getBranch();
		// The refused cycle used to append this entry BEFORE its post-`model_select`
		// guard, so the session resumed on the refused model (`session-manager.ts`
		// treats the last `model_change` as the authoritative explicit selection).
		expect(branch.filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(harness.sessionManager.buildSessionContext().model?.modelId).not.toBe("target");
		expect(harness.settingsManager.getDefaultModel()).not.toBe("target");
		const rejections = branch.filter((entry) => entry.type === "model_change_rejected");
		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toMatchObject({ modelId: "target", reason: "context-budget" });
		expect(harness.session.model?.id).toBe("current");
		expect(harness.eventsOfType("model_changed")).toEqual([]);
	});

	it("#given no configured auth #when the switch is refused #then the refusal is recorded with the auth reason", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", name: "Roomy", contextWindow: 200_000 },
				{ id: "faux-spacious", name: "Spacious", contextWindow: 200_000 },
			],
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		const target = modelOf(harness, "faux-spacious");

		await expect(harness.session.setModel(target)).rejects.toThrow(`No API key for ${target.provider}/${target.id}`);

		const rejections = harness.sessionManager.getBranch().filter((entry) => entry.type === "model_change_rejected");
		expect(rejections).toHaveLength(1);
		expect(rejections[0]).toMatchObject({ provider: target.provider, modelId: target.id, reason: "auth" });
		expect((rejections[0] as unknown as { detail: string }).detail).toBe(
			`No API key for ${target.provider}/${target.id}`,
		);
		const observed = harness.eventsOfType("model_change_rejected");
		expect(observed).toHaveLength(1);
		expect(observed[0]).toMatchObject({ reason: "auth" });
		expect(observed[0]?.detail).toBe(`No API key for ${target.provider}/${target.id}`);
		expect(harness.session.model?.id).toBe("faux-roomy");
	});

	it("#given a persisted session past its first assistant reply #when a switch is refused #then the refusal is on disk and reloads", async () => {
		const harness = await oversizedHarness({ persistSession: true });
		appendAssistant(harness, "already answered");
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		await expect(harness.session.setModel(tooSmall(harness))).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(existsSync(sessionFile)).toBe(true);
		const persistedTypes = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { type: string }).type);
		expect(persistedTypes).toContain("model_change_rejected");
		const reloaded = SessionManager.open(sessionFile)
			.getEntries()
			.filter((entry) => entry.type === "model_change_rejected");
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]).toMatchObject({ modelId: "faux-small", reason: "context-budget" });
		expect((reloaded[0] as unknown as { detail: string }).detail).toContain("Compact the session");
	});

	it("#given a session whose only content is a refused switch #when RPC state is built #then the entry list stays bookkeeping", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-roomy", name: "Roomy", contextWindow: 200_000 },
				{ id: "faux-small", name: "Too Small", contextWindow: 5_120 },
			],
			persistSession: true,
		});
		harnesses.push(harness);

		await expect(harness.session.setModel(tooSmall(harness))).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "model_change_rejected")).toBe(true);
		// A refused switch is auto-appended bookkeeping like `model_change`: it must
		// not turn every status snapshot of this session into a full entry dump.
		expect(buildRpcSessionState(harness.session).entries).toBeUndefined();

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "real content" }],
			timestamp: Date.now(),
		});

		expect(buildRpcSessionState(harness.session).entries).toBeDefined();
	});

	it("#given a persisted session with no assistant reply yet #when a switch is refused #then the record flushes with the first reply", async () => {
		const harness = await oversizedHarness({ persistSession: true });
		const sessionFile = harness.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("expected a persisted session file");

		await expect(harness.session.setModel(tooSmall(harness))).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		// Documented limitation, not a special case: `_persist` buffers every entry
		// until the branch holds an assistant message, so a pre-reply refusal is not
		// yet on disk - but it is not lost either.
		expect(existsSync(sessionFile)).toBe(false);

		appendAssistant(harness, "first reply");

		expect(existsSync(sessionFile)).toBe(true);
		const persisted = readFileSync(sessionFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { type: string; modelId?: string });
		expect(persisted.filter((entry) => entry.type === "model_change_rejected")).toMatchObject([
			{ modelId: "faux-small" },
		]);
	});
});
