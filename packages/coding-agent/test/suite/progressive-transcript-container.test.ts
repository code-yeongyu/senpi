import type { Component } from "@earendil-works/pi-tui";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ProgressiveTranscriptContainer } from "../../src/modes/interactive/components/progressive-transcript-container.ts";

const WIDTH = 100 as const;
const TAIL_BUDGET = 40 as const;
const WARM_CHUNK = 200 as const;
const LARGE_TRANSCRIPT = 5000 as const;
const OVER_BUDGET = TAIL_BUDGET + 10;

/**
 * A stand-in for a real message component that counts how many times the
 * transcript asked it to render. Line content is unique per index so ordering
 * regressions cannot hide behind identical output.
 */
class CountingComponent implements Component {
	renderCount = 0;
	invalidateCount = 0;
	disposeCount = 0;
	readonly index: number;

	constructor(index: number) {
		this.index = index;
	}

	render(width: number): string[] {
		this.renderCount += 1;
		return [`component-${this.index}-w${width}`, `component-${this.index}-body`];
	}

	invalidate(): void {
		this.invalidateCount += 1;
	}

	dispose(): void {
		this.disposeCount += 1;
	}
}

class ThrowingComponent implements Component {
	renderCount = 0;

	render(_width: number): string[] {
		this.renderCount += 1;
		throw new Error("intentional render failure");
	}

	invalidate(): void {}

	dispose(): void {}
}

function countingLines(index: number): readonly [string, string] {
	return [`component-${index}-w${WIDTH}`, `component-${index}-body`];
}

function createProgressive(rerender: () => void): ProgressiveTranscriptContainer {
	return new ProgressiveTranscriptContainer({
		tailBudget: TAIL_BUDGET,
		warmChunkSize: WARM_CHUNK,
		requestRender: rerender,
	});
}

function populate(container: Container, count: number): readonly CountingComponent[] {
	const components: CountingComponent[] = [];
	for (let index = 0; index < count; index++) {
		const component = new CountingComponent(index);
		components.push(component);
		container.addChild(component);
	}
	return components;
}

/** Resolve once hydration reports completion, with a bounded macrotask budget. */
async function awaitHydration(container: ProgressiveTranscriptContainer, maxTicks: number): Promise<void> {
	for (let tick = 0; tick < maxTicks; tick++) {
		if (container.isFullyHydrated) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	if (!container.isFullyHydrated) {
		throw new Error(`hydration did not complete within ${maxTicks} macrotasks`);
	}
}

describe("ProgressiveTranscriptContainer", () => {
	it("renders only a bounded tail on the first paint of a large transcript", () => {
		// Given: a 5,000-message transcript hydrated into the progressive container
		const container = createProgressive(() => {});
		const components = populate(container, LARGE_TRANSCRIPT);

		// When: the TUI paints the first frame
		const lines = container.render(WIDTH);

		// Then: only the bounded visible tail was asked to render
		const rendered = components.filter((component) => component.renderCount > 0);
		expect(rendered).toHaveLength(TAIL_BUDGET);
		// Then: the rendered window is the tail, in order, and nothing earlier was touched
		const expectedTail = components.slice(LARGE_TRANSCRIPT - TAIL_BUDGET);
		expect(rendered).toStrictEqual([...expectedTail]);
		expect(lines).toStrictEqual(expectedTail.flatMap((component) => countingLines(component.index)));
	});

	it("eventually renders the full history exactly like an ordinary Container", async () => {
		// Given: identical transcripts in a plain Container and the progressive one
		const baseline = new Container();
		populate(baseline, LARGE_TRANSCRIPT);
		let rerenderRequests = 0;
		const progressive = createProgressive(() => {
			rerenderRequests += 1;
		});
		populate(progressive, LARGE_TRANSCRIPT);

		// When: the first paint lands and hydration warms every earlier component
		progressive.render(WIDTH);
		await awaitHydration(progressive, LARGE_TRANSCRIPT / WARM_CHUNK + 8);

		// Then: hydration asked for exactly one completion rerender and the full output matches the baseline
		expect(rerenderRequests).toBe(1);
		expect(progressive.render(WIDTH)).toStrictEqual(baseline.render(WIDTH));
	});

	it("warms the deferred head off the critical path so the full frame is not one burst", async () => {
		// Given: a large transcript whose head was skipped by the first paint
		const container = createProgressive(() => {});
		const components = populate(container, LARGE_TRANSCRIPT);
		container.render(WIDTH);
		const head = components.slice(0, LARGE_TRANSCRIPT - TAIL_BUDGET);
		expect(head.every((component) => component.renderCount === 0)).toBe(true);

		// When: background hydration runs to completion
		await awaitHydration(container, LARGE_TRANSCRIPT / WARM_CHUNK + 8);

		// Then: the head was actually rendered during hydration, not merely marked ready.
		// Without real warming the deferred Markdown cost would just move to the repaint.
		expect(head.every((component) => component.renderCount > 0)).toBe(true);
	});

	it("renders every child immediately once the transcript fits the tail budget", () => {
		// Given: a transcript smaller than the visible tail budget
		const container = createProgressive(() => {});
		const components = populate(container, TAIL_BUDGET - 1);

		// When: the first frame paints
		container.render(WIDTH);

		// Then: nothing was deferred, so hydration is already complete
		expect(components.every((component) => component.renderCount > 0)).toBe(true);
		expect(container.isFullyHydrated).toBe(true);
	});

	it("renders appended live messages after hydration completes", async () => {
		// Given: a hydrated large transcript
		const container = createProgressive(() => {});
		populate(container, LARGE_TRANSCRIPT);
		container.render(WIDTH);
		await awaitHydration(container, LARGE_TRANSCRIPT / WARM_CHUNK + 8);

		// When: a live message arrives and the next frame paints
		const live = new CountingComponent(LARGE_TRANSCRIPT);
		container.addChild(live);
		const lines = container.render(WIDTH);

		// Then: the appended message is painted at the tail
		expect(live.renderCount).toBeGreaterThan(0);
		expect(lines.slice(-2)).toStrictEqual([...countingLines(LARGE_TRANSCRIPT)]);
	});

	it("cancels pending hydration when the transcript is cleared and rebuilt", async () => {
		// Given: a large transcript whose first paint scheduled hydration work
		let rerenderRequests = 0;
		const container = createProgressive(() => {
			rerenderRequests += 1;
		});
		const stale = populate(container, LARGE_TRANSCRIPT);
		container.render(WIDTH);
		const rerendersAtClear = rerenderRequests;

		// When: the transcript is cleared and rebuilt small, then repainted
		container.clear();
		const rebuilt = populate(container, 3);
		container.render(WIDTH);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Then: the cleared components were disposed and never warmed further
		expect(stale.every((component) => component.disposeCount === 1)).toBe(true);
		const staleRenderTotal = stale.reduce((total, component) => total + component.renderCount, 0);
		expect(staleRenderTotal).toBe(TAIL_BUDGET);
		// Then: the small rebuild paints synchronously without extra hydration passes
		expect(rebuilt.every((component) => component.renderCount === 1)).toBe(true);
		expect(container.isFullyHydrated).toBe(true);
		expect(rerenderRequests).toBe(rerendersAtClear);
	});

	it("stops hydration and forwards disposal to children on dispose", async () => {
		// Given: a large transcript mid-hydration
		const container = createProgressive(() => {});
		const components = populate(container, LARGE_TRANSCRIPT);
		container.render(WIDTH);

		// When: the container is disposed before hydration finishes
		container.dispose();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		// Then: children were disposed and no further warming happened
		expect(components.every((component) => component.disposeCount === 1)).toBe(true);
		const renderTotal = components.reduce((total, component) => total + component.renderCount, 0);
		expect(renderTotal).toBe(TAIL_BUDGET);
	});

	it("contains a throwing tail child on the first frame without escaping", () => {
		// Given: a transcript larger than the tail budget with a thrower in the visible tail
		const container = createProgressive(() => {});
		const throwerIndex = OVER_BUDGET - 5;
		const thrower = new ThrowingComponent();
		let last: CountingComponent | undefined;
		for (let index = 0; index < OVER_BUDGET; index++) {
			if (index === throwerIndex) {
				container.addChild(thrower);
				continue;
			}
			const component = new CountingComponent(index);
			container.addChild(component);
			last = component;
		}

		// When: the TUI paints the first frame
		const lines = container.render(WIDTH);

		// Then: the thrower is contained and the rest of the tail still paints
		expect(thrower.renderCount).toBe(1);
		expect(lines).toContain("[render error: ThrowingComponent]");
		expect(last?.renderCount).toBe(1);
		expect(lines.slice(-2)).toStrictEqual([...countingLines(OVER_BUDGET - 1)]);
	});

	it("contains a throwing head child during warm chunks without escaping", async () => {
		// Given: a transcript larger than the tail budget with a thrower in the deferred head
		let rerenderRequests = 0;
		const container = createProgressive(() => {
			rerenderRequests += 1;
		});
		const thrower = new ThrowingComponent();
		container.addChild(thrower);
		const headNeighbor = new CountingComponent(1);
		container.addChild(headNeighbor);
		for (let index = 2; index < OVER_BUDGET; index++) {
			container.addChild(new CountingComponent(index));
		}

		// When: first paint lands and background hydration warms the head
		const first = container.render(WIDTH);
		expect(first).not.toContain("[render error: ThrowingComponent]");
		expect(thrower.renderCount).toBe(0);
		await awaitHydration(container, 8);

		// Then: hydration completed through the thrower and the full frame contains it
		expect(container.isFullyHydrated).toBe(true);
		expect(rerenderRequests).toBe(1);
		expect(headNeighbor.renderCount).toBeGreaterThan(0);
		expect(thrower.renderCount).toBe(1);
		expect(container.render(WIDTH)).toContain("[render error: ThrowingComponent]");
		expect(thrower.renderCount).toBe(2);
	});

	it("forwards theme invalidation to every child, warmed or not", () => {
		// Given: a large transcript whose earlier components were never warmed
		const container = createProgressive(() => {});
		const components = populate(container, LARGE_TRANSCRIPT);
		container.render(WIDTH);

		// When: the theme changes and invalidation propagates
		container.invalidate();

		// Then: every child was invalidated, including the un-warmed head
		expect(components.every((component) => component.invalidateCount === 1)).toBe(true);
	});
});
