import { describe, expect, it, vi } from "vitest";

/**
 * Shift+Tab thinking-cycle under the shared interactive host.
 *
 * Since the shared RPC host became the default for interactive sessions,
 * `session.cycleThinkingLevel()` may return a Promise (the remote proxy
 * forwards the RPC), while the classic local AgentSession returns the level
 * synchronously. The InteractiveMode handler must await either shape and must
 * never render "[object Promise]"; the user-visible level status is driven by
 * the `thinking_level_changed` session event so every attached client (not
 * just the one that pressed Shift+Tab) converges on the host's level.
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
	it("never renders [object Promise] when the session resolves the level asynchronously", async () => {
		const context = createContext(Promise.resolve("high"));
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses.every((status) => !status.includes("[object Promise]"))).toBe(true);
	});

	it("reports unsupported models when the async cycle resolves undefined", async () => {
		const context = createContext(Promise.resolve(undefined));
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses).toContain("Current model does not support thinking");
	});

	it("keeps the sync local-session path free of [object Promise] and unsupported false negatives", async () => {
		const context = createContext("xhigh");
		await proto.cycleThinkingLevel.call(context);
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses.every((status) => !status.includes("[object Promise]"))).toBe(true);
		expect(statuses).not.toContain("Current model does not support thinking");
	});

	it("drives the level status from thinking_level_changed so remote and local paths converge", async () => {
		const context = createContext(Promise.resolve("high"));
		context.isInitialized = true;
		await proto.handleEvent.call(context, { type: "thinking_level_changed", level: "high" });
		await flushMicrotasks();
		const statuses = context.showStatus.mock.calls.map((call) => String(call[0]));
		expect(statuses).toContain("Thinking level: high");
		expect(context.footer.invalidate).toHaveBeenCalled();
		expect(context.updateEditorBorderColor).toHaveBeenCalled();
	});
});
