import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import {
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import {
	TODO_STATE_ENTRY_TYPE,
	type TodoPhase,
	type TodoStateEntry,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

export const plainTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

export function shipPhases(): TodoPhase[] {
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

/** The session's liveness watcher and the todo widget, as the host loads them, in builtin order. */
const LIVE_BUILTINS = new Set(["session-liveness", "todowrite"]);

export function renderWidget(factory: WidgetFactory | undefined): string | undefined {
	return factory?.({ requestRender: () => {} } as unknown as TUI, plainTheme)
		.render(120)
		.join("\n");
}

export type LiveHarness = Awaited<ReturnType<typeof liveHarness>>;

/** A fake host for the todo widget: a real event bus shape, ordered lifecycle handlers and a temp session folder. */
export async function liveHarness() {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => unknown>>();
	const widgets: Array<WidgetFactory | undefined> = [];
	let idle = true;
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		events: {
			on: (name: string, handler: (data: unknown) => unknown) => {
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
	const cwd = mkdtempSync(join(tmpdir(), "todo-1146-"));
	const ctx = {
		cwd,
		mode: "tui",
		ui: { setWidget: (_key: string, factory: WidgetFactory | undefined) => widgets.push(factory) },
		sessionManager,
		isIdle: () => idle,
	} as unknown as ExtensionContext;
	for (const builtin of builtinExtensions.filter(({ id }) => LIVE_BUILTINS.has(id))) await builtin.factory(pi);
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
	};
	/** Awaits every bus handler, as the host's bus does, so a fold and its redraw finish before the next step. */
	const publish = (name: string, data: unknown) => async () => {
		await Promise.all([...(bus.get(name) ?? [])].map((handler) => handler(data)));
	};
	const resynced = async (trigger: () => unknown): Promise<string | undefined> => {
		const before = widgets.length;
		await trigger();
		return widgets.length === before ? undefined : renderWidget(widgets.at(-1));
	};
	const childRecord = (status: string, sessionId = sessionManager.getSessionId(), file = "child.json") => {
		const tasks = join(cwd, ".omo", "senpi-task", "tasks");
		mkdirSync(tasks, { recursive: true });
		writeFileSync(join(tasks, file), JSON.stringify({ status, parent_session_id: sessionId }));
	};
	const cleanup = async () => {
		await emit("session_shutdown");
		rmSync(cwd, { recursive: true, force: true });
	};
	return {
		emit,
		resynced,
		childRecord,
		cleanup,
		wake: (source: string, activeCount: number) => publish(WAKE_SOURCE_STATE_EVENT, { source, activeCount }),
		monitor: (watch: { persistent: boolean; deadlineMs: number | null } | undefined) =>
			publish(TERMINAL_MONITOR_STATE_EVENT, {
				activeCount: watch ? 1 : 0,
				monitors: watch ? [{ id: "m1", description: "watch", paused: false, startedAtMs: 0, ...watch }] : [],
			}),
		blocked: (active: boolean) => publish("herdr:blocked", { active, id: "q1", label: "Pick one", kind: "question" }),
		setIdle: (value: boolean) => {
			idle = value;
		},
	};
}
