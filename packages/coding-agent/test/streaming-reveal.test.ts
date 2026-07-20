import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getGraphemeSegmenter } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	BlockUnitCounter,
	buildDisplayMessage,
	CATCHUP_WINDOW_MS,
	DEFAULT_SMOOTH_FPS,
	MAX_SMOOTH_FPS,
	MIN_REVEAL_UNITS_PER_SEC,
	MIN_SMOOTH_FPS,
	nextStep,
	StreamingRevealController,
	visibleUnits,
} from "../src/modes/interactive/streaming-reveal.ts";

function makeMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "errorMessage" | "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		errorMessage: overrides.errorMessage,
		timestamp: 0,
	};
}

function fullSlice(text: string, units: number): string {
	if (units <= 0) return "";
	const segments = [...getGraphemeSegmenter().segment(text)];
	const segment = segments[Math.floor(units) - 1];
	return segment === undefined ? text : text.slice(0, segment.index + segment.segment.length);
}

function textAt(message: AssistantMessage, index = 0): string {
	const block = message.content[index];
	if (block?.type !== "text") throw new TypeError(`Expected text block at index ${index}`);
	return block.text;
}

function thinkingAt(message: AssistantMessage, index = 0): string {
	const block = message.content[index];
	if (block?.type !== "thinking") throw new TypeError(`Expected thinking block at index ${index}`);
	return block.thinking;
}

class RecordingComponent {
	readonly messages: AssistantMessage[] = [];

	updateContent(message: AssistantMessage): void {
		this.messages.push(message);
	}
}

function latestMessage(component: RecordingComponent): AssistantMessage {
	const message = component.messages.at(-1);
	if (!message) throw new Error("Expected at least one rendered message");
	return message;
}

type ControllerHarness = {
	readonly component: RecordingComponent;
	readonly controller: StreamingRevealController;
	readonly requestRender: ReturnType<typeof vi.fn>;
};

function makeController(
	options: {
		readonly fps?: () => number;
		readonly hideThinking?: () => boolean;
		readonly smooth?: () => boolean;
	} = {},
): ControllerHarness {
	const component = new RecordingComponent();
	const requestRender = vi.fn();
	const controller = new StreamingRevealController({
		getSmoothStreaming: options.smooth ?? (() => true),
		getSmoothStreamingFps: options.fps ?? (() => DEFAULT_SMOOTH_FPS),
		getHideThinkingBlock: options.hideThinking ?? (() => false),
		requestRender,
	});
	return { component, controller, requestRender };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("BlockUnitCounter", () => {
	test.each([
		["ASCII", ["a", "ab", "abc"]],
		["Korean", ["한", "한글", "한글날"]],
		["emoji ZWJ", ["👨", "👨‍👩", "👨‍👩‍👧", "👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦!"]],
		["combining marks", ["e", "e\u0301", "e\u0301x", "e\u0301x\u0323"]],
	] as const)("#given an append-only %s stream #when counting and slicing deltas #then matches a full grapheme recount", (_name, sequence) => {
		const counter = new BlockUnitCounter();
		for (const text of sequence) {
			const fullCount = [...getGraphemeSegmenter().segment(text)].length;
			expect(counter.count(0, text)).toBe(fullCount);
			for (let units = 0; units <= fullCount + 1; units++) {
				expect(counter.slice(0, text, units)).toBe(fullSlice(text, units));
			}
		}
	});

	test("#given a cached short suffix #when text appends #then slices the new grapheme through the fast path", () => {
		const counter = new BlockUnitCounter();

		expect(counter.slice(0, "a", 2)).toBe("a");
		expect(counter.slice(0, "ab", 2)).toBe("ab");
		expect(counter.slice(1, "abc", 1.2)).toBe("a");
	});
});

describe("streaming reveal pure helpers", () => {
	test("#given PR3 pacing constants #when imported #then pins the literal design contract", () => {
		expect(MIN_REVEAL_UNITS_PER_SEC).toBe(90);
		expect(CATCHUP_WINDOW_MS).toBe(267);
		expect(MIN_SMOOTH_FPS).toBe(30);
		expect(DEFAULT_SMOOTH_FPS).toBe(60);
		expect(MAX_SMOOTH_FPS).toBe(120);
	});

	test("#given mixed ordered blocks #when slicing visible units #then preserves raw thinking and passthrough blocks", () => {
		const family = "👨‍👩‍👧‍👦";
		const thinking = { type: "thinking" as const, thinking: "한글" };
		const providerNative = { type: "providerNative" as const, subtype: "status", raw: { state: "running" } };
		const toolCall = {
			type: "toolCall" as const,
			id: "call-1",
			name: "read",
			arguments: { path: "README.md" },
		};
		const target = makeMessage([
			{ type: "text", text: "A" },
			thinking,
			providerNative,
			{ type: "text", text: `${family}B` },
			toolCall,
		]);

		const visible = buildDisplayMessage(target, 4, false);
		const hidden = buildDisplayMessage(target, 2, true);

		expect(visibleUnits(target, false)).toBe(5);
		expect(thinkingAt(visible, 1)).toBe("한글");
		expect(textAt(visible, 3)).toBe(family);
		expect(visible.content[2]).toBe(providerNative);
		expect(visible.content[4]).toBe(toolCall);
		expect(visibleUnits(target, true)).toBe(3);
		expect(hidden.content[1]).toBe(thinking);
		expect(textAt(hidden, 3)).toBe(family);
		expect(textAt(target, 3)).toBe(`${family}B`);
	});

	test("#given a fixed backlog #when stepping at 30 60 and 120fps #then completion times stay within one 30fps tick", () => {
		const revealTime = (fps: number): number => {
			const dt = 1000 / fps;
			let backlog = 9;
			let elapsed = 0;
			while (backlog > 0) {
				backlog -= nextStep(backlog, dt);
				elapsed += dt;
			}
			return elapsed;
		};
		const times = [MIN_SMOOTH_FPS, DEFAULT_SMOOTH_FPS, MAX_SMOOTH_FPS].map(revealTime);

		expect(Math.max(...times) - Math.min(...times)).toBeLessThanOrEqual(1000 / MIN_SMOOTH_FPS);
	});

	test("#given floor catchup and jitter inputs #when choosing a step #then uses the exact time-based bounds", () => {
		const dt = 1000 / DEFAULT_SMOOTH_FPS;
		const backlog = 1000;
		const catchupStep = nextStep(backlog, dt);

		expect(nextStep(0, dt)).toBe(0);
		expect(nextStep(10, 1000 / MIN_SMOOTH_FPS)).toBe(Math.round(MIN_REVEAL_UNITS_PER_SEC / MIN_SMOOTH_FPS));
		expect((backlog / catchupStep) * dt).toBeLessThanOrEqual(CATCHUP_WINDOW_MS);
		expect(nextStep(backlog, 0)).toBe(nextStep(backlog, 1));
		expect(nextStep(backlog, 1000)).toBe(nextStep(backlog, 100));
		expect(nextStep(backlog, 100)).toBe(375);
	});
});

describe("StreamingRevealController", () => {
	test("#given an active reveal #when begin replaces it #then cancels the old interval", () => {
		vi.useFakeTimers();
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "first" }]));
		controller.begin(new RecordingComponent(), makeMessage([{ type: "text", text: "second" }]));

		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		controller.stop();
	});

	test("#given a growing target #when ticks advance #then rendered prefixes grow monotonically", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller, requestRender } = makeController();
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghijklmnopqrst" }]));
		const beforeTicks = component.messages.length;

		for (let tick = 1; tick <= 4; tick++) {
			now = tick * (1000 / DEFAULT_SMOOTH_FPS);
			vi.advanceTimersByTime(17);
		}
		const lengths = component.messages.slice(beforeTicks).map((message) => textAt(message).length);

		expect(lengths).toHaveLength(4);
		expect(lengths.every((length, index) => index === 0 || length > lengths[index - 1]!)).toBe(true);
		expect(requestRender).toHaveBeenCalledTimes(4);
		controller.stop();
	});

	test("#given an event-loop stall #when a tick runs #then clamps real performance delta to 100ms", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({ fps: () => MIN_SMOOTH_FPS });
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "a".repeat(1000) }]));

		now = 1000;
		vi.advanceTimersByTime(34);

		expect(textAt(latestMessage(component))).toHaveLength(nextStep(1000, 100));
		controller.stop();
	});

	test("#given an active reveal #when smoothing is disabled #then snaps full and cancels pacing", () => {
		vi.useFakeTimers();
		let smooth = true;
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller, requestRender } = makeController({ smooth: () => smooth });
		controller.begin(component, makeMessage([{ type: "text", text: "chunk" }]));

		smooth = false;
		const finalTarget = makeMessage([{ type: "text", text: "chunky" }]);
		controller.setTarget(finalTarget);
		const updates = component.messages.length;
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(finalTarget);
		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		expect(component.messages).toHaveLength(updates);
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("#given a partial reveal #when a tool call arrives #then jumps to full text and cancels ticking", () => {
		vi.useFakeTimers();
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({ fps: () => MIN_SMOOTH_FPS });
		controller.begin(component, makeMessage([{ type: "text", text: "" }]));
		controller.setTarget(makeMessage([{ type: "text", text: "abcdefghi" }]));
		now = 1000 / MIN_SMOOTH_FPS;
		vi.advanceTimersByTime(34);
		expect(textAt(latestMessage(component))).toBe("abc");

		const withTool = makeMessage([
			{ type: "text", text: "abcdefghi" },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
		]);
		controller.setTarget(withTool);
		const updates = component.messages.length;
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(withTool);
		expect(component.messages).toHaveLength(updates);
	});

	test("#given an active reveal #when stopped and final content is flushed directly #then no timer overwrites it", () => {
		vi.useFakeTimers();
		const { component, controller } = makeController();
		controller.begin(component, makeMessage([{ type: "text", text: "streaming" }]));

		controller.stop();
		const finalMessage = makeMessage([{ type: "text", text: "final" }], { stopReason: "length" });
		component.updateContent(finalMessage);
		vi.advanceTimersByTime(1000);

		expect(latestMessage(component)).toBe(finalMessage);
	});

	test("#given visibility changes mid-stream #when resynced #then hidden thinking consumes no units", () => {
		vi.useFakeTimers();
		let now = 0;
		let hidden = false;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { component, controller } = makeController({
			fps: () => MIN_SMOOTH_FPS,
			hideThinking: () => hidden,
		});
		controller.begin(
			component,
			makeMessage([
				{ type: "thinking", thinking: "think" },
				{ type: "text", text: "answer" },
			]),
		);
		now = 1000 / MIN_SMOOTH_FPS;
		vi.advanceTimersByTime(34);
		expect(thinkingAt(latestMessage(component))).toBe("thi");

		hidden = true;
		controller.resyncVisibility();

		expect(thinkingAt(latestMessage(component))).toBe("think");
		expect(textAt(latestMessage(component), 1)).toBe("ans");
		controller.stop();
	});

	test("#given fps changes while active #when target resyncs #then restarts at the clamped fps", () => {
		vi.useFakeTimers();
		let fps = DEFAULT_SMOOTH_FPS;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		const { component, controller } = makeController({ fps: () => fps });
		const target = makeMessage([{ type: "text", text: "a".repeat(100) }]);
		controller.begin(component, target);

		fps = 500;
		controller.setTarget(target);

		expect(setIntervalSpy).toHaveBeenNthCalledWith(1, expect.any(Function), 1000 / DEFAULT_SMOOTH_FPS);
		expect(setIntervalSpy).toHaveBeenNthCalledWith(2, expect.any(Function), 1000 / MAX_SMOOTH_FPS);
		expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
		controller.stop();
	});

	test("#given an active reveal #when its timer starts #then the handle is unrefed", () => {
		const unref = vi.fn();
		const handle = { unref } as unknown as NodeJS.Timeout;
		vi.spyOn(globalThis, "setInterval").mockReturnValue(handle);
		const { component, controller } = makeController();

		controller.begin(component, makeMessage([{ type: "text", text: "pending" }]));

		expect(unref).toHaveBeenCalledTimes(1);
		controller.stop();
	});
});
