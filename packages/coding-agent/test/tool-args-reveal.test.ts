import { afterEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_SMOOTH_FPS } from "../src/modes/interactive/streaming-reveal.ts";
import { MIN_TOOL_ARGS_PARSE_DELTA, ToolArgsRevealController } from "../src/modes/interactive/tool-args-reveal.ts";

class RecordingArgsComponent {
	readonly updates: unknown[] = [];

	updateArgs(args: unknown): void {
		this.updates.push(args);
	}
}

function latestArgs(component: RecordingArgsComponent): unknown {
	const args = component.updates.at(-1);
	if (args === undefined) throw new Error("Expected at least one argument update");
	return args;
}

function commandOf(args: unknown): string {
	if (typeof args !== "object" || args === null || !("command" in args) || typeof args.command !== "string") {
		throw new TypeError("Expected parsed command arguments");
	}
	return args.command;
}

function makePartial(command: string): string {
	return `{"command":"${command}`;
}

function makeController(
	options: { readonly getSmoothStreaming?: () => boolean; readonly getSmoothStreamingFps?: () => number } = {},
): { readonly controller: ToolArgsRevealController; readonly requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return {
		controller: new ToolArgsRevealController({
			getSmoothStreaming: options.getSmoothStreaming ?? (() => true),
			getSmoothStreamingFps: options.getSmoothStreamingFps ?? (() => DEFAULT_SMOOTH_FPS),
			requestRender,
		}),
		requestRender,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ToolArgsRevealController", () => {
	test("#given a first partial and a later burst #when reveal ticks run #then the first value is complete and later prefixes grow monotonically", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const component = new RecordingArgsComponent();
		const { controller } = makeController();
		const first = makePartial("seed");

		expect(controller.update("call-1", component, first)).toBe(true);
		expect(commandOf(latestArgs(component))).toBe("seed");

		controller.update("call-1", component, `${first}${"x".repeat(1024)}`);
		const lengths = [commandOf(latestArgs(component)).length];
		for (let tick = 1; tick <= 2; tick++) {
			now = tick * 100;
			vi.advanceTimersByTime(17);
			lengths.push(commandOf(latestArgs(component)).length);
		}

		expect(lengths[0]).toBe(4);
		expect(lengths[1]).toBeGreaterThan(lengths[0]);
		expect(lengths[2]).toBeGreaterThan(lengths[1]);
		expect(lengths[2]).toBeLessThan(1028);
		controller.stop();
	});

	test("#given less than one parse batch is revealed #when ticks accumulate #then parsing waits for the 64th UTF-16 unit", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const component = new RecordingArgsComponent();
		const { controller } = makeController();
		const first = makePartial("seed");
		controller.update("call-1", component, first);
		controller.update("call-1", component, `${first}${"x".repeat(100)}`);
		const initialUpdateCount = component.updates.length;

		for (let tick = 1; tick < MIN_TOOL_ARGS_PARSE_DELTA; tick++) {
			now = tick;
			vi.advanceTimersToNextTimer();
		}

		expect(component.updates).toHaveLength(initialUpdateCount);
		now = MIN_TOOL_ARGS_PARSE_DELTA;
		vi.advanceTimersToNextTimer();

		expect(component.updates).toHaveLength(initialUpdateCount + 1);
		expect(commandOf(latestArgs(component))).toBe(`seed${"x".repeat(MIN_TOOL_ARGS_PARSE_DELTA)}`);
		controller.stop();
	});

	test("#given a reveal step landing inside an emoji surrogate pair #when the prefix is parsed #then no broken surrogate is exposed", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const component = new RecordingArgsComponent();
		const { controller } = makeController();
		const first = makePartial("start ");
		const appended = `${"a".repeat(63)}😀${"b".repeat(105)}`;
		controller.update("call-1", component, first);
		controller.update("call-1", component, `${first}${appended}`);

		now = 100;
		vi.advanceTimersByTime(17);

		const command = commandOf(latestArgs(component));
		expect(command).toBe(`start ${"a".repeat(63)}😀`);
		expect(command).not.toContain("�");
		controller.stop();
	});

	test("#given two independently buffered tool calls #when one flushes exactly and all remaining calls flush #then each final value is rendered once and timers stop", () => {
		vi.useFakeTimers();
		const firstComponent = new RecordingArgsComponent();
		const secondComponent = new RecordingArgsComponent();
		const { controller } = makeController();
		const first = makePartial("first");
		const second = makePartial("second");
		controller.update("call-1", firstComponent, first);
		controller.update("call-2", secondComponent, second);
		controller.update("call-1", firstComponent, `${first}-buffered`);
		controller.update("call-2", secondComponent, `${second}-buffered`);

		expect(controller.flush("call-1", { command: "exact-first" })).toBe(true);
		expect(controller.flush("missing", { command: "unused" })).toBe(false);
		controller.flushAll();
		const firstUpdateCount = firstComponent.updates.length;
		const secondUpdateCount = secondComponent.updates.length;
		vi.advanceTimersByTime(1000);

		expect(commandOf(latestArgs(firstComponent))).toBe("exact-first");
		expect(commandOf(latestArgs(secondComponent))).toBe("second-buffered");
		expect(firstComponent.updates).toHaveLength(firstUpdateCount);
		expect(secondComponent.updates).toHaveLength(secondUpdateCount);
	});

	test("#given stale paced state #when smoothing becomes disabled #then update bypasses pacing and cannot overwrite the caller's direct args", () => {
		vi.useFakeTimers();
		let smooth = true;
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const component = new RecordingArgsComponent();
		const { controller } = makeController({ getSmoothStreaming: () => smooth });
		const first = makePartial("seed");
		controller.update("call-1", component, first);
		controller.update("call-1", component, `${first}${"x".repeat(256)}`);

		smooth = false;
		expect(controller.update("call-1", component, `${first}${"y".repeat(256)}`)).toBe(false);
		component.updateArgs({ command: "direct" });
		now = 1000;
		vi.advanceTimersByTime(1000);

		expect(commandOf(latestArgs(component))).toBe("direct");
	});

	test("#given an active reveal #when the configured fps changes #then refresh replaces the interval with the new PR3 cadence", () => {
		vi.useFakeTimers();
		let fps = 30;
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		const component = new RecordingArgsComponent();
		const { controller } = makeController({ getSmoothStreamingFps: () => fps });
		const first = makePartial("seed");
		controller.update("call-1", component, first);
		controller.update("call-1", component, `${first}${"x".repeat(256)}`);

		expect(intervalSpy.mock.calls.at(-1)?.[1]).toBeCloseTo(1000 / 30);
		fps = 120;
		controller.refresh();

		expect(intervalSpy.mock.calls.at(-1)?.[1]).toBeCloseTo(1000 / 120);
		controller.stop();
	});
});
