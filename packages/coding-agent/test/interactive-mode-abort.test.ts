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

type QueuedInput = { text: string; mode: "steer" | "followUp"; enqueueOrder: number };

type AbortKeepingQueuedDeliveryThis = {
	session: {
		abort: () => Promise<void>;
		waitForIdle: () => Promise<void>;
		clearQueue: () => { ordered: QueuedInput[] };
	};
	compactionQueuedMessages: QueuedInput[];
	flushCompactionQueue: (options: { willRetry: boolean }) => Promise<void>;
	editor: { setText: (text: string) => void };
};

function prototypeMethod<This, Args extends unknown[], Result>(name: string) {
	const method = Object.getOwnPropertyDescriptor(InteractiveMode.prototype, name)?.value as
		| ((this: This, ...args: Args) => Result)
		| undefined;
	if (!method) throw new Error(`${name} is missing`);
	return (fakeThis: This, ...args: Args): Result => method.call(fakeThis, ...args);
}

const restoreQueuedMessagesToEditor = prototypeMethod<
	RestoreQueuedMessagesToEditorThis,
	[options?: { currentText?: string }],
	number
>("restoreQueuedMessagesToEditor");
const abortKeepingQueuedDelivery = prototypeMethod<AbortKeepingQueuedDeliveryThis, [], Promise<void>>(
	"abortKeepingQueuedDelivery",
);

describe("InteractiveMode.restoreQueuedMessagesToEditor", () => {
	test("hands queued messages back to the editor without aborting the run", () => {
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

		const restoredCount = restoreQueuedMessagesToEditor(fakeThis);

		expect(restoredCount).toBe(2);
		expect(setText).toHaveBeenCalledWith("Steering message\n\nFollow-up message\n\ncurrent draft");
		expect(updatePendingMessagesDisplay).toHaveBeenCalledTimes(1);
		expect(abort).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode.abortKeepingQueuedDelivery", () => {
	function fakeMode(queued: QueuedInput[]) {
		const order: string[] = [];
		const fakeThis = {
			session: {
				abort: vi.fn(async () => {
					order.push("abort");
				}),
				waitForIdle: vi.fn(async () => {
					order.push("idle");
				}),
				clearQueue: vi.fn(() => {
					order.push("take");
					return { ordered: queued };
				}),
			},
			compactionQueuedMessages: [] as QueuedInput[],
			flushCompactionQueue: vi.fn(async () => {
				order.push(`flush:${fakeThis.compactionQueuedMessages.map((message) => message.text).join(",")}`);
			}),
			editor: { setText: vi.fn() },
		} satisfies AbortKeepingQueuedDeliveryThis;
		return { fakeThis, order };
	}

	test("takes the queue only after the aborted run is idle and delivers it instead of drafting it", async () => {
		const { fakeThis, order } = fakeMode([
			{ text: "first", mode: "steer", enqueueOrder: 1 },
			{ text: "second", mode: "followUp", enqueueOrder: 2 },
		]);

		await abortKeepingQueuedDelivery(fakeThis);

		expect(order).toEqual(["abort", "idle", "take", "flush:first,second"]);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
		expect(fakeThis.editor.setText).not.toHaveBeenCalled();
	});

	test("aborts through the session and flushes nothing when no queued message exists", async () => {
		const { fakeThis, order } = fakeMode([]);

		await abortKeepingQueuedDelivery(fakeThis);

		expect(order).toEqual(["abort", "idle", "take"]);
		expect(fakeThis.flushCompactionQueue).not.toHaveBeenCalled();
		expect(fakeThis.editor.setText).not.toHaveBeenCalled();
	});
});
