import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCompaction } from "../../../src/core/compaction/index.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import type { CustomMessage } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Regression: a hidden goal continuation (any custom triggerTurn message) that
 * is queued while a non-auto compaction owns the session must be resumed once
 * that compaction settles, and an admission-rejected custom message must be
 * retained instead of dropped. Without this, the goal extension's single-flight
 * latch stays armed forever and the session silently idles at
 * "Pursuing goal (…)" until manual user input.
 */

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function wedgedContinuationMessage(): CustomMessage {
	return {
		role: "custom",
		customType: "goal-continuation",
		content: [{ type: "text", text: "Continue working toward the goal." }],
		display: false,
		timestamp: Date.now(),
	};
}

function seedConversation(harness: Harness): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "earlier prompt" }],
		timestamp: now - 3000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(9_500),
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "previous prompt" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("previous response", { timestamp: now - 500 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(9_500),
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("goal continuation compaction stall regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("resumes a custom triggerTurn message queued during extension feedback compaction", async () => {
		let ctxRef: ExtensionContext | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						ctxRef = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedConversation(harness);
		if (!ctxRef) throw new Error("extension context was not captured");

		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.settingsManager.getCompactionSettings(),
			false,
		);
		if (!preparation) throw new Error("expected a compaction preparation");

		// Mirror applyBlockingCompaction: feedback stage opens the compaction
		// lifecycle for the whole (long) summarization window.
		const signal = ctxRef.beginCompaction?.({ reason: "extension" });
		expect(signal).toBeDefined();

		harness.setResponses([fauxAssistantMessage("continuation turn ran")]);
		await harness.session.sendCustomMessage(
			{
				customType: "goal-continuation",
				content: "Continue working toward the goal.",
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		// Queued without a turn while the compaction lifecycle is running.
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);

		const applied = await harness.session.applyCompaction(
			{
				summary: "warm summary",
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			},
			{ reason: "extension" },
		);
		expect(applied.applied).toBe(true);
		ctxRef.endCompaction?.({ reason: "extension", signal });
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes agent-level queued messages after a manual compaction", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "manual summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedConversation(harness);

		harness.setResponses([fauxAssistantMessage("continuation turn ran")]);
		harness.session.agent.followUp(wedgedContinuationMessage());
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		await harness.session.compact();
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes agent-level queued messages after the extension compact action", async () => {
		let ctxRef: ExtensionContext | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						ctxRef = ctx;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedConversation(harness);
		if (!ctxRef) throw new Error("extension context was not captured");

		harness.setResponses([fauxAssistantMessage("continuation turn ran")]);
		harness.session.agent.followUp(wedgedContinuationMessage());
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		const completed = createDeferred();
		ctxRef.compact({ onComplete: () => completed.resolve() });
		await completed.promise;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("resumes queued messages when the compact action onComplete callback throws", async () => {
		let ctxRef: ExtensionContext | undefined;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (_event, ctx) => {
						ctxRef = ctx;
					});
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		seedConversation(harness);
		if (!ctxRef) throw new Error("extension context was not captured");

		harness.setResponses([fauxAssistantMessage("continuation turn ran")]);
		harness.session.agent.followUp(wedgedContinuationMessage());
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		const completed = createDeferred();
		ctxRef.compact({
			onComplete: () => {
				completed.resolve();
				throw new Error("onComplete consumer failed");
			},
		});
		await completed.promise;
		await harness.session.waitForSettledSessionWork();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
	});

	it("retains a custom triggerTurn message when required compaction is rejected", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "forced rejection",
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const overflowAssistant: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(overflowAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "goal-continuation", content: "Continue working toward the goal.", display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			),
		).rejects.toThrow("Context remains above the compaction threshold because compaction did not complete");

		expect(harness.faux.state.callCount).toBe(0);
		// The rejected message must be retained for later delivery, mirroring
		// sendUserMessage's retention contract, instead of silently dropped.
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});
});
