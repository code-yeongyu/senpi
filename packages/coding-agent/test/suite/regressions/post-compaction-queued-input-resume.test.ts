import { readFileSync } from "node:fs";
import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

type QueuedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

const USER_MARKER = ". [TUI_QUEUED_DOT]";
const OMO_MARKER = "[OMO_MICROTASK_STEER]";
const GOAL_MARKER = "[GOAL_FOLLOW_UP]";
const OVERFLOW_ERROR =
	"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.";

function createDeferred<T>(): Deferred<T> {
	let resolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

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

async function submitLikeTui(harness: Harness, context: ReturnType<typeof createTuiQueueContext>, text: string) {
	if (harness.session.isCompacting) {
		context.compactionQueuedMessages.push({ text, mode: "steer" });
		return;
	}
	await harness.session.prompt(text, {
		streamingBehavior: harness.session.isStreaming ? "steer" : undefined,
	});
}

function countInPersistedSession(harness: Harness, marker: string): number {
	const sessionFile = harness.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("Expected persisted session file");
	return readFileSync(sessionFile, "utf8").split(marker).length - 1;
}

function createOverflowResponse(harness: Harness): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage: OVERFLOW_ERROR }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	};
}

describe("post-compaction queued input recovery", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("persists one late TUI marker submitted after the sole compaction flush", async () => {
		const recoveryStarted = createDeferred<void>();
		const releaseRecovery = createDeferred<AssistantMessage>();
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [createAcceptedCompactionExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed context handled")]);
		await harness.session.prompt("seed persisted context ".repeat(40));
		const context = createTuiQueueContext(harness);
		const flushes: Promise<void>[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			flushes.push(getFlushCompactionQueue()(context, { willRetry: event.willRetry }));
		});
		const recoveryResponse: FauxResponseFactory = () => {
			recoveryStarted.resolve();
			return releaseRecovery.promise;
		};
		harness.setResponses([createOverflowResponse(harness), recoveryResponse, fauxAssistantMessage("marker handled")]);

		const prompt = harness.session.prompt("initial overflow prompt ".repeat(40));
		await recoveryStarted.promise;
		await Promise.all(flushes);
		const markerSubmission = submitLikeTui(harness, context, USER_MARKER);
		releaseRecovery.resolve(fauxAssistantMessage("overflow recovery handled"));
		await Promise.all([prompt, markerSubmission]);

		expect(context.compactionQueuedMessages).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["initial overflow prompt ".repeat(40), USER_MARKER]);
		expect(harness.faux.state.callCount).toBe(4);
		expect(countInPersistedSession(harness, USER_MARKER)).toBe(1);
	});

	it("does not synthesize a post-compaction turn when no input was queued", async () => {
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [createAcceptedCompactionExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed context handled")]);
		await harness.session.prompt("seed persisted context ".repeat(40));
		const context = createTuiQueueContext(harness);
		const flushes: Promise<void>[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			flushes.push(getFlushCompactionQueue()(context, { willRetry: event.willRetry }));
		});
		harness.setResponses([createOverflowResponse(harness), fauxAssistantMessage("overflow recovery handled")]);

		await harness.session.prompt("initial no-input overflow prompt ".repeat(40));
		await Promise.all(flushes);

		expect(context.compactionQueuedMessages).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["initial no-input overflow prompt ".repeat(40)]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(countInPersistedSession(harness, USER_MARKER)).toBe(0);
	});

	it("preserves a late TUI marker beside OMO steer and goal follow-up continuations", async () => {
		const recoveryStarted = createDeferred<void>();
		const releaseRecovery = createDeferred<AssistantMessage>();
		let continuationsArmed = false;
		let continuationsInjected = false;
		const harness = await createHarness({
			persistSession: true,
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				createAcceptedCompactionExtension(),
				(pi: ExtensionAPI) => {
					pi.on("agent_end", () => {
						if (!continuationsArmed || continuationsInjected) return;
						continuationsInjected = true;
						pi.sendUserMessage(GOAL_MARKER, { deliverAs: "followUp" });
						queueMicrotask(() => {
							pi.sendUserMessage(OMO_MARKER, { deliverAs: "steer" });
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed context handled")]);
		await harness.session.prompt("seed persisted context ".repeat(40));
		continuationsArmed = true;
		const context = createTuiQueueContext(harness);
		const flushes: Promise<void>[] = [];
		harness.session.subscribe((event) => {
			if (event.type !== "compaction_end") return;
			flushes.push(getFlushCompactionQueue()(context, { willRetry: event.willRetry }));
		});
		const recoveryResponse: FauxResponseFactory = () => {
			recoveryStarted.resolve();
			return releaseRecovery.promise;
		};
		harness.setResponses([
			createOverflowResponse(harness),
			recoveryResponse,
			fauxAssistantMessage("OMO continuation handled"),
			fauxAssistantMessage("goal continuation handled"),
			fauxAssistantMessage("marker handled"),
		]);

		const prompt = harness.session.prompt("initial competing overflow prompt ".repeat(40));
		await recoveryStarted.promise;
		await Promise.all(flushes);
		const markerSubmission = submitLikeTui(harness, context, USER_MARKER);
		releaseRecovery.resolve(fauxAssistantMessage("overflow recovery handled"));
		await Promise.all([prompt, markerSubmission]);
		await harness.session.agent.waitForIdle();

		const userTexts = getUserTexts(harness);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(userTexts.filter((text) => text === USER_MARKER)).toHaveLength(1);
		expect(userTexts.filter((text) => text === OMO_MARKER)).toHaveLength(1);
		expect(userTexts.filter((text) => text === GOAL_MARKER)).toHaveLength(1);
		expect(countInPersistedSession(harness, USER_MARKER)).toBe(1);
		expect(countInPersistedSession(harness, OMO_MARKER)).toBe(1);
		expect(countInPersistedSession(harness, GOAL_MARKER)).toBe(1);
	});
});
