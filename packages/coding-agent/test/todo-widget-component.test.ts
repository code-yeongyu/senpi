import type { Component, TUI } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import todotoolsExtension from "../src/core/extensions/builtin/todotools/index.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../src/core/extensions/builtin/todotools/state.ts";
import type { TODO_PARAMS_SCHEMA } from "../src/core/extensions/builtin/todotools/tools/todo.ts";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	TODO_STRIKE_FRAME_INTERVAL_MS,
	TODO_STRIKE_TOTAL_FRAMES,
} from "../src/modes/interactive/components/todo-strike.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

type TodoParams = Static<typeof TODO_PARAMS_SCHEMA>;
type WidgetFactory = (tui: TUI, theme: Theme) => Component & { dispose?(): void };
type CapturedWidget = string[] | WidgetFactory | undefined;

const completedTask = "Monitor CI and resolve active review gates";
const activeTask = "Merge PR with merge commit";

const markerTheme = {
	fg: (name: string, text: string) => `<fg:${name}>${text}</fg:${name}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	strikethrough: (text: string) => `<s>${text}</s>`,
} as Theme;

function createTodoHarness(
	options: { readonly mountWidgets?: boolean; readonly sessionManager?: SessionManager } = {},
): {
	readonly ctx: ExtensionContext;
	readonly getTool: () => ToolDefinition<typeof TODO_PARAMS_SCHEMA>;
	readonly getWidget: () => CapturedWidget;
	readonly getMountedComponent: () => (Component & { dispose?(): void }) | undefined;
	readonly requestRender: ReturnType<typeof vi.fn>;
	readonly emitSessionStart: () => Promise<void>;
} {
	let tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA> | undefined;
	let widget: CapturedWidget;
	let mountedComponent: (Component & { dispose?(): void }) | undefined;
	const requestRender = vi.fn();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const eventHandlers = handlers.get(event) ?? [];
			eventHandlers.push(handler);
			handlers.set(event, eventHandlers);
		},
		registerCommand: () => {},
		registerTool: (definition: ToolDefinition<typeof TODO_PARAMS_SCHEMA>) => {
			tool = definition;
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const ctx = {
		ui: {
			setWidget: (_key: string, content: CapturedWidget) => {
				widget = content;
				if (!options.mountWidgets) return;
				mountedComponent?.dispose?.();
				mountedComponent =
					typeof content === "function" ? content({ requestRender } as unknown as TUI, markerTheme) : undefined;
			},
		},
		sessionManager: options.sessionManager ?? {
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext;

	todotoolsExtension(pi);

	return {
		ctx,
		getTool: () => {
			if (!tool) throw new Error("Expected the todo tool to register");
			return tool;
		},
		getWidget: () => widget,
		getMountedComponent: () => mountedComponent,
		requestRender,
		emitSessionStart: async () => {
			for (const handler of handlers.get("session_start") ?? []) {
				await handler({ type: "session_start", reason: "startup" }, ctx);
			}
		},
	};
}

async function executeTodo(
	tool: ToolDefinition<typeof TODO_PARAMS_SCHEMA>,
	ctx: ExtensionContext,
	params: TodoParams,
): Promise<void> {
	if (!tool.execute) throw new Error("Expected the todo tool to execute");
	await tool.execute("todo-test", params, new AbortController().signal, () => {}, ctx);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("todo sidebar completion animation", () => {
	it("retains and progressively strikes a same-phase completion", async () => {
		// Given a Delivery phase whose first task is active.
		vi.useFakeTimers();
		const harness = createTodoHarness();
		const tool = harness.getTool();
		await executeTodo(tool, harness.ctx, {
			op: "init",
			list: [{ phase: "Delivery", items: [completedTask, activeTask] }],
		});

		// When the active task completes and the next task is promoted in the same phase.
		await executeTodo(tool, harness.ctx, { op: "done", task: completedTask });

		// Then the widget keeps the completed row and reveals its strike left-to-right.
		const widget = harness.getWidget();
		expect(typeof widget).toBe("function");
		if (typeof widget !== "function") throw new Error("Expected an animated widget factory");
		const requestRender = vi.fn();
		const component = widget({ requestRender } as unknown as TUI, markerTheme);

		const initial = component.render(120).join("\n");
		expect(initial).toContain(`<fg:dim>[✓] ${completedTask}</fg:dim>`);
		expect(initial).toContain(`<fg:accent><bold>[•] ${activeTask}</bold></fg:accent>`);

		await vi.advanceTimersByTimeAsync(TODO_STRIKE_FRAME_INTERVAL_MS * 8);
		const midpoint = component.render(120).join("\n");
		expect(midpoint).toContain("<fg:dim><s>[✓] Monitor CI and reso</s>lve active review gates</fg:dim>");

		await vi.advanceTimersByTimeAsync(TODO_STRIKE_FRAME_INTERVAL_MS * (TODO_STRIKE_TOTAL_FRAMES - 8));
		const settled = component.render(120).join("\n");
		expect(settled).toContain(`<fg:dim><s>[✓] ${completedTask}</s></fg:dim>`);
		component.dispose?.();
	});

	it("stops requesting renders after settle and clears its timer on dispose", async () => {
		// Given a mounted todo widget that receives a live same-phase completion.
		vi.useFakeTimers();
		const settledHarness = createTodoHarness({ mountWidgets: true });
		const settledTool = settledHarness.getTool();
		await executeTodo(settledTool, settledHarness.ctx, {
			op: "init",
			list: [{ phase: "Delivery", items: [completedTask, activeTask] }],
		});
		await executeTodo(settledTool, settledHarness.ctx, { op: "done", task: completedTask });

		// When the bounded animation reaches its final frame.
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(TODO_STRIKE_FRAME_INTERVAL_MS * TODO_STRIKE_TOTAL_FRAMES);

		// Then it has requested each repaint and leaves no timer running.
		expect(settledHarness.requestRender).toHaveBeenCalledTimes(TODO_STRIKE_TOTAL_FRAMES);
		expect(vi.getTimerCount()).toBe(0);

		// Given a second widget disposed while its strike is still in flight.
		const disposedHarness = createTodoHarness({ mountWidgets: true });
		const disposedTool = disposedHarness.getTool();
		await executeTodo(disposedTool, disposedHarness.ctx, {
			op: "init",
			list: [{ phase: "Delivery", items: [completedTask, activeTask] }],
		});
		await executeTodo(disposedTool, disposedHarness.ctx, { op: "done", task: completedTask });
		expect(vi.getTimerCount()).toBe(1);

		// When the host disposes the widget.
		disposedHarness.getMountedComponent()?.dispose?.();

		// Then the component tears down the interval immediately.
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not replay prior-phase or restored completions", async () => {
		// Given a later phase completion that returns the active pointer to Foundation.
		vi.useFakeTimers();
		const liveHarness = createTodoHarness({ mountWidgets: true });
		const liveTool = liveHarness.getTool();
		await executeTodo(liveTool, liveHarness.ctx, {
			op: "init",
			list: [
				{ phase: "Foundation", items: ["Build core"] },
				{ phase: "Verification", items: ["Run checks"] },
			],
		});
		await executeTodo(liveTool, liveHarness.ctx, { op: "start", task: "Run checks" });

		// When the Verification task completes and Foundation becomes active again.
		await executeTodo(liveTool, liveHarness.ctx, { op: "done", task: "Run checks" });

		// Then the active widget is settled, excludes the prior phase, and starts no animation.
		const liveComponent = liveHarness.getMountedComponent();
		expect(liveComponent).toBeDefined();
		const liveRender = liveComponent?.render(120).join("\n") ?? "";
		expect(liveRender).toContain("Foundation");
		expect(liveRender).toContain("<fg:accent><bold>[•] Build core</bold></fg:accent>");
		expect(liveRender).not.toContain("Verification");
		expect(liveRender).not.toContain("Run checks");
		expect(vi.getTimerCount()).toBe(0);

		// Given a restored Delivery phase containing a previously completed row.
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
			schema: "v2",
			phases: [
				{
					name: "Delivery",
					tasks: [
						{ content: completedTask, status: "completed" },
						{ content: activeTask, status: "in_progress" },
					],
				},
			],
		} satisfies TodoStateEntry);
		const restoredHarness = createTodoHarness({ mountWidgets: true, sessionManager });

		// When the extension rebuilds its widget from the session branch.
		await restoredHarness.emitSessionStart();

		// Then the completed row is fully struck without replaying the interval.
		const restoredComponent = restoredHarness.getMountedComponent();
		expect(restoredComponent).toBeDefined();
		const restoredRender = restoredComponent?.render(120).join("\n") ?? "";
		expect(restoredRender).toContain(`<fg:dim><s>[✓] ${completedTask}</s></fg:dim>`);
		expect(restoredRender).toContain(`<fg:accent><bold>[•] ${activeTask}</bold></fg:accent>`);
		expect(vi.getTimerCount()).toBe(0);
	});
});
