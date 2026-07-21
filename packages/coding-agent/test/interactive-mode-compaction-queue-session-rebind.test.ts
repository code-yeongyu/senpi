import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type QueueMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

type PromptOptions = {
	readonly preflightResult?: (success: boolean) => void;
	readonly promptDisposition?: (disposition: "handled" | "queued" | "started") => void;
};

type SessionLike = {
	readonly prompt: (text: string, options?: PromptOptions) => Promise<void>;
	readonly followUp: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
};

function getFlushCompactionQueue() {
	const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue");
	if (typeof flush !== "function") throw new Error("Expected InteractiveMode.flushCompactionQueue");
	return (context: object): Promise<void> => Promise.resolve(flush.call(context));
}

function getRenderCurrentSessionState() {
	const render = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState");
	if (typeof render !== "function") throw new Error("Expected InteractiveMode.renderCurrentSessionState");
	return (context: object): void => render.call(context);
}

it("starts a replacement-session flush while an old transfer remains pending", async () => {
	const oldMessage: QueueMessage = { text: "old prompt waiting before acceptance", mode: "steer" };
	const replacementMessage: QueueMessage = { text: "/replacement prompt", mode: "steer" };
	let markOldPromptStarted: (() => void) | undefined;
	let rejectOldPrompt: ((error: Error) => void) | undefined;
	let releaseReplacementPrompt: (() => void) | undefined;
	const oldPromptStarted = new Promise<void>((resolve) => {
		markOldPromptStarted = resolve;
	});
	const oldPromptHeld = new Promise<void>((_resolve, reject) => {
		rejectOldPrompt = reject;
	});
	const replacementPromptHeld = new Promise<void>((resolve) => {
		releaseReplacementPrompt = resolve;
	});
	const replacementPrompt = vi.fn(() => replacementPromptHeld);
	const replacementSession: SessionLike = {
		prompt: replacementPrompt,
		followUp: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
	};
	const context: {
		compactionQueuedMessages: QueueMessage[];
		compactionInFlightMessages: QueueMessage[];
		compactionTransferAbortControllers: Map<QueueMessage, AbortController>;
		compactionQueueFlushTail: Promise<void> | undefined;
		compactionQueueGeneration: number;
		session: SessionLike;
		readonly isExtensionCommand: (text: string) => boolean;
		readonly showError: ReturnType<typeof vi.fn>;
		readonly updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
		readonly loadedResourcesContainer: { clear(): void };
		readonly chatContainer: { clear(): void };
		readonly pendingMessagesContainer: { clear(): void };
		streamingComponent: undefined;
		streamingMessage: undefined;
		readonly streamingReveal: { stop: () => void };
		readonly toolResultReveal: { stop: () => void };
		readonly clearPendingTools: () => void;
		readonly clearToolHookStatuses: () => void;
		readonly renderInitialMessages: () => void;
	} = {
		compactionQueuedMessages: [oldMessage],
		compactionInFlightMessages: [],
		compactionTransferAbortControllers: new Map(),
		compactionQueueFlushTail: undefined,
		compactionQueueGeneration: 0,
		session: {
			prompt: vi.fn(() => {
				markOldPromptStarted?.();
				return oldPromptHeld;
			}),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
		},
		isExtensionCommand: (text) => text.startsWith("/"),
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		loadedResourcesContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		streamingComponent: undefined,
		streamingMessage: undefined,
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		clearPendingTools: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		renderInitialMessages: vi.fn(),
	};

	const flushCompactionQueue = getFlushCompactionQueue();
	const oldFlush = flushCompactionQueue(context);
	await oldPromptStarted;

	getRenderCurrentSessionState()(context);
	context.session = replacementSession;
	context.compactionQueuedMessages = [replacementMessage];
	const replacementFlush = flushCompactionQueue(context);

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(replacementPrompt).toHaveBeenCalledWith(replacementMessage.text);
		const replacementTail = context.compactionQueueFlushTail;
		expect(replacementTail).toBeDefined();

		rejectOldPrompt?.(new Error("release stale old transfer"));
		await oldFlush;
		expect(context.compactionQueueFlushTail).toBe(replacementTail);
	} finally {
		rejectOldPrompt?.(new Error("cleanup stale old transfer"));
		releaseReplacementPrompt?.();
		await Promise.allSettled([oldFlush, replacementFlush]);
	}

	expect(context.compactionQueueFlushTail).toBeUndefined();
	expect(context.compactionQueuedMessages).toEqual([]);
	expect(context.compactionInFlightMessages).toEqual([]);
});

it("does not render an accepted old-session prompt failure after session rebind", async () => {
	const oldMessage: QueueMessage = { text: "accepted old-session prompt", mode: "steer" };
	let rejectOldPrompt: ((error: Error) => void) | undefined;
	const oldPromptHeld = new Promise<void>((_resolve, reject) => {
		rejectOldPrompt = reject;
	});
	const showError = vi.fn();
	const replacementSession: SessionLike = {
		prompt: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		steer: vi.fn(async () => {}),
	};
	const context: {
		compactionQueuedMessages: QueueMessage[];
		compactionInFlightMessages: QueueMessage[];
		compactionTransferAbortControllers: Map<QueueMessage, AbortController>;
		compactionQueueFlushTail: Promise<void> | undefined;
		compactionQueueGeneration: number;
		session: SessionLike;
		readonly isExtensionCommand: (text: string) => boolean;
		readonly showError: ReturnType<typeof vi.fn>;
		readonly updatePendingMessagesDisplay: ReturnType<typeof vi.fn>;
		readonly loadedResourcesContainer: { clear(): void };
		readonly chatContainer: { clear(): void };
		readonly pendingMessagesContainer: { clear(): void };
		streamingComponent: undefined;
		streamingMessage: undefined;
		readonly streamingReveal: { stop: () => void };
		readonly toolResultReveal: { stop: () => void };
		readonly clearPendingTools: () => void;
		readonly clearToolHookStatuses: () => void;
		readonly renderInitialMessages: () => void;
	} = {
		compactionQueuedMessages: [oldMessage],
		compactionInFlightMessages: [],
		compactionTransferAbortControllers: new Map(),
		compactionQueueFlushTail: undefined,
		compactionQueueGeneration: 0,
		session: {
			prompt: vi.fn((_text: string, options?: PromptOptions) => {
				options?.promptDisposition?.("started");
				options?.preflightResult?.(true);
				return oldPromptHeld;
			}),
			followUp: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
		},
		isExtensionCommand: () => false,
		showError,
		updatePendingMessagesDisplay: vi.fn(),
		loadedResourcesContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn() },
		pendingMessagesContainer: { clear: vi.fn() },
		streamingComponent: undefined,
		streamingMessage: undefined,
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		clearPendingTools: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		renderInitialMessages: vi.fn(),
	};

	await getFlushCompactionQueue()(context);
	getRenderCurrentSessionState()(context);
	context.session = replacementSession;
	rejectOldPrompt?.(new Error("stale old-session failure"));
	await waitForImmediate();

	expect(showError).not.toHaveBeenCalled();
});
