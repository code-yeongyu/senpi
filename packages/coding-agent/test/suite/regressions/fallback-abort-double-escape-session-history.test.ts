import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";
const nextFallback = "faux/faux-3";

function refusal(): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "server fallback aborted by client policy",
		stopDetails: { type: "refusal" },
	});
}

async function createExhaustedFallbackHarness(): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		settings: {
			retry: {
				enabled: true,
				baseDelayMs: 1,
				fallbackChains: { [primary]: [fallback, nextFallback] },
			},
		},
	});
	harness.setResponses([refusal(), refusal(), refusal()]);
	await harness.session.prompt("trigger the fallback chain");
	return harness;
}

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
	// setupKeyHandlers subscribes the editor's image-marker channel; the fixture
	// borrows the real method plus the real payload map it reconciles.
	pendingImages: Map<number, unknown>;
	subscribeImageMarkers: unknown;
	reconcilePendingImages: unknown;
};

const setupKeyHandlers = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: EscapeFixture) => void;

describe("fallback abort leaves double-Escape session history usable", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("ends the exhausted refusal retry lifecycle and clears retryAttempt", async () => {
		// Given: the primary and every configured fallback terminate with a refusal.
		const harness = await createExhaustedFallbackHarness();
		harnesses.push(harness);

		// Then: the retry lifecycle reports its terminal failure and returns to idle state.
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([
			{ success: false, attempt: 2, finalError: "server fallback aborted by client policy" },
		]);
		expect(harness.session.retryAttempt).toBe(0);
	});

	it("opens the session-history tree on the second Escape after refusal exhaustion", async () => {
		// Given: the real session has exhausted its fallback chain and the empty editor
		// uses InteractiveMode's real Escape handler.
		const harness = await createExhaustedFallbackHarness();
		harnesses.push(harness);
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
			session: harness.session,
			isBashMode: false,
			lastEscapeTime: 0,
			settingsManager: { getDoubleEscapeAction: () => "tree" },
			showTreeSelector: vi.fn(),
			showUserMessageSelector: vi.fn(),
			abortAndFireQueuedMessages: vi.fn().mockResolvedValue(0),
			hideShortcutOverlay: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			pendingImages: new Map<number, unknown>(),
			subscribeImageMarkers: Reflect.get(InteractiveMode.prototype, "subscribeImageMarkers"),
			reconcilePendingImages: Reflect.get(InteractiveMode.prototype, "reconcilePendingImages"),
		};
		setupKeyHandlers.call(fixture);

		// When: Escape is pressed once.
		fixture.defaultEditor.onEscape?.();

		// Then: it only arms the double-Escape window.
		expect(fixture.showTreeSelector).not.toHaveBeenCalled();
		expect(fixture.abortAndFireQueuedMessages).not.toHaveBeenCalled();
		expect(fixture.lastEscapeTime).toBeGreaterThan(0);

		// When: Escape is pressed again inside the 500ms window.
		fixture.defaultEditor.onEscape?.();

		// Then: the session-history tree opens exactly once.
		expect(fixture.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(fixture.showUserMessageSelector).not.toHaveBeenCalled();
		expect(fixture.abortAndFireQueuedMessages).not.toHaveBeenCalled();
		expect(fixture.lastEscapeTime).toBe(0);
	});
});
