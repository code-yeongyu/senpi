import { join, resolve } from "node:path";
import { Container, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { registerTodoTool, type TODO_PARAMS_SCHEMA } from "../src/core/extensions/builtin/todotools/tools/todo.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { renderToolDiff } from "../src/core/tools/diff-render.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import type { ReadClassifier } from "../src/core/tools/read-classifiers.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import {
	TODO_STRIKE_FRAME_INTERVAL_MS,
	TODO_STRIKE_TOTAL_FRAMES,
} from "../src/modes/interactive/components/todo-strike.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

async function registerReadClassifierThroughExtension(classifier: ReadClassifier): Promise<() => void> {
	let api: ExtensionAPI | undefined;
	await loadExtensionFromFactory(
		(pi) => {
			api = pi;
		},
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
	);
	if (!api) throw new Error("Expected extension API");
	expect(api.registerReadClassifier).toBeTypeOf("function");
	return api.registerReadClassifier(classifier);
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as TUI;
}

function createFakeTuiWithRenderSpy(requestRender: () => void): TUI {
	return {
		requestRender,
	} as TUI;
}

function createCompletedTodoResult(isError = false): Parameters<ToolExecutionComponent["updateResult"]>[0] {
	return {
		content: [{ type: "text" as const, text: "ok" }],
		details: {
			op: "done",
			phases: [{ name: "P", tasks: [{ content: "t", status: "completed" }] }],
			storage: "memory" as const,
			completedTasks: [{ phase: "P", content: "t" }],
		},
		isError,
	};
}

function getSpinnerFrame(component: ToolExecutionComponent): number | undefined {
	return (component as unknown as { spinnerFrame?: number }).spinnerFrame;
}

function captureTodoTool(): ToolDefinition<typeof TODO_PARAMS_SCHEMA> {
	let capturedTool: ToolDefinition<typeof TODO_PARAMS_SCHEMA> | undefined;
	const pi = {
		registerTool(tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA>) {
			capturedTool = tool;
		},
		appendEntry() {},
	};
	registerTodoTool(pi as unknown as ExtensionAPI, {
		getCurrentPhases: () => [],
		setCurrentPhases: () => {},
		syncWidget: () => {},
	});
	if (!capturedTool) throw new Error("Expected todo tool registration");
	return capturedTool;
}

type InteractiveModeStopThis = {
	streamingReveal: { stop(): void };
	toolResultReveal: { stop(): void };
	disposeActiveSelector(): void;
	settingsManager: { getShowTerminalProgress(): boolean };
	ui: { terminal: { setProgress(value: boolean): void }; stop(): void };
	clearStatusIndicator(): void;
	clearPendingTools(): void;
	stopChatToolAnimations(): void;
	clearActiveToolExecutionStatus(): void;
	clearToolHookStatuses(): void;
	themeController: { disableAutoSync(): void };
	clearExtensionTerminalInputListeners(): void;
	footer: { dispose(): void };
	footerDataProvider: { dispose(): void };
	unsubscribe: (() => void) | undefined;
	isInitialized: boolean;
	unregisterSignalHandlers(): void;
};
type InteractiveModeStopPrototype = {
	stop(this: InteractiveModeStopThis): void;
};
type StopChatToolAnimationsThis = {
	chatContainer: Container;
	ui: Pick<TUI, "requestRender">;
};

type StopChatToolAnimationsPrototype = {
	stopChatToolAnimations(this: StopChatToolAnimationsThis): void;
};

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bg: (name: string, text: string) => `<bg:${name}>${text}</bg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	inverse: (text: string) => `<inverse>${text}</inverse>`,
};

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("advances pending render frames for self-rendered write calls while args stream", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const toolDefinition: ToolDefinition = {
				...createBaseToolDefinition("write"),
				renderShell: "self",
				renderCall: (_args, _theme, context) => {
					const frame = Reflect.get(context, "spinnerFrame");
					return new Text(`waiting frame:${String(frame ?? "none")}`, 0, 0);
				},
			};

			const component = new ToolExecutionComponent(
				"write",
				"tool-pending-write-frame",
				{ path: "notes.txt", content: "partial" },
				{},
				toolDefinition,
				createFakeTuiWithRenderSpy(requestRender),
				process.cwd(),
			);

			expect(stripAnsi(component.render(120).join("\n"))).toContain("waiting frame:none");

			vi.advanceTimersByTime(90);

			expect(requestRender).toHaveBeenCalled();
			expect(stripAnsi(component.render(120).join("\n"))).toContain("waiting frame:0");

			component.setArgsComplete();
			requestRender.mockClear();
			vi.advanceTimersByTime(90);

			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			withBuiltInRenderers("edit", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => ({ exitCode: 0 }),
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("highlights bash command syntax in the tool call header", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-highlight",
			{ command: 'echo "hello" && false' },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const rendered = component.render(120).join("\n");
		expect(rendered).toContain(theme.fg("syntaxString", '"hello"'));
		expect(rendered).toContain(theme.fg("syntaxType", "echo"));
		expect(stripAnsi(rendered)).toContain('$ echo "hello" && false');
	});

	test("renders bash elapsed time as stable whole-second text while running", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-15T00:00:00.000Z"));

		try {
			const component = new ToolExecutionComponent(
				"bash",
				"tool-bash-elapsed",
				{ command: "sleep 70" },
				{},
				createBashToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			component.markExecutionStarted();
			component.updateResult({ content: [], details: undefined, isError: false }, true);

			expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed <1s");

			vi.advanceTimersByTime(1_100);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed 1s");

			vi.advanceTimersByTime(67_000);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Elapsed 1m 8s");

			component.updateResult(
				{ content: [{ type: "text", text: "(no output)" }], details: undefined, isError: false },
				false,
			);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("Took 1m 8s");
		} finally {
			vi.useRealTimers();
		}
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			withBuiltInRenderers("read", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			withBuiltInRenderers("read", overrideDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("bounds running tool detail for hostile fallback metadata", () => {
		const hostileToolName = `${"very-long-tool-name".repeat(20)}\nleaked-line\x1b[31mred\x1b]2;owned\x07`;
		const hostilePath = "src/ok.ts\nsrc/hidden.ts\x1b[35mraw\x1b]8;;https://example.test\x07link\x1b]8;;\x07";
		const component = new ToolExecutionComponent(
			hostileToolName,
			"tool-hostile-running-detail",
			{ path: hostilePath, query: "needle".repeat(80) },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);

		component.markExecutionStarted();

		const renderedLines = component.render(60);
		const rendered = renderedLines.join("\n");
		const plain = stripAnsi(rendered);

		expect(rendered).not.toContain("\x1b]2;");
		expect(rendered).not.toContain("\x1b]8;");
		expect(rendered).not.toContain("\x1b[31mred");
		expect(plain).not.toContain("leaked-line");
		expect(rendered).not.toContain("src/ok.ts\nsrc/hidden.ts");
		expect(Math.max(...renderedLines.map((line) => stripAnsi(line).length))).toBeLessThanOrEqual(60);
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("renders shared tool diffs with apply_patch-style highlighted rows", () => {
		const rendered = renderToolDiff("-1 alpha old\n+1 alpha new\n 2 same", {
			filePath: "src/foo.ts",
			theme: markerTheme,
		});

		expect(rendered).toContain("<bg:toolErrorBg><fg:toolDiffRemoved>-</fg:toolDiffRemoved><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffRemoved>alpha <inverse>old</inverse></fg:toolDiffRemoved>");
		expect(rendered).toContain("<bg:toolSuccessBg><fg:toolDiffAdded>+</fg:toolDiffAdded><fg:muted>1</fg:muted>");
		expect(rendered).toContain("<fg:toolDiffAdded>alpha <inverse>new</inverse></fg:toolDiffAdded>");
		expect(rendered).toContain("<fg:toolDiffContext> </fg:toolDiffContext><fg:muted>2</fg:muted> same");
	});

	test("renders write previews as diff rows when arguments are complete", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-write-diff",
			{ path: "notes.txt", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		component.setArgsComplete();

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("+1 one");
		expect(rendered).toContain("+2 two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("expands a collapsed tool result when clicked", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-click-expand",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);
		const width = 120;
		const lines = component.render(width);
		const resultRow = lines.findIndex((line) => stripAnsi(line).includes("notes.txt"));
		expect(resultRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: resultRow,
			screenX: 2,
			screenY: resultRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).toContain("hidden content");
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed.replace(/\s+/g, " ")).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}

	for (const headline of ["Remembered", undefined]) {
		test(`renders classified memory reads with ${headline ?? "the default headline"}`, async () => {
			const args = { path: "memory/preference.md", offset: 2, limit: 3 };
			const classifier = vi.fn(() => ({ kind: "memory" as const, label: "preference", headline }));
			const unregister = await registerReadClassifierThroughExtension(classifier);
			try {
				const component = new ToolExecutionComponent(
					"read",
					"tool-memory-read",
					args,
					{},
					createReadToolDefinition(process.cwd()),
					createFakeTui(),
					process.cwd(),
				);
				component.updateResult(
					{ content: [{ type: "text", text: "hidden memory" }], details: undefined, isError: false },
					false,
				);
				const collapsed = component.render(120).join("\n");
				expect(stripAnsi(collapsed)).toContain(
					`✦ ${headline ?? "Recalled"} preference:2-4 (${keyText("app.tools.expand")} to expand)`,
				);
				expect(collapsed).toContain(theme.fg("accent", `\x1b[1m✦ ${headline ?? "Recalled"}\x1b[22m`));
				expect(collapsed).toContain(theme.fg("customMessageText", "preference"));
				expect(stripAnsi(collapsed)).not.toContain("hidden memory");
				expect(classifier).toHaveBeenCalledExactlyOnceWith({
					absolutePath: resolve(process.cwd(), args.path),
					cwd: process.cwd(),
				});

				component.setExpanded(true);
				const expanded = stripAnsi(component.render(120).join("\n"));
				expect(expanded).toContain("memory/preference.md:2-4");
				expect(expanded).toContain("hidden memory");
				expect(expanded).not.toContain("✦");
				component.setExpanded(false);
				expect(component.render(120).join("\n")).toBe(collapsed);
				expect(classifier).toHaveBeenCalledTimes(1);
			} finally {
				unregister();
			}
		});
	}

	test("keeps SKILL.md ahead of registered read classifiers", async () => {
		const classifier = vi.fn(() => ({ kind: "memory" as const, label: "not a skill" }));
		const unregister = await registerReadClassifierThroughExtension(classifier);
		try {
			const component = new ToolExecutionComponent(
				"read",
				"tool-memory-skill-precedence",
				{ path: join(process.cwd(), "attio", "SKILL.md") },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			expect(stripAnsi(component.render(120).join("\n"))).toContain("[skill] attio");
			expect(classifier).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	for (const path of [getReadmePath(), join(process.cwd(), "AGENTS.md")]) {
		test(`registered read classifiers take precedence over built-in classification for ${path}`, async () => {
			const unregister = await registerReadClassifierThroughExtension(() => ({ kind: "memory", label: "claimed" }));
			try {
				const component = new ToolExecutionComponent(
					"read",
					"tool-memory-builtin-precedence",
					{ path },
					{},
					createReadToolDefinition(process.cwd()),
					createFakeTui(),
					process.cwd(),
				);
				expect(stripAnsi(component.render(120).join("\n"))).toContain("✦ Recalled claimed");
			} finally {
				unregister();
			}
		});
	}

	test("memoizes read classification by raw path in shared renderCall state", async () => {
		let calls = 0;
		const classifier = vi.fn(() => ({ kind: "memory" as const, label: "preference", headline: `Recall ${++calls}` }));
		const unregister = await registerReadClassifierThroughExtension(classifier);
		try {
			const args = { path: "memory/preference.md" };
			const tool = createReadToolDefinition(process.cwd());
			const context: Parameters<NonNullable<typeof tool.renderCall>>[2] = {
				args,
				toolCallId: "tool-stable-memory",
				invalidate: () => {},
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: false,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
			};
			const first = tool.renderCall!(args, theme, context).render(120).join("\n");
			const second = tool.renderCall!(args, theme, { ...context })
				.render(120)
				.join("\n");
			expect(second).toBe(first);
			expect(stripAnsi(first)).toContain("✦ Recall 1 preference");
			expect(classifier).toHaveBeenCalledTimes(1);

			const otherArgs = { path: "memory/other.md" };
			const other = tool.renderCall!(otherArgs, theme, { ...context, args: otherArgs })
				.render(120)
				.join("\n");
			expect(stripAnsi(other)).toContain("✦ Recall 2 preference");
			expect(tool.renderCall!(args, theme, context).render(120).join("\n")).toBe(first);
			expect(classifier).toHaveBeenCalledTimes(2);
		} finally {
			unregister();
		}
	});

	test("animates completed todo tasks through the strike reveal and settles", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"todo",
				"tool-todo-strike-happy",
				{},
				{},
				createBaseToolDefinition("todo"),
				createFakeTuiWithRenderSpy(requestRender),
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult(createCompletedTodoResult(), false);

			const rendersBeforeFrame = requestRender.mock.calls.length;
			vi.advanceTimersByTime(TODO_STRIKE_FRAME_INTERVAL_MS);
			expect(requestRender.mock.calls.length).toBeGreaterThan(rendersBeforeFrame);

			vi.advanceTimersByTime(TODO_STRIKE_FRAME_INTERVAL_MS * (TODO_STRIKE_TOTAL_FRAMES + 1));
			const rendersAfterCompletion = requestRender.mock.calls.length;
			vi.advanceTimersByTime(2_000);
			expect(requestRender.mock.calls.length).toBe(rendersAfterCompletion);
			expect(getSpinnerFrame(component)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	const todoAnimationScenarios: Array<{
		title: string;
		result: Parameters<ToolExecutionComponent["updateResult"]>[0];
		isPartial: boolean;
	}> = [
		{ title: "does not animate errored todo results", result: createCompletedTodoResult(true), isPartial: false },
		{
			title: "does not animate todo results without completedTasks",
			result: {
				content: [{ type: "text" as const, text: "ok" }],
				details: { op: "done", phases: [], storage: "memory" },
				isError: false,
			},
			isPartial: false,
		},
		{
			title: "does not animate todo results with empty completedTasks",
			result: {
				content: [{ type: "text" as const, text: "ok" }],
				details: { op: "done", phases: [], storage: "memory", completedTasks: [] },
				isError: false,
			},
			isPartial: false,
		},
		{ title: "does not animate partial todo results", result: createCompletedTodoResult(), isPartial: true },
	];
	for (const scenario of todoAnimationScenarios) {
		test(scenario.title, () => {
			vi.useFakeTimers();
			try {
				const requestRender = vi.fn();
				const component = new ToolExecutionComponent(
					"todo",
					`tool-todo-strike-${scenario.title}`,
					{},
					{},
					createBaseToolDefinition("todo"),
					createFakeTuiWithRenderSpy(requestRender),
					process.cwd(),
				);
				component.markExecutionStarted();
				component.updateResult(scenario.result, scenario.isPartial);
				requestRender.mockClear();
				vi.advanceTimersByTime(2_000);
				expect(requestRender).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});
	}

	test("stops completed todo strike animation on stopAnimation and dispose", () => {
		vi.useFakeTimers();
		try {
			for (const teardown of [
				(component: ToolExecutionComponent) => component.stopAnimation(),
				(component: ToolExecutionComponent) => component.dispose(),
			]) {
				const requestRender = vi.fn();
				const component = new ToolExecutionComponent(
					"todo",
					"tool-todo-strike-teardown",
					{},
					{},
					createBaseToolDefinition("todo"),
					createFakeTuiWithRenderSpy(requestRender),
					process.cwd(),
				);
				component.markExecutionStarted();
				component.updateResult(createCompletedTodoResult(), false);
				teardown(component);
				requestRender.mockClear();
				vi.advanceTimersByTime(2_000);
				expect(requestRender).not.toHaveBeenCalled();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	test("does not replay todo completion animation while rendering restored results", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"todo",
				"tool-todo-strike-restored",
				{ op: "done", task: "t" },
				{},
				captureTodoTool(),
				createFakeTuiWithRenderSpy(requestRender),
				process.cwd(),
			);
			component.updateResult(createCompletedTodoResult(), false);
			requestRender.mockClear();
			vi.advanceTimersByTime(2_000);
			expect(requestRender).not.toHaveBeenCalled();
			expect(component.render(120).join("\n")).toContain(theme.strikethrough("[✓] t"));
		} finally {
			vi.useRealTimers();
		}
	});

	test("interactive mode stop wires chat tool animation teardown after clearPendingTools", () => {
		const clearPendingTools = vi.fn();
		const stopChatToolAnimations = vi.fn();
		const fakeThis: InteractiveModeStopThis = {
			streamingReveal: { stop: vi.fn() },
			toolResultReveal: { stop: vi.fn() },
			disposeActiveSelector: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { terminal: { setProgress: vi.fn() }, stop: vi.fn() },
			clearStatusIndicator: vi.fn(),
			clearPendingTools,
			stopChatToolAnimations,
			clearActiveToolExecutionStatus: vi.fn(),
			clearToolHookStatuses: vi.fn(),
			themeController: { disableAutoSync: vi.fn() },
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe: undefined,
			isInitialized: false,
			unregisterSignalHandlers: vi.fn(),
		};
		const prototype = InteractiveMode.prototype as unknown as InteractiveModeStopPrototype;
		prototype.stop.call(fakeThis);
		expect(stopChatToolAnimations).toHaveBeenCalledTimes(1);
		expect(stopChatToolAnimations.mock.invocationCallOrder[0]).toBeGreaterThan(
			clearPendingTools.mock.invocationCallOrder[0]!,
		);
	});

	test("stops completed todo strike animation when interactive mode stops chat tool animations", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"todo",
				"tool-todo-strike-mode-stop",
				{},
				{},
				createBaseToolDefinition("todo"),
				createFakeTuiWithRenderSpy(requestRender),
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult(createCompletedTodoResult(), false);
			vi.advanceTimersByTime(TODO_STRIKE_FRAME_INTERVAL_MS);
			const chatContainer = new Container();
			chatContainer.addChild(component);
			const fakeThis: StopChatToolAnimationsThis = { chatContainer, ui: { requestRender: vi.fn() } };
			const prototype = InteractiveMode.prototype as unknown as StopChatToolAnimationsPrototype;
			prototype.stopChatToolAnimations.call(fakeThis);
			requestRender.mockClear();
			vi.advanceTimersByTime(2_000);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test("invalidates memoized todo output for each strike animation frame", () => {
		vi.useFakeTimers();
		try {
			const toolDefinition: ToolDefinition = {
				...createBaseToolDefinition("todo"),
				renderResult: (_result, _options, _theme, context) =>
					new Text(`frame:${String(context.spinnerFrame)}`, 0, 0),
			};
			const component = new ToolExecutionComponent(
				"todo",
				"tool-todo-strike-memo",
				{},
				{},
				toolDefinition,
				createFakeTuiWithRenderSpy(vi.fn()),
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult(createCompletedTodoResult(), false);
			const firstFrame = component.render(120).join("\n");
			vi.advanceTimersByTime(TODO_STRIKE_FRAME_INTERVAL_MS);
			const secondFrame = component.render(120).join("\n");
			expect(secondFrame).not.toBe(firstFrame);
		} finally {
			vi.useRealTimers();
		}
	});
});
