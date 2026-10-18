import { afterEach, describe, expect, it, vi } from "vitest";
import { ProgressiveTranscriptContainer } from "../../../src/modes/interactive/components/progressive-transcript-container.ts";

describe("issue 1076: atomic history publication", () => {
	afterEach(() => vi.useRealTimers());

	it.each([80, 120])("keeps the visible boundary during live renders at width %i", (width) => {
		// Given: a tail painted before three deferred chunks have warmed.
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const container = new ProgressiveTranscriptContainer({ tailBudget: 2, warmChunkSize: 2, requestRender });
		for (let index = 0; index < 8; index++) {
			container.addChild({ render: (w) => [`${index}:${w}`], invalidate() {} });
		}
		expect(container.render(80)).toEqual(["6:80", "7:80"]);

		// When: one chunk warms, then an unrelated live append/resize paints.
		vi.advanceTimersToNextTimer();
		container.addChild({ render: (w) => [`live:${w}`], invalidate() {} });

		// Then: only the original tail and live message are visible until completion.
		expect(container.render(width)).toEqual([`6:${width}`, `7:${width}`, `live:${width}`]);
		expect(requestRender).not.toHaveBeenCalled();
		vi.runAllTimers();
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(container.isFullyHydrated).toBe(true);
		expect(container.render(width)).toEqual([
			...Array.from({ length: 8 }, (_, index) => `${index}:${width}`),
			`live:${width}`,
		]);
		container.dispose();
	});

	it("re-arms both boundaries when cleared during incomplete hydration", () => {
		// Given: one chunk warmed, with another queued for the old transcript.
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const staleRender = vi.fn(() => ["old"]);
		const container = new ProgressiveTranscriptContainer({ tailBudget: 2, warmChunkSize: 2, requestRender });
		for (let index = 0; index < 8; index++) container.addChild({ render: staleRender, invalidate() {} });
		container.render(80);
		vi.advanceTimersToNextTimer();
		const oldCount = staleRender.mock.calls.length;

		// When: clear and repopulate beyond the tail budget before the old callback runs.
		container.clear();
		for (let index = 0; index < 10; index++) {
			container.addChild({ render: () => [`new-${index}`], invalidate() {} });
		}
		expect(container.render(80)).toEqual(["new-8", "new-9"]);
		vi.advanceTimersToNextTimer();

		// Then: the replacement keeps its own boundary and completes once.
		expect(container.render(80)).toEqual(["new-8", "new-9"]);
		vi.runAllTimers();
		expect(staleRender).toHaveBeenCalledTimes(oldCount);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(container.isFullyHydrated).toBe(true);
		expect(container.render(80)).toEqual(Array.from({ length: 10 }, (_, index) => `new-${index}`));
		container.dispose();
	});
});
