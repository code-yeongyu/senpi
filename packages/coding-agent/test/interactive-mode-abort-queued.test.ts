import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};

type AbortAndFireQueuedMessagesThis = {
	clearAllQueues: () => QueuedMessages;
	updatePendingMessagesDisplay: () => void;
	editor: {
		getText: () => string;
		setText: (text: string) => void;
	};
	session: {
		abort: () => Promise<void>;
		prompt: (text: string) => Promise<void>;
	};
	showError: (message: string) => void;
};

type AbortAndFireQueuedMessages = (this: AbortAndFireQueuedMessagesThis) => Promise<number>;

function abortAndFireQueuedMessages(fakeThis: AbortAndFireQueuedMessagesThis): Promise<number> {
	const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "abortAndFireQueuedMessages");
	const fn = descriptor?.value as AbortAndFireQueuedMessages | undefined;
	if (!fn) {
		throw new Error("abortAndFireQueuedMessages is missing");
	}
	return fn.call(fakeThis);
}

describe("InteractiveMode.abortAndFireQueuedMessages", () => {
	test("aborts and restores queued messages without auto-firing a fresh prompt", async () => {
		// given
		const abort = vi.fn<() => Promise<void>>(async () => {});
		const prompt = vi.fn<(text: string) => Promise<void>>(async () => {});
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const showError = vi.fn<(message: string) => void>();
		const fakeThis: AbortAndFireQueuedMessagesThis = {
			clearAllQueues: () => ({
				steering: ["retry-time steering"],
				followUp: ["retry-time follow-up"],
			}),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "current draft",
				setText,
			},
			session: { abort, prompt },
			showError,
		};

		// when
		const restored = await abortAndFireQueuedMessages(fakeThis);

		// then
		expect(restored).toBe(2);
		expect(setText).toHaveBeenCalledWith("retry-time steering\n\nretry-time follow-up\n\ncurrent draft");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	test("aborts without changing the editor when no messages are queued", async () => {
		// given
		const abort = vi.fn<() => Promise<void>>(async () => {});
		const prompt = vi.fn<(text: string) => Promise<void>>(async () => {});
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const showError = vi.fn<(message: string) => void>();
		const fakeThis: AbortAndFireQueuedMessagesThis = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "",
				setText,
			},
			session: { abort, prompt },
			showError,
		};

		// when
		const restored = await abortAndFireQueuedMessages(fakeThis);

		// then
		expect(restored).toBe(0);
		expect(abort).toHaveBeenCalledTimes(1);
		expect(setText).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	test("restores queued messages only after async abort settles", async () => {
		// given
		let resolveAbort: (() => void) | undefined;
		const abortSettled = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const abort = vi.fn<() => Promise<void>>(() => abortSettled);
		const prompt = vi.fn<(text: string) => Promise<void>>(async () => {});
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const showError = vi.fn<(message: string) => void>();
		const fakeThis: AbortAndFireQueuedMessagesThis = {
			clearAllQueues: () => ({ steering: ["queued"], followUp: [] }),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "",
				setText,
			},
			session: { abort, prompt },
			showError,
		};

		// when
		const promise = abortAndFireQueuedMessages(fakeThis);
		await Promise.resolve();
		await Promise.resolve();

		// then
		expect(setText).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();

		resolveAbort?.();
		const restored = await promise;

		expect(restored).toBe(1);
		expect(setText).toHaveBeenCalledWith("queued");
		expect(prompt).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});
});
