import { setImmediate as waitForImmediate } from "node:timers/promises";
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

describe("InteractiveMode transactional compaction queue transfer", () => {
	it("restores only the undelivered suffix before late arrivals without clearing native queues", async () => {
		const first: QueueMessage = { text: "duplicate", mode: "steer" };
		const failed: QueueMessage = { text: "duplicate", mode: "steer" };
		const suffix: QueueMessage = { text: "after failure", mode: "followUp" };
		const late: QueueMessage = { text: "late arrival", mode: "steer" };
		const clearQueue = vi.fn(() => ({ steering: ["native steer"], followUp: ["goal follow-up"] }));
		const delivered: QueueMessage[] = [];
		const showError = vi.fn();
		const context = {
			compactionQueuedMessages: [first, failed, suffix],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError,
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue,
				prompt: vi.fn(async () => {}),
				followUp: vi.fn(async () => {}),
				steer: vi.fn(async (text: string) => {
					const current = [first, failed].find((message) => message.text === text && !delivered.includes(message));
					if (!current) throw new Error(`Unexpected transfer: ${text}`);
					delivered.push(current);
					if (current === failed) {
						context.compactionQueuedMessages.push(late);
						throw new Error("synthetic transfer failure");
					}
				}),
			},
		};

		await getFlushCompactionQueue()(context, { willRetry: true });

		expect(delivered).toEqual([first, failed]);
		expect(context.compactionQueuedMessages).toEqual([failed, suffix, late]);
		expect(context.compactionQueuedMessages[0]).toBe(failed);
		expect(context.compactionQueuedMessages).not.toContain(first);
		expect(showError).toHaveBeenCalledWith("Failed to send queued messages: synthetic transfer failure");
		expect(clearQueue).not.toHaveBeenCalled();
	});

	it("commits the first prompt at explicit preflight acceptance and never restores it after turn failure", async () => {
		const first: QueueMessage = { text: "first prompt", mode: "followUp" };
		const rest: QueueMessage = { text: "queued steer", mode: "steer" };
		const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
		let observedOptions: PromptOptions | undefined;
		const showError = vi.fn();
		const context = {
			compactionQueuedMessages: [first, rest],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError,
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue,
				followUp: vi.fn(async () => {}),
				steer: vi.fn(async () => {}),
				prompt: vi.fn((text: string, options?: PromptOptions) => {
					expect(text).toBe(first.text);
					observedOptions = options;
					options?.promptDisposition?.("started");
					options?.preflightResult?.(true);
					return Promise.reject(new Error("post-accept turn failure"));
				}),
			},
		};

		await getFlushCompactionQueue()(context, { willRetry: false });
		await waitForImmediate();

		expect(observedOptions?.streamingBehavior).toBe("followUp");
		expect(typeof observedOptions?.preflightResult).toBe("function");
		expect(context.session.steer).toHaveBeenCalledWith(rest.text);
		expect(context.compactionQueuedMessages).toEqual([]);
		expect(showError).toHaveBeenCalledWith("Queued prompt failed after acceptance: post-accept turn failure");
		expect(clearQueue).not.toHaveBeenCalled();
	});

	it("restores a preflight-rejected batch ahead of input that arrives during rejection", async () => {
		const first: QueueMessage = { text: "rejected prompt", mode: "steer" };
		const suffix: QueueMessage = { text: "suffix", mode: "followUp" };
		const late: QueueMessage = { text: "late", mode: "steer" };
		const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
		const showError = vi.fn();
		const context = {
			compactionQueuedMessages: [first, suffix],
			compactionInFlightMessages: [] as QueueMessage[],
			compactionTransferAbortControllers: new Map<QueueMessage, AbortController>(),
			isExtensionCommand: () => false,
			showError,
			updatePendingMessagesDisplay: vi.fn(),
			session: {
				clearQueue,
				followUp: vi.fn(async () => {}),
				steer: vi.fn(async () => {}),
				prompt: vi.fn((_text: string, options?: PromptOptions) => {
					context.compactionQueuedMessages.push(late);
					options?.preflightResult?.(false);
					return Promise.reject(new Error("preflight rejected"));
				}),
			},
		};

		await getFlushCompactionQueue()(context, { willRetry: false });

		expect(context.compactionQueuedMessages).toEqual([first, suffix, late]);
		expect(showError).toHaveBeenCalledWith("Failed to send queued messages: preflight rejected");
		expect(clearQueue).not.toHaveBeenCalled();
	});
});
