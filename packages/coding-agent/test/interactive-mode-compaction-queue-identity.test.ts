import { expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

// senpi#3549 P2c: input the TUI held during compaction reaches the session under the id it was given when the TUI
// accepted it, so the session takes it into durable custody on flush.

type QueueMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly enqueueOrder?: number;
	readonly clientMessageId?: string;
};

type PromptOptions = {
	readonly clientMessageId?: string;
	readonly preflightResult?: (success: boolean) => void;
	readonly promptDisposition?: (disposition: "handled" | "queued" | "started") => void;
};

function flushCompactionQueue(context: object): Promise<void> {
	const flush = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue");
	if (typeof flush !== "function") throw new Error("Expected InteractiveMode.flushCompactionQueue");
	return Promise.resolve(flush.call(context));
}

it("hands every compaction-held input to the session under the id the TUI minted for it", async () => {
	const first: QueueMessage = { text: "first held", mode: "followUp", enqueueOrder: 1, clientMessageId: "c-first" };
	const second: QueueMessage = { text: "second held", mode: "followUp", enqueueOrder: 2, clientMessageId: "c-second" };
	const prompt = vi.fn(async (_text: string, options?: PromptOptions) => {
		options?.preflightResult?.(true);
		options?.promptDisposition?.("queued");
	});
	const followUp = vi.fn(async () => {});
	const context = {
		compactionQueuedMessages: [first, second],
		compactionInFlightMessages: [] as QueueMessage[],
		compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
		compactionQueueFlushTail: undefined as Promise<void> | undefined,
		compactionQueueGeneration: 0,
		session: { prompt, followUp, steer: vi.fn(async () => {}) },
		optimisticUserEchoes: { promptOptions: () => ({}), reject: () => {} },
		isExtensionCommand: () => false,
		showError: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	};

	await flushCompactionQueue(context);

	expect(prompt).toHaveBeenCalledWith("first held", expect.objectContaining({ clientMessageId: "c-first" }));
	expect(followUp).toHaveBeenCalledWith("second held", undefined, { enqueueOrder: 2, clientMessageId: "c-second" });
	expect(context.showError).not.toHaveBeenCalled();
});
