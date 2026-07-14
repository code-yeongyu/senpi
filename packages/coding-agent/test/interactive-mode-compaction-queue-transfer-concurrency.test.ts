import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type QueueMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

type PromptOptions = {
	readonly streamingBehavior?: "steer" | "followUp";
	readonly preflightResult?: (success: boolean) => void;
	readonly promptDisposition?: (disposition: "handled" | "queued" | "started") => void;
};

function getFlushCompactionQueue() {
	const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue");
	if (typeof flush !== "function") throw new Error("Expected InteractiveMode.flushCompactionQueue");
	return (context: object, options?: { willRetry?: boolean }): Promise<void> =>
		Promise.resolve(flush.call(context, options));
}

function getClearAllQueues() {
	const clear = Reflect.get(InteractiveMode.prototype, "clearAllQueues");
	if (typeof clear !== "function") throw new Error("Expected InteractiveMode.clearAllQueues");
	return (context: object): { steering: string[]; followUp: string[] } => clear.call(context);
}

describe("InteractiveMode compaction queue ownership and concurrency", () => {
	it("stops before the suffix when cancellation clears ownership after native acceptance", async () => {
		const first: QueueMessage = { text: "accepted before cancel", mode: "steer" };
		const suffix: QueueMessage = { text: "must remain canceled", mode: "followUp" };
		const delivered: string[] = [];
		const showError = vi.fn();
		const context = {
			compactionQueuedMessages: [first, suffix],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError,
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue: vi.fn(() => ({ steering: [first.text], followUp: [] })),
				prompt: vi.fn(async () => {}),
				followUp: vi.fn(async (text: string) => {
					delivered.push(text);
				}),
				steer: vi.fn(async (text: string) => {
					delivered.push(text);
					getClearAllQueues()(context);
				}),
			},
		};

		await getFlushCompactionQueue()(context, { willRetry: true });

		expect(delivered).toEqual([first.text]);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
		expect(showError).not.toHaveBeenCalled();
	});

	it("does not deliver a suffix into a replacement session after a queued command rebinds", async () => {
		const command: QueueMessage = { text: "/switch", mode: "steer" };
		const suffix: QueueMessage = { text: "must stay out of replacement", mode: "followUp" };
		const replacementPrompt = vi.fn((_text: string, options?: PromptOptions) => {
			options?.promptDisposition?.("started");
			options?.preflightResult?.(true);
			return Promise.resolve();
		});
		const replacementSession = {
			clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			prompt: replacementPrompt,
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
		};
		const context = {
			compactionQueuedMessages: [command, suffix],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: (message: string) => message.startsWith("/"),
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
				prompt: vi.fn(async (text: string) => {
					expect(text).toBe(command.text);
					context.compactionInFlightMessages = [];
					context.compactionTransferAbortControllers.clear();
					context.session = replacementSession;
				}),
				followUp: vi.fn(async () => {}),
				steer: vi.fn(async () => {}),
			},
		};

		await getFlushCompactionQueue()(context, { willRetry: false });

		expect(replacementPrompt).not.toHaveBeenCalled();
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("drains a restored earlier batch before a later overlapping flush", async () => {
		const earlier: QueueMessage = { text: "earlier", mode: "steer" };
		const later: QueueMessage = { text: "later", mode: "steer" };
		let rejectEarlier: ((error: Error) => void) | undefined;
		let markEarlierStarted: (() => void) | undefined;
		const earlierStarted = new Promise<void>((resolve) => {
			markEarlierStarted = resolve;
		});
		const earlierFailure = new Promise<void>((_resolve, reject) => {
			rejectEarlier = reject;
		});
		const delivered: string[] = [];
		let earlierAttempts = 0;
		const context = {
			compactionQueuedMessages: [earlier],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
				prompt: vi.fn(async () => {}),
				followUp: vi.fn(async () => {}),
				steer: vi.fn((text: string) => {
					delivered.push(text);
					if (text === earlier.text && earlierAttempts++ === 0) {
						markEarlierStarted?.();
						return earlierFailure;
					}
					return Promise.resolve();
				}),
			},
		};

		const firstFlush = getFlushCompactionQueue()(context, { willRetry: true });
		await earlierStarted;
		context.compactionQueuedMessages.push(later);
		const secondFlush = getFlushCompactionQueue()(context, { willRetry: true });
		rejectEarlier?.(new Error("synthetic earlier failure"));
		await Promise.all([firstFlush, secondFlush]);

		expect(delivered).toEqual([earlier.text, earlier.text, later.text]);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(context.compactionInFlightMessages).toEqual([]);
	});

	it("leaves replacement-session input untouched by a flush queued before rebind", async () => {
		const earlier: QueueMessage = { text: "old-session in flight", mode: "steer" };
		const replacement: QueueMessage = { text: "replacement-session input", mode: "steer" };
		let releaseEarlier: (() => void) | undefined;
		let markEarlierStarted: (() => void) | undefined;
		const earlierStarted = new Promise<void>((resolve) => {
			markEarlierStarted = resolve;
		});
		const earlierHeld = new Promise<void>((resolve) => {
			releaseEarlier = resolve;
		});
		const oldSteer = vi.fn((text: string) => {
			if (text === earlier.text) {
				markEarlierStarted?.();
				return earlierHeld;
			}
			return Promise.resolve();
		});
		const replacementSteer = vi.fn(async () => {});
		const replacementSession = {
			clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
			prompt: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			steer: replacementSteer,
		};
		const context = {
			compactionQueuedMessages: [earlier],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			compactionQueueFlushTail: undefined as Promise<void> | undefined,
			compactionQueueGeneration: 0,
			isExtensionCommand: () => false,
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
				prompt: vi.fn(async () => {}),
				followUp: vi.fn(async () => {}),
				steer: oldSteer,
			},
		};

		const firstFlush = getFlushCompactionQueue()(context, { willRetry: true });
		await earlierStarted;
		const staleQueuedFlush = getFlushCompactionQueue()(context, { willRetry: true });
		context.compactionQueueGeneration += 1;
		context.compactionQueuedMessages = [replacement];
		context.compactionInFlightMessages = [];
		context.compactionTransferAbortControllers.clear();
		context.session = replacementSession;
		releaseEarlier?.();
		await Promise.all([firstFlush, staleQueuedFlush]);

		expect(oldSteer).toHaveBeenCalledTimes(1);
		expect(replacementSteer).not.toHaveBeenCalled();
		expect(context.compactionQueuedMessages).toEqual([replacement]);
		expect(context.compactionInFlightMessages).toEqual([]);
	});
});
