import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const HOLD = "Your account usage limit is reached; it resets 11pm.";

function makeFakeThis(draft: string) {
	let text = draft;
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		editor: { getText: () => text, setText: vi.fn((next: string) => (text = next)) },
		editorText: () => text,
		updatePendingMessagesDisplay: vi.fn(),
		showWarning: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
}

type FakeThis = ReturnType<typeof makeFakeThis>;

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: FakeThis,
	event: Record<string, unknown>,
) => Promise<void>;

function refused(text: string) {
	return {
		type: "queued_input_failed",
		queuedId: "q_1",
		text,
		mode: "followUp",
		error: { code: "account_usage_limit", provider: "faux", message: HOLD },
	};
}

describe("#6868 TUI: a queued follow-up a provider hold refused", () => {
	test("#given an empty editor #when the follow-up is refused #then its text is back in the editor and a notice names the hold", async () => {
		// given
		const fakeThis = makeFakeThis("");

		// when
		await handleEvent.call(fakeThis, refused("queued while the turn ran"));

		// then
		expect(fakeThis.editorText()).toBe("queued while the turn ran");
		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.showWarning.mock.calls[0]?.[0]).toContain(HOLD);
		expect(fakeThis.updatePendingMessagesDisplay).toHaveBeenCalled();
	});

	test("#given a draft in the editor #when the follow-up is refused #then the refused text goes ahead of the draft, which is kept", async () => {
		// given
		const fakeThis = makeFakeThis("my draft");

		// when
		await handleEvent.call(fakeThis, refused("queued while the turn ran"));

		// then
		expect(fakeThis.editorText()).toBe("queued while the turn ran\n\nmy draft");
	});
});
