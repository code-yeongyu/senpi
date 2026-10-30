import {
	type AssistantMessage,
	fauxAssistantMessage,
	type ProviderDiagnostic,
	SERVER_FALLBACK_ABORTED_DIAGNOSTIC,
} from "@earendil-works/pi-ai";
import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { describeProviderFailure } from "../../../src/core/provider-failure.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#4954: a failed turn shows its classified error once, whatever its text and tool-call shape:
// on the row of the text run that ends the message, and on the turn-end line only when no row shows it.

type AgentEnd = Extract<AgentSessionEvent, { type: "agent_end" }>;
type Block = AssistantMessage["content"][number];

const LIMIT_TEXT =
	'429 {"error":{"message":"You\'ve reached your monthly usage limit","type":"exceeded_current_quota_error"}}';
const QUOTA: ProviderDiagnostic = {
	category: "quota",
	httpStatus: 429,
	code: "exceeded_current_quota_error",
	evidence: "structured_code",
};

const text = (value: string): Block => ({ type: "text", text: value });
const toolCall = (id: string): Block => ({ type: "toolCall", id, name: "bash", arguments: {} });

function failedTurn(blocks: Block[], diagnostic: ProviderDiagnostic = QUOTA): AssistantMessage {
	return {
		...fauxAssistantMessage(blocks, { stopReason: "error", errorMessage: LIMIT_TEXT }),
		providerDiagnostic: diagnostic,
	};
}

function agentEnd(message: AssistantMessage): AgentEnd {
	return {
		type: "agent_end",
		messages: [message],
		willRetry: false,
		failure: describeProviderFailure(message.providerDiagnostic, message.provider, { model: message.model }),
	};
}

async function turnEndLines(event: AgentEnd): Promise<string[]> {
	const showError = vi.fn<(line: string) => void>();
	const fixture = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { setScrollbackReplayHold: vi.fn(), requestRender: vi.fn() },
		clearActiveToolExecutionStatus: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		streamingReveal: { stop: vi.fn() },
		toolResultReveal: { stop: vi.fn() },
		chatContainer: { removeChild: vi.fn() },
		detachAssistantTextSegments: vi.fn(),
		clearPendingTools: vi.fn(),
		showError,
	};
	await Reflect.apply(Reflect.get(InteractiveMode.prototype, "handleEvent"), fixture, [event]);
	return showError.mock.calls.map(([line]) => line);
}

class ToolCardStub implements Component {
	render(): string[] {
		return ["TOOL-CARD"];
	}
	invalidate(): void {}
}

function renderedRows(message: AssistantMessage): string {
	const chatContainer = new Container();
	const streamingComponent = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, []);
	chatContainer.addChild(streamingComponent);
	const pendingTools = new Map<string, Component>();
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const card = new ToolCardStub();
		pendingTools.set(block.id, card);
		chatContainer.addChild(card);
	}
	const context = {
		streamingComponent,
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
	Reflect.apply(Reflect.get(InteractiveMode.prototype, "syncTrailingAssistantText"), context, [message]);
	return chatContainer.render(200).join("\n");
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const ROW_TEXT = "account usage limit has been reached";

describe("a classified provider failure shows once per turn (senpi#4954)", () => {
	it.each([
		["text only", [text("only")]],
		["tool call only", [toolCall("t1")]],
		["text, tool call, text", [text("first"), toolCall("t1"), text("second")]],
		["tool call, text", [toolCall("t1"), text("after")]],
		["text, tool call", [text("before"), toolCall("t1")]],
		["multiple tool calls", [toolCall("t1"), toolCall("t2")]],
		["text between multiple tool calls", [text("a"), toolCall("t1"), text("b"), toolCall("t2"), text("c")]],
	] as const)("%s: one error in total across rows and the turn-end line", async (_shape, blocks) => {
		initTheme("dark");
		const message = failedTurn([...blocks]);
		const rows = occurrences(renderedRows(message), ROW_TEXT);
		const turnEnd = (await turnEndLines(agentEnd(message))).length;
		expect(rows + turnEnd).toBe(1);
	});

	it("renders the error on one row of a text, tool call, text turn", () => {
		initTheme("dark");
		const rows = renderedRows(
			failedTurn([text("first"), toolCall("t1"), text("second"), toolCall("t2"), text("third")]),
		);
		expect(occurrences(rows, "account usage limit has been reached")).toBe(1);
	});

	it("adds no turn-end line when the trailing text run already shows the error", async () => {
		expect(await turnEndLines(agentEnd(failedTurn([text("first"), toolCall("t1"), text("second")])))).toEqual([]);
	});

	it("keeps the turn-end line when the message ends in a tool call and no row shows the error", async () => {
		expect(await turnEndLines(agentEnd(failedTurn([text("first"), toolCall("t1")])))).toHaveLength(1);
	});

	it("keeps the turn-end line for an aborted server fallback, whose row shows no error", async () => {
		const message = {
			...failedTurn([text("partial")]),
			diagnostics: [{ type: SERVER_FALLBACK_ABORTED_DIAGNOSTIC, timestamp: 0, details: {} }],
		};
		expect(await turnEndLines(agentEnd(message))).toHaveLength(1);
	});

	it("adds no turn-end line under a classified row even when the diagnostic is still unknown", async () => {
		const unknown: ProviderDiagnostic = { category: "unknown", httpStatus: 429, evidence: "structured_status" };
		expect(await turnEndLines(agentEnd(failedTurn([text("partial")], unknown)))).toEqual([]);
	});
});
