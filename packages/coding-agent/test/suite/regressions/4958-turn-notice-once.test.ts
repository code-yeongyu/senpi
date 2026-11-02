import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createPresentationHarness } from "../provider-error-presentation-harness.ts";

// senpi#4958: a turn-ending notice (provider error or output-token limit) shows once per turn, in the
// live transcript and when the session is replayed, whatever the turn's text and tool-call shape.

type Block = AssistantMessage["content"][number];

const LIMIT_TEXT =
	'429 {"error":{"message":"You\'ve reached your monthly usage limit","type":"exceeded_current_quota_error"}}';
const ERROR_ROW = "account usage limit has been reached";
const LENGTH_ROW = "maximum output token limit";
const ABORT_ROW = "Operation aborted";

const text = (value: string): Block => ({ type: "text", text: value });
const toolCall = (id: string): Block => ({ type: "toolCall", id, name: "bash", arguments: {} });

const SHAPES: ReadonlyArray<readonly [string, readonly Block[]]> = [
	["text only", [text("only")]],
	["tool call only", [toolCall("t1")]],
	["text, tool call, text", [text("first"), toolCall("t1"), text("second")]],
	["tool call, text", [toolCall("t1"), text("after")]],
	["text, tool call", [text("before"), toolCall("t1")]],
	["multiple tool calls", [toolCall("t1"), toolCall("t2")]],
	["text between multiple tool calls", [text("a"), toolCall("t1"), text("b"), toolCall("t2"), text("c")]],
	["text between tool calls, ending in a tool call", [text("a"), toolCall("t1"), text("b"), toolCall("t2")]],
];

function turn(blocks: readonly Block[], stopReason: "aborted" | "error" | "length" | "stop"): AssistantMessage {
	return fauxAssistantMessage([...blocks], {
		stopReason,
		...(stopReason === "error" ? { errorMessage: LIMIT_TEXT } : {}),
	});
}

class ToolCardStub implements Component {
	render(): string[] {
		return ["TOOL-CARD"];
	}
	invalidate(): void {}
	setExpanded(): void {}
	updateResult(): void {}
}

function renderingContext(message: AssistantMessage) {
	const chatContainer = new Container();
	const pendingTools = new Map<string, Component>();
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const card = new ToolCardStub();
		pendingTools.set(block.id, card);
		chatContainer.addChild(card);
	}
	return {
		chatContainer,
		assistantTextSegments: new Map<number, AssistantMessageComponent>(),
		detachAssistantTextSegments: Reflect.get(InteractiveMode.prototype, "detachAssistantTextSegments"),
		hideThinkingBlock: false,
		toolOutputExpanded: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		pendingTools,
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
	};
}

function liveRows(steps: readonly AssistantMessage[]): string {
	const last = steps.at(-1);
	if (last === undefined) throw new Error("no steps");
	const context = renderingContext(last);
	const streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, []);
	context.chatContainer.addChild(streamingComponent);
	const sync = Reflect.get(InteractiveMode.prototype, "syncTrailingAssistantText");
	for (const step of steps) Reflect.apply(sync, { ...context, streamingComponent }, [step]);
	return context.chatContainer.render(200).join("\n");
}

/** Replays the message through the real session replay path (`renderSessionItems` -> `replayAssistantTools`). */
function replayedRows(message: AssistantMessage): string {
	const harness = createPresentationHarness();
	// Tool cards need a live session to resolve names; the replay path under test only places them.
	Reflect.set(harness.mode, "createToolExecutionComponent", () => new ToolCardStub());
	Reflect.apply(Reflect.get(harness.mode, "renderSessionItems"), harness.mode, [[message]]);
	const rows = harness.render(200);
	harness.dispose();
	return rows;
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("a turn-ending notice shows once per turn (senpi#4958)", () => {
	it.each(SHAPES)("%s: a length stop shows its notice once live", (_shape, blocks) => {
		initTheme("dark");
		expect(occurrences(liveRows([turn(blocks, "length")]), LENGTH_ROW)).toBe(1);
	});

	it.each(SHAPES)("%s: a replayed failed turn shows its error once", (_shape, blocks) => {
		initTheme("dark");
		expect(occurrences(replayedRows(turn(blocks, "error")), ERROR_ROW)).toBe(1);
	});

	it.each(SHAPES)("%s: a replayed length stop shows its notice once", (_shape, blocks) => {
		initTheme("dark");
		expect(occurrences(replayedRows(turn(blocks, "length")), LENGTH_ROW)).toBe(1);
	});

	// Live mode gives an abort notice only to the text run that ends the message; a turn ending in a tool call shows it on the card.
	it.each([
		["tool call, text", [toolCall("t1"), text("after")], 1],
		["text, tool call", [text("before"), toolCall("t1")], 0],
		["text between tool calls, ending in a tool call", [text("a"), toolCall("t1"), text("b"), toolCall("t2")], 0],
	] as const)("%s: a replayed aborted turn puts its notice only on a closing text run", (_shape, blocks, rows) => {
		initTheme("dark");
		expect(occurrences(replayedRows(turn(blocks, "aborted")), ABORT_ROW)).toBe(rows);
	});

	it("keeps one error row when the rows were created while the turn was still streaming", () => {
		initTheme("dark");
		const blocks = [text("a"), toolCall("t1"), text("b"), toolCall("t2"), text("c")];
		const streaming = [turn(blocks.slice(0, 3), "stop"), turn(blocks, "stop"), turn(blocks, "error")];
		expect(occurrences(liveRows(streaming), ERROR_ROW)).toBe(1);
	});
});
