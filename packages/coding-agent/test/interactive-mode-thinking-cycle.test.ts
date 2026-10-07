import { describe, expect, it, vi } from "vitest";

/**
 * Shift+Tab thinking-cycle on the local session.
 *
 * `session.cycleThinkingLevel()` returns the new level synchronously, or
 * undefined when the model does not support thinking. The handler only uses
 * that value for the unsupported-model status; the user-visible level status
 * is driven by the `thinking_level_changed` session event.
 */

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type MockFn = ReturnType<typeof vi.fn>;

interface CycleContext {
	isInitialized: boolean;
	session: {
		cycleThinkingLevel: () => unknown;
		thinkingLevel?: string;
	};
	footer: { invalidate: MockFn };
	ui: { requestRender: MockFn };
	showStatus: MockFn;
	updateEditorBorderColor: MockFn;
}

interface ModePrototype {
	cycleThinkingLevel(this: CycleContext): unknown;
	handleEvent(this: CycleContext, event: { type: string; level?: string }): unknown;
}

const proto = InteractiveMode.prototype as unknown as ModePrototype;

function createContext(cycleResult: unknown): CycleContext {
	return {
		isInitialized: false,
		session: {
			cycleThinkingLevel: vi.fn(() => cycleResult),
			thinkingLevel: "medium",
		},
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	};
}

async function flushMicrotasks(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

describe("interactive thinking level cycle", () => {
	it("keeps the sync local-session path free of [object Promise] and unsupported false negatives", async () => {
		const context = createContext("xhigh");
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses.every((status) => !status.includes("[object Promise]"))).toBe(true);
		expect(statuses).not.toContain("Current model does not support thinking");
	});

	it("reports unsupported models when the cycle returns undefined", async () => {
		const context = createContext(undefined);
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses).toContain("Current model does not support thinking");
	});

	it("drives the level status from thinking_level_changed", async () => {
		const context = createContext("high");
		context.isInitialized = true;
		await proto.handleEvent.call(context, { type: "thinking_level_changed", level: "high" });
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses).toContain("Thinking level: high");
		expect(context.footer.invalidate).toHaveBeenCalled();
		expect(context.updateEditorBorderColor).toHaveBeenCalled();
	});
});
