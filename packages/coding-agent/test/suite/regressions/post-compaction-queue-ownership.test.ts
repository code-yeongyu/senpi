import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

type QueuedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

function createAcceptedCompactionExtension() {
	return (pi: ExtensionAPI): void => {
		pi.on("session_before_compact", (event) => ({
			compaction: {
				summary: "accepted post-compaction regression summary",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			},
		}));
	};
}

function getFlushCompactionQueue() {
	const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue");
	if (typeof flush !== "function") throw new Error("Expected InteractiveMode.flushCompactionQueue");
	return (context: object, options: { willRetry: boolean }): Promise<void> =>
		Promise.resolve(flush.call(context, options));
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function getAbortAndFireQueuedMessages() {
	const abortAndFire = Reflect.get(InteractiveMode.prototype, "abortAndFireQueuedMessages");
	if (typeof abortAndFire !== "function") {
		throw new Error("Expected InteractiveMode.abortAndFireQueuedMessages");
	}
	return (context: object): Promise<number> => Promise.resolve(abortAndFire.call(context));
}

function getClearAllQueues() {
	const clearAllQueues = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clearAllQueues !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return (context: object): { steering: string[]; followUp: string[] } => clearAllQueues.call(context);
}

function getRestoreQueuedMessagesToEditor() {
	const restoreQueuedMessages = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");
	if (typeof restoreQueuedMessages !== "function") {
		throw new Error("Expected InteractiveMode.restoreQueuedMessagesToEditor");
	}
	return (context: object): number => restoreQueuedMessages.call(context);
}

function createTuiQueueContext(harness: Harness) {
	return {
		compactionQueuedMessages: [] as QueuedMessage[],
		compactionInFlightMessages: [] as QueuedMessage[],
		compactionTransferAbortControllers: new Map<QueuedMessage, AbortController>(),
		isExtensionCommand: () => false,
		showError: (message: string) => {
			throw new Error(message);
		},
		updatePendingMessagesDisplay: () => {},
		session: harness.session,
	};
}

describe("post-compaction queue ownership", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("starts the next transferred prompt when an input hook handles the first entry", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("input", (event) =>
						event.text === "blocked-first" ? { action: "handled" } : { action: "continue" },
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("suffix handled")]);
		const context = createTuiQueueContext(harness);
		context.compactionQueuedMessages.push(
			{ text: "blocked-first", mode: "steer" },
			{ text: "must-not-hang", mode: "followUp" },
		);

		await getFlushCompactionQueue()(context, { willRetry: false });
		await harness.session.waitForIdle();

		expect(context.compactionQueuedMessages).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["must-not-hang"]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("surfaces a failed retry continuation while preserving transferred native work", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [createAcceptedCompactionExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed context handled")]);
		await harness.session.prompt("seed continuation context ".repeat(40));
		const context = createTuiQueueContext(harness);
		context.compactionQueuedMessages.push({ text: "must-remain-retryable", mode: "steer" });
		const flushes: Promise<void>[] = [];
		const continuationErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				flushes.push(getFlushCompactionQueue()(context, { willRetry: true }));
			}
			const possibleFailure = event as { type: string; errorMessage?: string };
			if (possibleFailure.type === "continuation_error" && possibleFailure.errorMessage) {
				continuationErrors.push(possibleFailure.errorMessage);
			}
		});
		const continueSpy = vi
			.spyOn(harness.session.agent, "continue")
			.mockRejectedValueOnce(new Error("synthetic continuation launch failure"));

		const launched = await getRunAutoCompaction(harness)("threshold", true);
		await Promise.all(flushes);
		await harness.session.waitForSettledSessionWork();

		expect(launched).toBe(true);
		expect(continueSpy).toHaveBeenCalledTimes(1);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness)).toEqual([]);
		expect(continuationErrors).toEqual(["Failed to continue queued messages: synthetic continuation launch failure"]);
	});

	it("cancels and restores a first transfer prompt that is waiting for session work", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not execute")]);
		const marker = "queued TUI prompt";
		const setText = vi.fn<(text: string) => void>();
		const errors: string[] = [];
		const context = {
			compactionQueuedMessages: [{ text: marker, mode: "steer" }] as QueuedMessage[],
			compactionInFlightMessages: [] as QueuedMessage[],
			compactionTransferAbortControllers: new Map<QueuedMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError: (message: string) => errors.push(message),
			updatePendingMessagesDisplay: () => {},
			editor: {
				getText: () => "",
				setText,
			},
			session: harness.session,
			clearAllQueues: () => getClearAllQueues()(context),
		};
		const sessionWorkBarrier = Reflect.get(harness.session, "_sessionWorkBarrier") as {
			begin: () => () => void;
			hasActiveWork: boolean;
		};
		const finishHeldWork = sessionWorkBarrier.begin();

		const flush = getFlushCompactionQueue()(context, { willRetry: false });
		expect(context.compactionQueuedMessages).toEqual([]);
		const restored = await getAbortAndFireQueuedMessages()(context);
		finishHeldWork();
		await flush;
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(restored).toBe(1);
		expect(setText).toHaveBeenCalledWith(marker);
		expect(errors).toEqual([]);
	});

	it("dequeues a first transfer prompt without starting it after session work settles", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not execute")]);
		const marker = "Alt-Up queued TUI prompt";
		const setText = vi.fn<(text: string) => void>();
		const errors: string[] = [];
		const context = {
			compactionQueuedMessages: [{ text: marker, mode: "steer" }] as QueuedMessage[],
			compactionInFlightMessages: [] as QueuedMessage[],
			compactionTransferAbortControllers: new Map<QueuedMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError: (message: string) => errors.push(message),
			updatePendingMessagesDisplay: () => {},
			editor: {
				getText: () => "",
				setText,
			},
			session: harness.session,
			clearAllQueues: () => getClearAllQueues()(context),
		};
		const sessionWorkBarrier = Reflect.get(harness.session, "_sessionWorkBarrier") as {
			begin: () => () => void;
		};
		const finishHeldWork = sessionWorkBarrier.begin();

		const flush = getFlushCompactionQueue()(context, { willRetry: false });
		const restored = getRestoreQueuedMessagesToEditor()(context);
		finishHeldWork();
		await flush;
		await harness.session.waitForIdle();

		expect(restored).toBe(1);
		expect(setText).toHaveBeenCalledWith(marker);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(errors).toEqual([]);
	});

	it("adopts native steer priority while preserving FIFO within each captured mode", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("first handled"),
			fauxAssistantMessage("steer handled"),
			fauxAssistantMessage("follow-up handled"),
		]);
		const context = createTuiQueueContext(harness);
		context.compactionQueuedMessages.push(
			{ text: "first", mode: "followUp" },
			{ text: "second-followup", mode: "followUp" },
			{ text: "third-steer", mode: "steer" },
		);

		await getFlushCompactionQueue()(context, { willRetry: false });
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSettledSessionWork();

		expect(getUserTexts(harness)).toEqual(["first", "third-steer", "second-followup"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
	});
});
