import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { StreamingRevealController } from "../../../src/modes/interactive/streaming-reveal.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createTimestampedComponent(message?: AssistantMessage): AssistantMessageComponent {
	return new AssistantMessageComponent(message, false, getMarkdownTheme(), "Thinking...", 1, [], true);
}

type TimestampSyncContext = {
	streamingComponent: AssistantMessageComponent;
	streamingReveal: Pick<StreamingRevealController, "isPacingHead">;
	chatContainer: Container;
	assistantTextSegments: Map<number, AssistantMessageComponent>;
	detachAssistantTextSegments: () => void;
	syncStreamingMessageTimestampEligibility: () => void;
	hideThinkingBlock: boolean;
	showMessageTimestamps: boolean;
	toolOutputExpanded: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	pendingTools: Map<string, Component>;
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers: () => [];
};

function createTimestampSyncContext(): TimestampSyncContext {
	const streamingComponent = createTimestampedComponent();
	const chatContainer = new Container();
	chatContainer.addChild(streamingComponent);
	return {
		streamingComponent,
		streamingReveal: { isPacingHead: () => false },
		chatContainer,
		assistantTextSegments: new Map(),
		detachAssistantTextSegments: () => {},
		syncStreamingMessageTimestampEligibility: Reflect.get(
			InteractiveMode.prototype,
			"syncStreamingMessageTimestampEligibility",
		),
		hideThinkingBlock: false,
		showMessageTimestamps: true,
		toolOutputExpanded: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		pendingTools: new Map(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
	};
}

function syncTrailingAssistantText(context: TimestampSyncContext, message: AssistantMessage): void {
	const sync: (this: TimestampSyncContext, value: AssistantMessage) => void = Reflect.get(
		InteractiveMode.prototype,
		"syncTrailingAssistantText",
	);
	sync.call(context, message);
}

describe("AssistantMessageComponent message timestamps", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("omits the timestamp by default", () => {
		// Given: local time is fixed and timestamp display uses its default setting.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const component = new AssistantMessageComponent(createAssistantMessage("Default output"));

		// When: the public component output is rendered.
		const lines = component.render(80).map(stripAnsi);

		// Then: no rendered line receives a clock prefix.
		expect(lines.some((line) => /^\d{2}:\d{2}:\d{2} /.test(line))).toBe(false);
	});

	it("prefixes the first non-empty content line with local time when enabled", () => {
		// Given: timestamp display is enabled at a fixed local time.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const component = createTimestampedComponent(createAssistantMessage("Timestamped output"));

		// When: the public component output is rendered.
		const lines = component.render(80).map(stripAnsi);
		const contentLine = lines.find((line) => line.includes("Timestamped output"));

		// Then: the content line, and only that line, carries the local HH:MM:SS prefix.
		expect(contentLine).toMatch(/^09:08:07 /);
		expect(lines.filter((line) => /^\d{2}:\d{2}:\d{2} /.test(line))).toHaveLength(1);
	});

	it("toggles only the timestamp prefix without rebuilding rendered content children", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const component = new AssistantMessageComponent(createAssistantMessage("Stable content"));
		const contentContainer = component.children[0];
		expect(contentContainer).toBeInstanceOf(Container);
		if (!(contentContainer instanceof Container)) throw new TypeError("Expected assistant content container");
		const contentChildren = [...contentContainer.children];

		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("09:08:07 ");
		component.setShowTimestamps(true);
		expect(component.render(80).map(stripAnsi).join("\n")).toMatch(/09:08:07\s+Stable content/);
		component.setTimestampEligible(false);
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("09:08:07 ");
		component.setTimestampEligible(true);
		component.setShowTimestamps(false);

		expect(contentContainer.children).toHaveLength(contentChildren.length);
		expect(contentContainer.children.every((child, index) => child === contentChildren[index])).toBe(true);
		expect(component.render(80).map(stripAnsi).join("\n")).not.toContain("09:08:07 ");
	});

	it("retains the first update time across later updates and width rerenders", () => {
		// Given: the first content delta arrives at a fixed local time.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const component = createTimestampedComponent();
		component.updateContent(createAssistantMessage("First delta"));

		// When: a later delta arrives at another time and the component rerenders at two widths.
		vi.setSystemTime(new Date(2026, 7, 30, 10, 11, 12));
		component.updateContent(createAssistantMessage("Second delta with enough text to wrap at a narrow width"));
		const wideLines = component.render(80).map(stripAnsi);
		const narrowLines = component.render(24).map(stripAnsi);

		// Then: both content renders retain the first arrival time rather than the update time.
		expect(wideLines.find((line) => line.includes("Second delta"))).toMatch(/^09:08:07 /);
		expect(narrowLines.find((line) => line.includes("Second delta"))).toMatch(/^09:08:07 /);
		expect([...wideLines, ...narrowLines].join("\n")).not.toContain("10:11:12");
		expect(narrowLines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	});

	it("never exceeds widths 9 through 12 when the timestamp and markdown padding cannot both fit", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const component = createTimestampedComponent(createAssistantMessage("a"));

		const renders = [9, 10, 11, 12].map((width) => ({
			width,
			lines: component.render(width).map(stripAnsi),
		}));

		for (const { width, lines } of renders) {
			expect(
				lines.every((line) => visibleWidth(line) <= width),
				`render width ${width}`,
			).toBe(true);
		}
		expect(
			renders
				.slice(0, 3)
				.flatMap(({ lines }) => lines)
				.join("\n"),
		).not.toContain("09:08:07 ");
		expect(renders[3]?.lines.join("\n")).toContain("09:08:07 ");
	});

	it("keeps the timestamp eligible until smooth streaming reveals visible content", () => {
		// Given: smooth streaming has stamped an empty initial frame at message arrival.
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const context = createTimestampSyncContext();
		const reveal = new StreamingRevealController({
			getSmoothStreaming: () => true,
			getSmoothStreamingFps: () => 60,
			getHideThinkingBlock: () => false,
			requestRender: () => {},
		});
		context.streamingReveal = reveal;
		reveal.begin(context.streamingComponent, createAssistantMessage(""));
		context.syncStreamingMessageTimestampEligibility();

		// When: a later target becomes visible through reveal ticks before message_end.
		vi.setSystemTime(new Date(2026, 7, 30, 10, 11, 12));
		reveal.setTarget(createAssistantMessage("First revealed content"));
		vi.advanceTimersByTime(250);
		const lines = context.chatContainer.render(80).map(stripAnsi);
		reveal.stop();

		// Then: the first revealed line keeps the message-arrival prefix.
		expect(lines.find((line) => line.includes("First revealed"))).toMatch(/^09:08:07 /);
		expect(lines.join("\n")).not.toContain("10:11:12 ");
	});

	it("prefixes a tool-segmented assistant message exactly once", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const context = createTimestampSyncContext();
		const message = fauxAssistantMessage([
			{ type: "text", text: "before tool" },
			{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			{ type: "text", text: "after tool" },
		]);

		syncTrailingAssistantText(context, message);
		const lines = context.chatContainer.render(80).map(stripAnsi);

		expect(lines.filter((line) => /^09:08:07 /.test(line))).toHaveLength(1);
		expect(lines.join("\n")).toContain("before tool");
		expect(lines.join("\n")).toContain("after tool");
	});

	it("uses the message arrival time when the first visible content follows a tool call", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 7, 30, 9, 8, 7));
		const context = createTimestampSyncContext();
		const toolCall = { type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "file.txt" } };
		syncTrailingAssistantText(context, fauxAssistantMessage([toolCall]));

		vi.setSystemTime(new Date(2026, 7, 30, 10, 11, 12));
		syncTrailingAssistantText(
			context,
			fauxAssistantMessage([toolCall, { type: "text", text: "visible after tool" }]),
		);
		const lines = context.chatContainer.render(80).map(stripAnsi);

		expect(lines.filter((line) => /^09:08:07 /.test(line))).toHaveLength(1);
		expect(lines.join("\n")).not.toContain("10:11:12 ");
	});
});
