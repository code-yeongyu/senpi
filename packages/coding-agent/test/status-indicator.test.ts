import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CompactionStatusIndicator,
	IdleStatus,
	RetryStatusIndicator,
} from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("status indicators", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps idle status at the same height as status indicators", () => {
		const idleStatus = new IdleStatus();

		const lines = idleStatus.render(20);
		expect(lines).toHaveLength(2);
		expect(lines).toEqual([" ".repeat(20), " ".repeat(20)]);
	});

	it("keeps the cancellation hint visible on narrow terminals before progress arrives", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new CompactionStatusIndicator(tui, "overflow");

		try {
			// No compaction_progress event has arrived, so only the width check can
			// collapse the long reason-specific label to the compact one.
			const lines = indicator.render(40);
			expect(lines).toHaveLength(1);
			const rendered = stripAnsi(lines[0] ?? "");
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(40);
			expect(rendered).toContain("to cancel");
		} finally {
			indicator.dispose();
		}
	});

	it("keeps the full reason-specific label when the terminal is wide enough", () => {
		initTheme("dark");
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const indicator = new CompactionStatusIndicator(tui, "overflow");

		try {
			const lines = indicator.render(120);
			expect(lines).toHaveLength(1);
			const rendered = stripAnsi(lines[0] ?? "");
			expect(rendered).toContain("Context overflow detected");
			expect(rendered).toContain("to cancel");
		} finally {
			indicator.dispose();
		}
	});

	it("disposes retry countdown updates", () => {
		initTheme("dark");
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const tui = { requestRender } as unknown as TUI;
		const indicator = new RetryStatusIndicator(tui, 1, 3, 1000);
		const callsBeforeDispose = requestRender.mock.calls.length;

		indicator.dispose();
		vi.advanceTimersByTime(2000);

		expect(requestRender).toHaveBeenCalledTimes(callsBeforeDispose);
	});
});
