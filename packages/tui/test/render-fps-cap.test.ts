import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function flushNextTick(): Promise<void> {
	return new Promise((resolve) => process.nextTick(resolve));
}

function viewportHas(terminal: VirtualTerminal, text: string): boolean {
	return terminal.getViewport().some((line) => line.includes(text));
}

/** Deterministic: setTimeout and performance.now() are both mocked, no wall-clock is read. */
async function measureRenderIntervalMs(configure?: (tui: TUI) => void): Promise<number> {
	mock.timers.enable({ apis: ["setTimeout"], now: 1_000 });
	let fakeNow = 1_000;
	mock.method(performance, "now", () => fakeNow);
	// Advance both mocked clocks 1ms, then flush xterm's zero-delay parse timer and real nextTicks.
	const pump = async (): Promise<void> => {
		fakeNow += 1;
		mock.timers.tick(1);
		mock.timers.tick(0);
		await flushNextTick();
	};
	try {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const component = new TestComponent();
		component.lines = ["first"];
		tui.addChild(component);
		configure?.(tui);
		tui.start();

		// First render: elapsed since t=0 exceeds any throttle interval, so it
		// fires as soon as timers advance and seeds lastRenderAt.
		let firstRendered = false;
		for (let waited = 0; waited < 200 && !firstRendered; waited++) {
			await pump();
			firstRendered = viewportHas(terminal, "first");
		}
		assert.ok(firstRendered, "initial render never happened");

		// Second render: time has not advanced since the first render fired, so
		// scheduleRender() applies the full throttle delay.
		component.lines = ["second"];
		tui.requestRender();
		await flushNextTick();
		for (let delay = 1; delay <= 200; delay++) {
			await pump();
			if (viewportHas(terminal, "second")) {
				tui.stop();
				return delay;
			}
		}
		assert.fail("throttled render never happened");
	} finally {
		mock.restoreAll();
		mock.timers.reset();
	}
}

describe("TUI render fps cap", () => {
	it("keeps the historic 16ms throttle by default", async () => {
		assert.strictEqual(await measureRenderIntervalMs(), 16);
	});

	it("keeps a 16ms interval at 60fps", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(60)), 16);
	});

	it("sets a 33ms interval at 30fps", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(30)), 33);
	});

	it("sets an 8ms interval at 120fps", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(120)), 8);
	});

	it("floors the interval (90fps -> 11ms)", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(90)), 11);
	});

	it("clamps sub-30fps values up to 30fps", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(29)), 33);
	});

	it("clamps above-120fps values down to 120fps", async () => {
		assert.strictEqual(await measureRenderIntervalMs((tui) => tui.setMaxRenderFps(121)), 8);
	});
});
