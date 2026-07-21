import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { ToolResultRevealController } from "../src/modes/interactive/tool-result-reveal.ts";

type ToolComponent = {
	updateResult: (result: { content: readonly { type: "text"; text: string }[] }, isPartial?: boolean) => void;
};

type WiringFixture = {
	activeToolExecutionTerminalTitle: string | undefined;
	activeToolExecutions: Map<string, string>;
	applyTerminalTitle: () => void;
	chatContainer: { removeChild: (component: unknown) => void };
	clearActiveToolExecutionStatus: () => void;
	clearPendingTools: () => void;
	clearStatusIndicator: (kind: "working") => void;
	clearToolHookStatuses: () => void;
	footer: { invalidate: () => void };
	handleToolExecutionEnd: (event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>) => void;
	isInitialized: true;
	pendingTools: Map<string, ToolComponent>;
	refreshWorkingLoaderMessage: () => void;
	requestStreamingRender: () => void;
	settingsManager: { getShowTerminalProgress: () => boolean };
	streamingComponent: undefined;
	streamingReveal: { stop: () => void };
	toolArgsReveal: { finish: (id: string) => void };
	toolResultReveal: ToolResultRevealController;
	ui: { requestRender: () => void };
	workingMessage: string | undefined;
	workingMessageBeforeActiveTool: string | undefined;
};

type InteractiveModeMethods = {
	handleEvent(this: WiringFixture, event: AgentSessionEvent): Promise<void>;
	handleToolExecutionEnd(this: WiringFixture, event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>): void;
};

const interactiveModeMethods = InteractiveMode.prototype as unknown as InteractiveModeMethods;
const handleEvent = interactiveModeMethods.handleEvent;

function partialResult(text: string, activity?: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: activity === undefined ? undefined : { progress: { startedAt: 0, activity } },
	};
}

function createFixture(smoothStreaming: () => boolean, component: ToolComponent): WiringFixture {
	const requestStreamingRender = vi.fn();
	return {
		activeToolExecutionTerminalTitle: undefined,
		activeToolExecutions: new Map(),
		applyTerminalTitle: vi.fn(),
		chatContainer: { removeChild: vi.fn() },
		clearActiveToolExecutionStatus: vi.fn(),
		clearPendingTools: vi.fn(),
		clearStatusIndicator: vi.fn(),
		clearToolHookStatuses: vi.fn(),
		footer: { invalidate: vi.fn() },
		handleToolExecutionEnd: interactiveModeMethods.handleToolExecutionEnd,
		isInitialized: true,
		pendingTools: new Map([
			["tool-a", component],
			["tool-b", component],
		]),
		refreshWorkingLoaderMessage: vi.fn(),
		requestStreamingRender,
		settingsManager: { getShowTerminalProgress: () => false },
		streamingComponent: undefined,
		streamingReveal: { stop: vi.fn() },
		toolArgsReveal: { finish: vi.fn() },
		toolResultReveal: new ToolResultRevealController({
			getSmoothStreaming: smoothStreaming,
			getSmoothStreamingFps: () => 20,
			requestRender: requestStreamingRender,
		}),
		ui: { requestRender: vi.fn() },
		workingMessage: "Thinking",
		workingMessageBeforeActiveTool: undefined,
	};
}

describe("InteractiveMode tool execution update wiring", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	test("reveals partial tool text gradually, flushes it before the final result, and applies progress activity", async () => {
		const updates: Array<{ text: string; isPartial: boolean | undefined }> = [];
		const component: ToolComponent = {
			updateResult: (result, isPartial) => updates.push({ text: result.content[0]?.text ?? "", isPartial }),
		};
		const fixture = createFixture(() => true, component);
		fixture.activeToolExecutions.set("tool-a", "Running bash: initial command");

		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one", "compiling"),
		});
		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one two three four", "compiling"),
		});
		await vi.advanceTimersByTimeAsync(50);

		expect(updates.at(-1)?.text).not.toBe("one two three four");
		expect(updates.at(-1)?.text).not.toBe("one");
		expect(fixture.workingMessage).toBe("Running bash: compiling");
		expect(fixture.activeToolExecutions.get("tool-a")).toBe("Running bash: compiling");

		await handleEvent.call(fixture, {
			type: "tool_execution_end",
			toolCallId: "tool-a",
			toolName: "bash",
			result: partialResult("final"),
			isError: false,
		});

		expect(updates.slice(-2).map((update) => update.text)).toEqual(["one two three four", "final"]);
	});

	test("stops pending tool result reveal ticks when the agent ends", async () => {
		const updateResult = vi.fn<ToolComponent["updateResult"]>();
		const fixture = createFixture(() => true, { updateResult });

		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one"),
		});
		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one two three four"),
		});
		await handleEvent.call(fixture, { type: "agent_end", messages: [], willRetry: false });
		await vi.advanceTimersByTimeAsync(1_000);

		expect(updateResult).toHaveBeenCalledOnce();
	});

	test("stops pending tool result reveal ticks when the session is rebound", async () => {
		const updateResult = vi.fn<ToolComponent["updateResult"]>();
		const fixture = createFixture(() => true, { updateResult });

		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one"),
		});
		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("one two three four"),
		});
		expect(updateResult).toHaveBeenCalledOnce();

		const renderCurrentSessionState = (
			InteractiveMode.prototype as unknown as {
				renderCurrentSessionState(this: Record<string, unknown>): void;
			}
		).renderCurrentSessionState;
		renderCurrentSessionState.call({
			...fixture,
			loadedResourcesContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			compactionTransferAbortControllers: new Map(),
			renderInitialMessages: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(1_000);

		expect(updateResult).toHaveBeenCalledOnce();
	});

	test("applies partial tool results directly when smooth streaming is disabled", async () => {
		const updateResult = vi.fn<ToolComponent["updateResult"]>();
		const fixture = createFixture(() => false, { updateResult });

		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-a",
			toolName: "bash",
			args: {},
			partialResult: partialResult("complete chunk"),
		});

		expect(updateResult).toHaveBeenCalledOnce();
		expect(updateResult).toHaveBeenCalledWith(
			{ content: [{ type: "text", text: "complete chunk" }], details: undefined, isError: false },
			true,
		);
	});

	test("restores the other active tool's updated activity after a concurrent tool ends", async () => {
		const component: ToolComponent = { updateResult: vi.fn() };
		const fixture = createFixture(() => false, component);
		fixture.activeToolExecutions.set("tool-a", "Running bash: old A");
		fixture.activeToolExecutions.set("tool-b", "Running read: old B");
		fixture.workingMessage = "Running read: old B";

		await handleEvent.call(fixture, {
			type: "tool_execution_update",
			toolCallId: "tool-b",
			toolName: "read",
			args: {},
			partialResult: partialResult("", "reading src/index.ts"),
		});
		await handleEvent.call(fixture, {
			type: "tool_execution_end",
			toolCallId: "tool-a",
			toolName: "bash",
			result: partialResult("done"),
			isError: false,
		});

		expect(fixture.workingMessage).toBe("Running read: reading src/index.ts");
		expect(fixture.activeToolExecutions.get("tool-b")).toBe("Running read: reading src/index.ts");
	});
});
