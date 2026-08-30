import type { AssistantMessage } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { getMarkdownTheme, initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

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
});
