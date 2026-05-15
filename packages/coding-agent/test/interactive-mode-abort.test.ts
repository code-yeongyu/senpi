import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

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
		abort: () => void;
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
});
