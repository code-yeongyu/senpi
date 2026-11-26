import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import {
	TODO_STATE_ENTRY_TYPE,
	type TodoPhase,
	type TodoStateEntry,
} from "../../../src/core/extensions/builtin/todotools/state.ts";
import { getTodoWidgetModel } from "../../../src/core/extensions/builtin/todotools/todo-widget.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";

// senpi#1146 case 1: an idle session must not draw a todo item as in progress.

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

function shipPhases(): TodoPhase[] {
	return [
		{
			name: "Ship",
			tasks: [
				{ content: "Write the fix", status: "completed" },
				{ content: "Open the pull request", status: "in_progress" },
				{ content: "Merge after review passes", status: "pending" },
			],
		},
	];
}

function activeRows(model: ReturnType<typeof getTodoWidgetModel>): string[] {
	return (model?.rows ?? []).flatMap((row) =>
		row.kind === "task" && row.task.status === "in_progress" ? [row.task.content] : [],
	);
}

describe("todo widget model under session liveness (senpi#1146)", () => {
	it("draws no active item and a paused title with the open count while the session is idle", () => {
		const phases = shipPhases();
		const model = getTodoWidgetModel(phases, { working: false });

		expect(model).toBeDefined();
		expect(activeRows(model)).toEqual([]);
		const title = model?.rows[0];
		expect(title?.kind === "label" ? title.text : undefined).toMatch(/\b2\b/);
		// Drawing only: the stored list keeps its in-progress item.
		expect(phases[0]?.tasks[1]?.status).toBe("in_progress");
	});

	it("keeps the active mark while the session is working", () => {
		const model = getTodoWidgetModel(shipPhases(), { working: true });

		expect(activeRows(model)).toEqual(["Open the pull request"]);
	});
});

function liveHarness() {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const widgets: Array<WidgetFactory | undefined> = [];
	let idle = true;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: (data: unknown) => void) => {
				const set = bus.get(name) ?? new Set();
				set.add(handler);
				bus.set(name, set);
				return () => set.delete(handler);
			},
			emit: (name: string, data: unknown) => {
				for (const handler of bus.get(name) ?? []) handler(data);
			},
		},
		registerTool: () => {},
		registerCommand: () => {},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
		schema: "v2",
		phases: shipPhases(),
	} satisfies TodoStateEntry);
	const ctx = {
		ui: { setWidget: (_key: string, factory: WidgetFactory | undefined) => widgets.push(factory) },
		sessionManager,
		isIdle: () => idle,
	} as unknown as ExtensionContext;
	todotoolsExtension(pi);
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
	};
	const renderResyncedWidget = async (trigger: () => unknown): Promise<string | undefined> => {
		const before = widgets.length;
		await trigger();
		if (widgets.length === before) return undefined;
		const factory = widgets.at(-1);
		return factory?.({ requestRender: () => {} } as unknown as TUI, plainTheme)
			.render(120)
			.join("\n");
	};
	const wake = (source: string, activeCount: number) => () =>
		pi.events.emit(WAKE_SOURCE_STATE_EVENT, { source, activeCount });
	return { emit, resynced: renderResyncedWidget, wake, setIdle: (value: boolean) => (idle = value) };
}

describe("todo widget re-sync on liveness changes (senpi#1146)", () => {
	it("follows turn start, turn settle and live wake sources", async () => {
		const harness = liveHarness();

		const started = await harness.resynced(() => harness.emit("session_start"));
		expect(started).toContain("[ ] Open the pull request");
		expect(started).not.toContain("[•]");

		harness.setIdle(false);
		expect(await harness.resynced(() => harness.emit("agent_start"))).toContain("[•] Open the pull request");

		harness.setIdle(true);
		expect(await harness.resynced(() => harness.emit("agent_settled"))).not.toContain("[•]");

		expect(await harness.resynced(harness.wake("senpi-task", 1))).toContain("[•] Open the pull request");
		expect(await harness.resynced(harness.wake("senpi-task", 0))).not.toContain("[•]");

		expect(await harness.resynced(harness.wake("omo-dag", 1))).toContain("[•] Open the pull request");
		expect(await harness.resynced(harness.wake("omo-dag", 0))).not.toContain("[•]");
	});
});
