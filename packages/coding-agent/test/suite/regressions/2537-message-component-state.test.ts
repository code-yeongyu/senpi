import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const fakeUi = { requestRender: () => {} } as TUI;

function reply(text: string): AssistantMessage {
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
		timestamp: 0,
	};
}

function finishedBashCard(): ToolExecutionComponent {
	const card = new ToolExecutionComponent("bash", "call-1", { command: "ls" }, {}, undefined, fakeUi, process.cwd());
	const text = Array.from({ length: 30 }, (_, line) => `output line ${line}`).join("\n");
	card.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return card;
}

beforeEach(() => {
	initTheme("dark");
});

describe("per-message component state (#2537)", () => {
	it("does not give every message its own markdown theme", () => {
		// Given: two assistant messages mounted in the transcript
		const first = new AssistantMessageComponent(reply("first"));
		const second = new AssistantMessageComponent(reply("second"));

		// Then: they share one markdown theme instead of each keeping a copy
		expect(Reflect.get(first, "markdownTheme")).toBe(Reflect.get(second, "markdownTheme"));
	});

	it("still gives an extension its own markdown theme to customize", () => {
		// Given: an extension takes the public markdown theme and customizes it
		const custom = getMarkdownTheme();
		custom.codeBlockIndent = "    ";

		// Then: the change sticks on its copy and does not reach anyone else's theme
		expect(custom.codeBlockIndent).toBe("    ");
		expect(getMarkdownTheme()).not.toBe(custom);
		expect(getMarkdownTheme().codeBlockIndent).not.toBe("    ");
		expect(Reflect.get(new AssistantMessageComponent(reply("x")), "markdownTheme")).not.toBe(custom);
	});

	it("paints a message mounted after a theme switch in the new theme, even for text rendered before", () => {
		// Given: a message rendered under the dark theme
		const dark = new AssistantMessageComponent(reply("# Same heading")).render(80).join("\n");

		// When: the theme switches and the same text arrives in a new message
		initTheme("light");
		const light = new AssistantMessageComponent(reply("# Same heading")).render(80).join("\n");

		// Then: it is painted in the light theme's colors, not served from the dark render
		expect(light).toContain("Same heading");
		expect(light).not.toBe(dark);
	});

	it("drops the renderer's copy of the last render state when a card is released", () => {
		// Given: a finished card that was painted, then released (it scrolled above the kept history)
		const card = finishedBashCard();
		const painted = card.render(100);
		card.invalidate();

		// Then: the renderer no longer holds the result it last rendered
		const renderer = Reflect.get(card, "renderer");
		expect(Reflect.get(Reflect.get(renderer, "state"), "result")).toBeUndefined();

		// And: painting the card again shows the same lines
		expect(card.render(100)).toEqual(painted);
	});
});
