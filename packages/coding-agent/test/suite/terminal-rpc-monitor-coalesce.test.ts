/**
 * senpi#3226: streaming records collapse per session into one line per 2 s window whose count is the
 * number of deltas received, with the last text; surface churn collapses per 5 s; other kinds pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DELTA_WINDOW_MS,
	RpcMonitorCoalescer,
	SURFACE_WINDOW_MS,
} from "../../src/core/extensions/builtin/terminal/rpc-monitor-coalesce.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const delta = (text: string) => ({
	type: "message_update",
	sessionId: "s1",
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
});

describe("rpc monitor coalescing (senpi#3226)", () => {
	it("folds N deltas in one window into one line counting N, with the last text", () => {
		const lines: string[] = [];
		const coalescer = new RpcMonitorCoalescer((line) => lines.push(line));
		const deltas = ["Hel", "lo ", "wor", "ld"];

		for (const text of deltas) expect(coalescer.accept("h#s1", () => "label", delta(text))).toBe(true);
		vi.advanceTimersByTime(DELTA_WINDOW_MS - 1);
		const beforeClose = [...lines];
		vi.advanceTimersByTime(1);

		expect(beforeClose).toEqual([]);
		expect(lines).toEqual([`rpc label streaming +${deltas.length} deltas (last: "ld")`]);
	});

	it("opens a new window after one closes, and keeps sessions apart", () => {
		const lines: string[] = [];
		const coalescer = new RpcMonitorCoalescer((line) => lines.push(line));

		coalescer.accept("h#s1", () => "one", delta("a"));
		coalescer.accept("h#s2", () => "two", { ...delta("b"), sessionId: "s2" });
		vi.advanceTimersByTime(DELTA_WINDOW_MS);
		coalescer.accept("h#s1", () => "one", delta("c"));
		vi.advanceTimersByTime(DELTA_WINDOW_MS);

		expect(lines).toEqual([
			'rpc one streaming +1 deltas (last: "a")',
			'rpc two streaming +1 deltas (last: "b")',
			'rpc one streaming +1 deltas (last: "c")',
		]);
	});

	it("collapses surface churn per 5 s and leaves every other kind to the renderer", () => {
		const lines: string[] = [];
		const coalescer = new RpcMonitorCoalescer((line) => lines.push(line));

		coalescer.accept("h#s1", () => "one", { type: "commands_changed", sessionId: "s1" });
		coalescer.accept("h#s1", () => "one", { type: "commands_changed", sessionId: "s1" });
		const passed = coalescer.accept("h#s1", () => "one", { type: "session_status", sessionId: "s1" });
		vi.advanceTimersByTime(SURFACE_WINDOW_MS);

		expect(passed).toBe(false);
		expect(lines).toEqual(["rpc one commands_changed x2"]);
	});
});
