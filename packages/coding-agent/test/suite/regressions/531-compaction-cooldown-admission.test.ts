import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import type { InlineExtension } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		harness.cleanup();
	}
});

function breakerCancelledCompaction(): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", () => ({
			cancel: true,
			rejectionCause: "circuit-breaker",
			reason: "compaction circuit breaker cooling down (60s left)",
		}));
	}) as InlineExtension;
}

function genericallyCancelledCompaction(): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", () => ({
			cancel: true,
			rejectionCause: "cancelled-by-extension",
			reason: "extension refused",
		}));
	}) as InlineExtension;
}

function externallyOwnedCompaction(): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", () => ({
			cancel: true,
			rejectionCause: "external-owner",
			reason: "provider lane owns compaction",
		}));
	}) as InlineExtension;
}

function privateSessionMethod(session: Harness["session"], name: string): (...args: unknown[]) => unknown {
	const method: unknown = Reflect.get(session, name);
	if (typeof method !== "function") throw new Error(`Expected AgentSession.${name}`);
	return method.bind(session);
}

async function createOverThresholdHarness(extension: InlineExtension): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-large", contextWindow: 20_000, maxTokens: 4_096 }],
		settings: { compaction: { reserveTokens: 1_000, speculativeEnabled: false } },
		extensionFactories: [extension],
	});
	harnesses.push(harness);
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "work through the todo list" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("progress note ".concat("x".repeat(80_000)), { timestamp }),
		usage: {
			input: 19_500,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 19_500,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return harness;
}

describe("issue #531: compaction cooldown must not brick prompt admission", () => {
	it("lets the turn proceed without compaction when the breaker cancelled it", async () => {
		// Given: context is over the soft threshold and the compaction breaker is
		// tripped, so session_before_compact is cancelled with circuit-breaker.
		const harness = await createOverThresholdHarness(breakerCancelledCompaction());
		harness.setResponses([fauxAssistantMessage("continued fine")]);

		// When: the next prompt needs opportunistic pre-prompt compaction.
		await harness.session.prompt("next todo item");

		// Then: the turn reaches the provider instead of dying on the unavailable
		// compaction, and the assistant reply lands in the session.
		const texts = harness.session.agent.state.messages
			.filter((message) => message.role === "assistant")
			.map((message) => JSON.stringify(message));
		expect(texts.some((text) => text.includes("continued fine"))).toBe(true);
	});

	it("lets the provider-owned lane proceed when delegated compaction leaves context over threshold", async () => {
		const harness = await createOverThresholdHarness(externallyOwnedCompaction());
		harness.setResponses([fauxAssistantMessage("provider compacted and continued")]);

		await harness.session.prompt("next provider-owned todo item");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.compactionState).toMatchObject({
			status: "failed",
			rejectionCause: "external-owner",
			model: { provider: harness.session.model?.provider },
		});
	});

	it("retries a provider error when threshold compaction is delegated", async () => {
		const harness = await createOverThresholdHarness(externallyOwnedCompaction());
		harness.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 } });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("provider retry recovered"),
		]);

		await harness.session.prompt("retry through provider-owned compaction");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start").map((event) => event.attempt)).toEqual([1]);
	});

	it("keeps failing closed when compaction is cancelled for a non-breaker reason", async () => {
		// Given: the same over-threshold context, but the cancel is a plain
		// extension refusal, not a breaker cooldown.
		const harness = await createOverThresholdHarness(genericallyCancelledCompaction());
		harness.setResponses([fauxAssistantMessage("should never be sent")]);

		// When / Then: admission still fails closed.
		await expect(harness.session.prompt("next todo item")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
	});

	it("does not reuse delegated admission after switching providers", async () => {
		const harness = await createOverThresholdHarness(externallyOwnedCompaction());
		const lastAssistant = harness.session.agent.state.messages.findLast((message) => message.role === "assistant");
		if (lastAssistant?.role !== "assistant") throw new Error("Expected seeded assistant");
		const runPrePromptCompaction = privateSessionMethod(harness.session, "_runPrePromptCompaction");
		await runPrePromptCompaction(lastAssistant, false, "pre_prompt");
		expect(harness.session.compactionState).toMatchObject({
			status: "failed",
			rejectionCause: "external-owner",
			model: { provider: harness.session.model?.provider },
		});

		const currentModel = harness.getModel();
		const otherProvider = "other-faux-provider";
		await harness.authStorage.modify(otherProvider, async () => ({ type: "api_key", key: "faux-key" }));
		harness.modelRegistry.registerProvider(otherProvider, {
			baseUrl: currentModel.baseUrl,
			apiKey: "faux-key",
			api: harness.faux.api,
			models: [
				{
					id: currentModel.id,
					name: currentModel.name,
					api: currentModel.api,
					reasoning: currentModel.reasoning,
					input: currentModel.input,
					cost: currentModel.cost,
					contextWindow: currentModel.contextWindow,
					maxTokens: currentModel.maxTokens,
					baseUrl: currentModel.baseUrl,
				},
			],
		});
		await harness.session.setSessionModel({ ...currentModel, provider: otherProvider });

		const isCompactionDelegated = privateSessionMethod(harness.session, "_isCompactionDelegated");
		expect(isCompactionDelegated()).toBe(false);
		const enforceBeforeProvider = privateSessionMethod(harness.session, "_enforceCompactionBeforeProvider");
		await expect(enforceBeforeProvider(undefined, false, "pre_prompt")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
	});

	it.each([
		["overflow", 20_001],
		["threshold", 19_500],
	] as const)(
		"does not arm blocked post-compaction admission for an external owner on the %s path",
		async (reason, input) => {
			const harness = await createOverThresholdHarness(externallyOwnedCompaction());
			const branch = harness.sessionManager.getBranch();
			const firstMessage = branch.find((entry) => entry.type === "message");
			if (!firstMessage) throw new Error("Expected seeded message entry");
			harness.sessionManager.appendCompaction("prior summary", firstMessage.id, 19_500);
			const timestamp = Date.now();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "post-compaction work" }],
				timestamp: timestamp - 1,
			});
			const assistant = {
				...fauxAssistantMessage("post-compaction oversized response", { timestamp }),
				usage: {
					input,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			harness.sessionManager.appendMessage(assistant);
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

			const checkCompaction = privateSessionMethod(harness.session, "_checkCompaction");
			expect(await checkCompaction(assistant, true)).toBe(false);
			expect(harness.eventsOfType("compaction_end")).toContainEqual(
				expect.objectContaining({ reason, accepted: false, rejectionCause: "external-owner" }),
			);
			expect(Reflect.get(harness.session, "_blockedPostCompactionAssistant")).toBeUndefined();
		},
	);
});
