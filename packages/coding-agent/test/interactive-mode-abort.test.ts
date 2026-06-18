import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type QueuedMessages = {
	steering: string[];
	followUp: string[];
};

type RestoreQueuedMessagesToEditorThis = {
	clearAllQueues: () => QueuedMessages;
	updatePendingMessagesDisplay: () => void;
	editor: {
		getText: () => string;
		setText: (text: string) => void;
	};
	session: {
		abort: () => Promise<void> | void;
	};
};

type RestoreQueuedMessagesToEditor = (
	this: RestoreQueuedMessagesToEditorThis,
	options?: { abort?: boolean; currentText?: string },
) => number;

function restoreQueuedMessagesToEditor(
	fakeThis: RestoreQueuedMessagesToEditorThis,
	options?: { abort?: boolean; currentText?: string },
): number {
	const descriptor = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, "restoreQueuedMessagesToEditor");
	const restore = descriptor?.value as RestoreQueuedMessagesToEditor | undefined;
	if (!restore) {
		throw new Error("restoreQueuedMessagesToEditor is missing");
	}
	return restore.call(fakeThis, options);
}

describe("InteractiveMode.restoreQueuedMessagesToEditor", () => {
	test("aborts through the session after restoring queued messages", () => {
		// given
		const abort = vi.fn<() => void>();
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const fakeThis = {
			clearAllQueues: () => ({
				steering: ["Steering message"],
				followUp: ["Follow-up message"],
			}),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "current draft",
				setText,
			},
			session: { abort },
		} satisfies RestoreQueuedMessagesToEditorThis;

		// when
		const restoredCount = restoreQueuedMessagesToEditor(fakeThis, { abort: true });

		// then
		expect(restoredCount).toBe(2);
		expect(setText).toHaveBeenCalledWith("Steering message\n\nFollow-up message\n\ncurrent draft");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	test("aborts through the session when no queued message exists", () => {
		// given
		const abort = vi.fn<() => void>();
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const fakeThis = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "",
				setText,
			},
			session: { abort },
		} satisfies RestoreQueuedMessagesToEditorThis;

		// when
		const restoredCount = restoreQueuedMessagesToEditor(fakeThis, { abort: true });

		// then
		expect(restoredCount).toBe(0);
		expect(setText).not.toHaveBeenCalled();
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);
	});

	test("restores queued messages before async abort settles", async () => {
		// given
		let resolveAbort: (() => void) | undefined;
		const abortSettled = new Promise<void>((resolve) => {
			resolveAbort = resolve;
		});
		const abort = vi.fn<() => Promise<void>>(() => abortSettled);
		const setText = vi.fn<(text: string) => void>();
		const updatePendingMessagesDisplay = vi.fn<() => void>();
		const fakeThis = {
			clearAllQueues: () => ({
				steering: ["queued before abort"],
				followUp: [],
			}),
			updatePendingMessagesDisplay,
			editor: {
				getText: () => "",
				setText,
			},
			session: { abort },
		} satisfies RestoreQueuedMessagesToEditorThis;

		// when
		const restoredCount = restoreQueuedMessagesToEditor(fakeThis, { abort: true });

		// then
		expect(restoredCount).toBe(1);
		expect(setText).toHaveBeenCalledWith("queued before abort");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(abort).toHaveBeenCalledTimes(1);

		resolveAbort?.();
		await abortSettled;
	});
});
