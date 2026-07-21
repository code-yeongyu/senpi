import { afterEach, describe, expect, test, vi } from "vitest";
import type { ToolExecutionResult } from "../src/modes/interactive/components/tool-execution-types.ts";
import { DEFAULT_SMOOTH_FPS } from "../src/modes/interactive/streaming-reveal.ts";
import { ToolResultRevealController } from "../src/modes/interactive/tool-result-reveal.ts";

class RecordingComponent {
	readonly results: Array<{ result: ToolExecutionResult; isPartial: boolean }> = [];

	updateResult(result: ToolExecutionResult, isPartial = false): void {
		this.results.push({ result, isPartial });
	}
}

function textResult(text: string, details?: unknown): ToolExecutionResult {
	return {
		content: [{ type: "text", text }],
		details,
		isError: false,
	};
}

function imageResult(details?: unknown): ToolExecutionResult {
	return {
		content: [{ type: "image", data: "AQ==", mimeType: "image/png" }],
		details,
		isError: false,
	};
}

function latestText(component: RecordingComponent): string {
	const latest = component.results.at(-1)?.result.content[0];
	if (latest?.type !== "text") throw new Error("Expected a text result");
	return latest.text;
}

function makeController(options: { readonly smooth?: () => boolean; readonly fps?: () => number } = {}): {
	controller: ToolResultRevealController;
	requestRender: ReturnType<typeof vi.fn>;
} {
	const requestRender = vi.fn();
	return {
		controller: new ToolResultRevealController({
			getSmoothStreaming: options.smooth ?? (() => true),
			getSmoothStreamingFps: options.fps ?? (() => DEFAULT_SMOOTH_FPS),
			requestRender,
		}),
		requestRender,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("ToolResultRevealController", () => {
	test("reveals append-only text growth gradually across timer ticks", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { controller, requestRender } = makeController();
		const component = new RecordingComponent();

		expect(controller.update("call-1", component, textResult(""))).toBe(true);
		expect(controller.update("call-1", component, textResult("abcdefghijklmnopqrst"))).toBe(true);
		expect(latestText(component)).toBe("");

		for (let tick = 1; tick <= 4; tick++) {
			now = tick * (1000 / DEFAULT_SMOOTH_FPS);
			vi.advanceTimersByTime(17);
		}

		const revealed = component.results.slice(1).map(({ result }) => {
			const content = result.content[0];
			return content?.type === "text" ? content.text : "";
		});
		expect(revealed).toHaveLength(4);
		expect(revealed.every((text, index) => index === 0 || text.length > revealed[index - 1]!.length)).toBe(true);
		expect(revealed.at(-1)?.length).toBeLessThan("abcdefghijklmnopqrst".length);
		expect(requestRender).toHaveBeenCalledTimes(4);
		controller.stop();
	});

	test("flushes a non-prefix replacement immediately", () => {
		vi.useFakeTimers();
		const { controller } = makeController();
		const component = new RecordingComponent();

		controller.update("call-1", component, textResult("old status"));
		expect(controller.update("call-1", component, textResult("new status"))).toBe(true);

		expect(latestText(component)).toBe("new status");
		controller.stop();
	});

	test("finish flushes the unrevealed target", () => {
		vi.useFakeTimers();
		const { controller } = makeController();
		const component = new RecordingComponent();

		controller.update("call-1", component, textResult(""));
		controller.update("call-1", component, textResult("pending output"));
		controller.finish("call-1");

		expect(latestText(component)).toBe("pending output");
		controller.stop();
	});

	test("bypasses animation when smooth streaming is disabled", () => {
		vi.useFakeTimers();
		const { controller } = makeController({ smooth: () => false });
		const component = new RecordingComponent();
		const result = textResult("instant");

		expect(controller.update("call-1", component, result)).toBe(false);
		expect(component.results).toHaveLength(0);
		controller.stop();
	});

	test("preserves the partial details object by identity", () => {
		vi.useFakeTimers();
		const { controller } = makeController();
		const component = new RecordingComponent();
		const details = { progress: { startedAt: 1, activity: "running" } };

		controller.update("call-1", component, textResult("output", details));

		expect(component.results.at(-1)?.result.details).toBe(details);
		controller.stop();
	});

	test("discards a text backlog before bypassing a no-text partial", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { controller } = makeController();
		const component = new RecordingComponent();

		controller.update("call-1", component, textResult(""));
		controller.update("call-1", component, textResult("stale text backlog"));
		const directResult = imageResult({ phase: "complete" });
		expect(controller.update("call-1", component, directResult)).toBe(false);
		component.updateResult(directResult, true);

		now = 1000 / DEFAULT_SMOOTH_FPS;
		vi.advanceTimersByTime(17);

		expect(component.results.at(-1)?.result).toBe(directResult);
		controller.stop();
	});

	test("refresh flushes and clears a backlog when smooth streaming is toggled off", () => {
		vi.useFakeTimers();
		let smooth = true;
		const { controller } = makeController({ smooth: () => smooth });
		const component = new RecordingComponent();

		controller.update("call-1", component, textResult(""));
		controller.update("call-1", component, textResult("queued output"));
		smooth = false;
		controller.refresh();
		const updateCount = component.results.length;

		expect(latestText(component)).toBe("queued output");
		vi.advanceTimersByTime(1000);
		expect(component.results).toHaveLength(updateCount);
		controller.stop();
	});
});
