import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import type { Harness } from "../harness.ts";
import { expectWithin, startPostCompactionContinuation } from "../post-compaction-continuation-rig.ts";

// senpi#6345 at the TUI seam: InteractiveMode's real Escape handler over a real session whose extension
// compaction resumed its queue. Esc must interrupt the continuation, not arm the double-Escape /tree shortcut.

type EscapeFixture = {
	defaultEditor: {
		onEscape: (() => void) | undefined;
		onAction: (name: string, handler: () => void) => void;
		onCtrlD: unknown;
		onChange: unknown;
		onPasteImage: unknown;
	};
	ui: { onDebug: unknown };
	editor: { getText: () => string; setText: (text: string) => void };
	session: Harness["session"];
	isBashMode: boolean;
	lastEscapeTime: number;
	settingsManager: { getDoubleEscapeAction: () => "tree" };
	showTreeSelector: ReturnType<typeof vi.fn>;
	showUserMessageSelector: ReturnType<typeof vi.fn>;
	abortAndFireQueuedMessages: ReturnType<typeof vi.fn>;
	hideShortcutOverlay: ReturnType<typeof vi.fn>;
	updateEditorBorderColor: ReturnType<typeof vi.fn>;
	pendingImages: Map<number, unknown>;
	subscribeImageMarkers: unknown;
	reconcilePendingImages: unknown;
};

const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: EscapeFixture) => void;

describe("Escape during a post-compaction continuation (senpi#6345)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("interrupts the continuation instead of opening the session-history tree", async () => {
		const rig = await startPostCompactionContinuation(harnesses);
		const { session } = rig.harness;
		const fixture: EscapeFixture = {
			defaultEditor: {
				onEscape: undefined,
				onAction: vi.fn(),
				onCtrlD: undefined,
				onChange: undefined,
				onPasteImage: undefined,
			},
			ui: { onDebug: undefined },
			editor: { getText: () => "", setText: vi.fn() },
			session,
			isBashMode: false,
			lastEscapeTime: 0,
			settingsManager: { getDoubleEscapeAction: () => "tree" },
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			abortAndFireQueuedMessages: vi.fn(() => session.stop().then(() => 0)),
			hideShortcutOverlay: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			pendingImages: new Map<number, unknown>(),
			subscribeImageMarkers: Reflect.get(InteractiveMode.prototype, "subscribeImageMarkers"),
			reconcilePendingImages: Reflect.get(InteractiveMode.prototype, "reconcilePendingImages"),
		};
		setupKeyHandlers.call(fixture);

		fixture.defaultEditor.onEscape?.();
		fixture.defaultEditor.onEscape?.();

		expect(fixture.abortAndFireQueuedMessages).toHaveBeenCalled();
		expect(fixture.showTreeSelector).not.toHaveBeenCalled();
		await expectWithin(rig.continuationEnded, 2_000, "Escape stops the continuation");
		const continuationEnd = rig.harness.eventsOfType("agent_end").at(-1);
		expect(continuationEnd?.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		await expectWithin(rig.activePrompt, 2_000, "the aborted prompt settles");
		await session.waitForSettledSessionWork();
		expect(session.isStreaming).toBe(false);
		rig.continuation.release();
	});
});
