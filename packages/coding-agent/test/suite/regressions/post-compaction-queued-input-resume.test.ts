import { readFileSync } from "node:fs";
import { type AssistantMessage, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

type Deferred<T> = {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
};

type QueuedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder?: number;
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
	return (context: object, options: { willRetry: boolean; deferAdmission?: boolean }): Promise<void> =>
		Promise.resolve(flush.call(context, options));
}

function getClearAllQueues() {
	const clear = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clear !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return (context: object): { steering: string[]; followUp: string[] } => clear.call(context);
}

function getRestoreQueuedMessagesToEditor() {
	const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");
	if (typeof restore !== "function") throw new Error("Expected InteractiveMode.restoreQueuedMessagesToEditor");
	return (context: object): number => restore.call(context);
}

function getHandleEvent() {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent");
	if (typeof handleEvent !== "function") throw new Error("Expected InteractiveMode.handleEvent");
	return (context: object, event: object): Promise<void> => Promise.resolve(handleEvent.call(context, event));
}

function getRunAutoCompaction(harness: Harness) {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	return (reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> =>
		Promise.resolve(runAutoCompaction.call(harness.session, reason, willRetry));
}

function getQueueNativeMessage(harness: Harness, mode: "Steer" | "FollowUp") {
	const queue = Reflect.get(harness.session, `_queue${mode}`);
	if (typeof queue !== "function") throw new Error(`Expected AgentSession._queue${mode}`);
	return (text: string): Promise<void> => Promise.resolve(queue.call(harness.session, text));
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

function createTuiCompactionEventContext(harness: Harness) {
	const context = createTuiQueueContext(harness) as ReturnType<typeof createTuiQueueContext> & {
		isInitialized: boolean;
		footer: { invalidate: () => void };
		autoCompactionEscapeHandler: (() => void) | undefined;
		autoCompactionProgressText: string;
		defaultEditor: { onEscape?: () => void };
		statusContainer: { clear: () => void };
		chatContainer: { clear: () => void; addChild: () => void };
		clearStatusIndicator: () => void;
		rebuildChatFromMessages: () => void;
		addMessageToChat: () => void;
		statusMessages: string[];
		showStatus: (message: string) => void;
		ui: { requestRender: () => void; terminal: { setProgress: () => void } };
		settingsManager: { getShowTerminalProgress: () => boolean };
		flushCompactionQueue: (options: { willRetry: boolean; deferAdmission?: boolean }) => Promise<void>;
		flushes: Promise<void>[];
		restoredMessages: string[][];
		clearAllQueues: () => { steering: string[]; followUp: string[] };
		editor: { getText: () => string; setText: (text: string) => void };
		restoreQueuedMessagesToEditor: () => number;
	};
	const flushes: Promise<void>[] = [];
	const statusMessages: string[] = [];
	const restoredMessages: string[][] = [];
	let editorText = "";
	Object.assign(context, {
		isInitialized: true,
		footer: { invalidate: () => {} },
		autoCompactionEscapeHandler: undefined,
		autoCompactionProgressText: "",
		defaultEditor: {},
		statusContainer: { clear: () => {} },
		chatContainer: { clear: () => {}, addChild: () => {} },
		clearStatusIndicator: () => {},
		rebuildChatFromMessages: () => {},
		addMessageToChat: () => {},
		statusMessages,
		showStatus: (message: string) => {
			statusMessages.push(message);
		},
		ui: { requestRender: () => {}, terminal: { setProgress: () => {} } },
		settingsManager: { getShowTerminalProgress: () => false },
		getSessionLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {} }),
		flushes,
		restoredMessages,
		flushCompactionQueue(options: { willRetry: boolean; deferAdmission?: boolean }) {
			const flush = getFlushCompactionQueue()(context, options);
			flushes.push(flush);
			return flush;
		},
		clearAllQueues() {
			return getClearAllQueues()(context);
		},
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
				restoredMessages.push(text.split("\n\n"));
			},
		},
		restoreQueuedMessagesToEditor() {
			return getRestoreQueuedMessagesToEditor()(context);
		},
	});
	return context;
}

async function submitLikeTui(harness: Harness, context: ReturnType<typeof createTuiQueueContext>, text: string) {
	if (harness.session.isCompacting) {
		context.compactionQueuedMessages.push({
			text,
			mode: "steer",
			enqueueOrder: harness.session.reserveQueuedInputOrder(),
		});
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
	beforeAll(() => {
		initTheme("dark");
	});

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

	it.each([
		["rejected overflow", "overflow" as const, true, "reject" as const],
		["rejected threshold", "threshold" as const, false, "reject" as const],
		["feedback-only abort", undefined, false, "abort" as const],
	])(
		"restores queued TUI input to the editor after a terminal %s compaction_end",
		async (_label, reason, willRetry, outcome) => {
			const marker = `[TUI queue remains ${outcome}]`;
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
				settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
				extensionFactories:
					outcome === "reject"
						? [
								(pi: ExtensionAPI) => {
									pi.on("session_before_compact", () => ({
										cancel: true,
										rejectionCause: "cancelled-by-extension",
										reason: "test rejection",
									}));
								},
							]
						: [],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("seed handled"), fauxAssistantMessage("must not execute")]);
			await harness.session.prompt("seed context ".repeat(40));
			const providerCallsBeforeCompaction = harness.faux.state.callCount;
			const nativeSteer = `[native steer ${outcome}]`;
			const nativeFollowUp = `[native follow-up ${outcome}]`;
			await getQueueNativeMessage(harness, "Steer")(nativeSteer);
			await getQueueNativeMessage(harness, "FollowUp")(nativeFollowUp);
			const context = createTuiCompactionEventContext(harness);
			context.compactionQueuedMessages.push({
				text: marker,
				mode: "steer",
				enqueueOrder: harness.session.reserveQueuedInputOrder(),
			});
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end") {
					void getHandleEvent()(context, event);
				}
			});

			if (outcome === "abort") {
				const beginFeedback = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
				const endFeedback = Reflect.get(harness.session, "_endExtensionCompactionFeedback");
				if (typeof beginFeedback !== "function" || typeof endFeedback !== "function") {
					throw new Error("Expected extension compaction feedback lifecycle methods");
				}
				const signal = beginFeedback.call(harness.session, "extension") as AbortSignal;
				endFeedback.call(harness.session, { reason: "extension", signal, aborted: true });
			} else {
				await getRunAutoCompaction(harness)(reason!, willRetry);
			}
			await Promise.all(context.flushes);
			await harness.session.waitForSettledSessionWork();

			// Extension rejections and feedback-only aborts always emit willRetry: false,
			// so every case here is terminal: the marker goes back to the composer and
			// never reaches a native queue or the provider.
			expect(context.compactionQueuedMessages).toEqual([]);
			expect(context.restoredMessages).toEqual([[nativeSteer, nativeFollowUp, marker]]);
			expect(context.compactionInFlightMessages).toEqual([]);
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(getUserTexts(harness)).not.toContain(marker);
			expect(harness.faux.state.callCount).toBe(providerCallsBeforeCompaction);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
			expect(context.statusMessages.some((message) => message.includes("restored to the editor"))).toBe(true);
			expect(context.statusMessages.some((message) => message.includes("will send with the next turn"))).toBe(false);
		},
	);

	it("restores queued TUI input after real pre-prompt overflow compaction failure", async () => {
		const marker = "[TUI queue restores after failed overflow compaction]";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
		});
		harnesses.push(harness);

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "overflowing prior context ".repeat(2_000) }],
			timestamp: Date.now() - 1_000,
		});
		const overflowAssistant = createOverflowResponse(harness);
		harness.sessionManager.appendMessage(overflowAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const failCompactionProvider: FauxResponseFactory = () => {
			throw new Error("forced compaction provider failure");
		};
		harness.setResponses([failCompactionProvider]);

		const context = createTuiCompactionEventContext(harness);
		const compactionEnds: Array<Extract<(typeof harness.events)[number], { type: "compaction_end" }>> = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start" && event.reason === "overflow") {
				context.compactionQueuedMessages.push({
					text: marker,
					mode: "steer",
					enqueueOrder: harness.session.reserveQueuedInputOrder(),
				});
			}
			if (event.type === "compaction_end" && event.reason === "overflow") {
				compactionEnds.push(event);
				void getHandleEvent()(context, event);
			}
		});

		await expect(harness.session.prompt("retry after overflow")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		await Promise.all(context.flushes);
		await harness.session.waitForSettledSessionWork();

		expect(compactionEnds).toHaveLength(1);
		expect(compactionEnds[0]).toMatchObject({
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		expect(compactionEnds[0]?.errorMessage).toMatch(/Pre-prompt compaction failed/);
		expect(context.restoredMessages).toEqual([[marker]]);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("routes queued TUI input to the native session queue after a retryable compaction_end", async () => {
		const marker = "[TUI queue defers to retry]";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled"), fauxAssistantMessage("must not execute")]);
		await harness.session.prompt("seed context ".repeat(40));
		const providerCallsBeforeCompaction = harness.faux.state.callCount;
		const context = createTuiCompactionEventContext(harness);
		context.compactionQueuedMessages.push({
			text: marker,
			mode: "steer",
			enqueueOrder: harness.session.reserveQueuedInputOrder(),
		});

		await getHandleEvent()(context, {
			type: "compaction_end",
			reason: "overflow",
			result: undefined,
			aborted: false,
			willRetry: true,
			errorMessage: "Context overflow recovery failed: transient provider error",
		});
		await Promise.all(context.flushes);
		await harness.session.waitForSettledSessionWork();

		// A retry is still coming, so the queued input is handed to the native steering
		// queue instead of the editor and must not start its own provider turn.
		expect(context.restoredMessages).toEqual([]);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
		expect(harness.session.getSteeringMessages()).toContain(marker);
		expect(getUserTexts(harness)).not.toContain(marker);
		expect(harness.faux.state.callCount).toBe(providerCallsBeforeCompaction);
		expect(context.statusMessages.some((message) => message.includes("queued message"))).toBe(true);
	});

	it("flushes accepted compaction input once through the real compaction_end handler", async () => {
		const marker = "[TUI queue flushes once]";
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [createAcceptedCompactionExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed handled"), fauxAssistantMessage("queued marker handled")]);
		await harness.session.prompt("seed context ".repeat(40));
		const context = createTuiCompactionEventContext(harness);
		context.compactionQueuedMessages.push({
			text: marker,
			mode: "steer",
			enqueueOrder: harness.session.reserveQueuedInputOrder(),
		});
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				void getHandleEvent()(context, event);
			}
		});

		await getRunAutoCompaction(harness)("threshold", false);
		await Promise.all(context.flushes);
		await harness.session.waitForSettledSessionWork();

		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
		expect(context.restoredMessages).toEqual([]);
		expect(getUserTexts(harness).filter((text) => text === marker)).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});
});
