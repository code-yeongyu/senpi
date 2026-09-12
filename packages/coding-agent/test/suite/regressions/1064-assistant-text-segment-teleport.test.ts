import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme } from "../../../src/modes/interactive/theme/theme.ts";

/**
 * Regression 1064: during an agentic turn the TUI "shakes up and down" because
 * assistant text painted between tool cards teleports upward on every new
 * toolCall. `syncTrailingAssistantText` parks text after the last toolCall in a
 * trailing component below the cards, then — when the next toolCall arrives —
 * detaches it and reabsorbs its text into the streaming head, which renders
 * ABOVE every tool card. These tests pin the chronological invariant instead:
 * once a text segment is painted below a tool card, it stays there.
 */

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, never> };
type TextBlock = { type: "text"; text: string };
type Block = TextBlock | ToolCallBlock;

function textBlock(text: string): TextBlock {
	return { type: "text", text };
}

function toolCallBlock(id: string): ToolCallBlock {
	return { type: "toolCall", id, name: "bash", arguments: {} };
}

class ToolCardStub implements Component {
	private readonly label: string;
	constructor(label: string) {
		this.label = label;
	}
	render(_width: number): string[] {
		return [this.label];
	}
	invalidate(): void {}
}

type SyncContext = {
	streamingComponent: AssistantMessageComponent | undefined;
	chatContainer: Container;
	assistantTextSegments: Map<number, AssistantMessageComponent>;
	detachAssistantTextSegments: () => void;
	hideThinkingBlock: boolean;
	toolOutputExpanded: boolean;
	hiddenThinkingLabel: string;
	outputPad: number;
	pendingTools: Map<string, Component>;
	getMarkdownThemeWithSettings: () => ReturnType<typeof getMarkdownTheme>;
	getMarkdownTransformers: () => [];
};

function createStreamContext(): SyncContext {
	const chatContainer = new Container();
	const streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, []);
	chatContainer.addChild(streamingComponent);
	return {
		streamingComponent,
		chatContainer,
		assistantTextSegments: new Map<number, AssistantMessageComponent>(),
		detachAssistantTextSegments: Reflect.get(InteractiveMode.prototype, "detachAssistantTextSegments"),
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		pendingTools: new Map<string, Component>(),
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
	};
}

function syncTrailing(ctx: SyncContext, blocks: Block[]): void {
	const sync = Reflect.get(InteractiveMode.prototype, "syncTrailingAssistantText") as (
		this: unknown,
		message: AssistantMessage,
	) => void;
	sync.call(ctx, fauxAssistantMessage(blocks));
}

/** Mirrors the message_update tools loop: a new toolCall's card is appended at the end. */
function arriveToolCard(ctx: SyncContext, id: string, label: string): void {
	const card = new ToolCardStub(label);
	ctx.pendingTools.set(id, card);
	ctx.chatContainer.addChild(card);
}

function renderedLines(ctx: SyncContext): string {
	return ctx.chatContainer.render(80).join("\n");
}

describe("1064: assistant text segments keep their painted position between tool cards", () => {
	it("keeps an interleaved stream chronological: text painted below a tool card never teleports above it", () => {
		const ctx = createStreamContext();
		const ALPHA = "ALPHA-NARRATION";
		const BRAVO = "BRAVO-NARRATION";
		const CHARLIE = "CHARLIE-NARRATION";

		syncTrailing(ctx, [textBlock(ALPHA)]);
		arriveToolCard(ctx, "t1", "TOOL-CARD-ONE");
		syncTrailing(ctx, [textBlock(ALPHA), toolCallBlock("t1")]);
		syncTrailing(ctx, [textBlock(ALPHA), toolCallBlock("t1"), textBlock(BRAVO)]);

		const bravoComponent = ctx.chatContainer.children[ctx.chatContainer.children.length - 1];
		expect(renderedLines(ctx)).toContain(BRAVO);

		arriveToolCard(ctx, "t2", "TOOL-CARD-TWO");
		syncTrailing(ctx, [textBlock(ALPHA), toolCallBlock("t1"), textBlock(BRAVO), toolCallBlock("t2")]);

		expect(ctx.chatContainer.children).toContain(bravoComponent);
		const streamingLines = ctx.streamingComponent?.render(80).join("\n") ?? "";
		expect(streamingLines).not.toContain(BRAVO);

		syncTrailing(ctx, [
			textBlock(ALPHA),
			toolCallBlock("t1"),
			textBlock(BRAVO),
			toolCallBlock("t2"),
			textBlock(CHARLIE),
		]);

		const lines = renderedLines(ctx);
		const order = [ALPHA, "TOOL-CARD-ONE", BRAVO, "TOOL-CARD-TWO", CHARLIE].map((marker) => lines.indexOf(marker));
		expect(order.every((position) => position >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("renders a text-only message entirely inside the streaming component", () => {
		const ctx = createStreamContext();
		syncTrailing(ctx, [textBlock("ONLY-TEXT")]);
		expect(ctx.chatContainer.children).toHaveLength(1);
		expect(renderedLines(ctx)).toContain("ONLY-TEXT");
	});

	it("keeps a catch-up message (all blocks delivered in one event) chronological", () => {
		const ctx = createStreamContext();
		const ALPHA = "ALPHA-CATCHUP";
		const BRAVO = "BRAVO-CATCHUP";
		const CHARLIE = "CHARLIE-CATCHUP";

		arriveToolCard(ctx, "t1", "TOOL-CARD-ONE");
		arriveToolCard(ctx, "t2", "TOOL-CARD-TWO");
		syncTrailing(ctx, [
			textBlock(ALPHA),
			toolCallBlock("t1"),
			textBlock(BRAVO),
			toolCallBlock("t2"),
			textBlock(CHARLIE),
		]);

		const lines = renderedLines(ctx);
		const order = [ALPHA, "TOOL-CARD-ONE", BRAVO, "TOOL-CARD-TWO", CHARLIE].map((marker) => lines.indexOf(marker));
		expect(order.every((position) => position >= 0)).toBe(true);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("detaches every painted segment on the abort/reset path", () => {
		const ctx = createStreamContext();
		arriveToolCard(ctx, "t1", "TOOL-CARD-ONE");
		syncTrailing(ctx, [textBlock("ALPHA-ABORT"), toolCallBlock("t1"), textBlock("BRAVO-ABORT")]);
		expect(ctx.chatContainer.children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(2);

		ctx.detachAssistantTextSegments();

		expect(ctx.chatContainer.children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(1);
		expect(ctx.assistantTextSegments.size).toBe(0);
		expect(renderedLines(ctx)).not.toContain("BRAVO-ABORT");
	});
});
