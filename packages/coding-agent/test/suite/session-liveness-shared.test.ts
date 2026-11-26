import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHerdrExtension } from "../../src/core/extensions/builtin/herdr/index.ts";
import {
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../../src/core/extensions/builtin/monitor-state-event.ts";
import { createSessionLivenessWatcher } from "../../src/core/extensions/builtin/session-liveness/watcher.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../../src/core/extensions/builtin/todotools/state.ts";
import { noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { renderWidget, shipPhases } from "./todo-liveness-harness.ts";

// senpi#1146 review: the herdr pane report and the todo widget read one watcher's answer.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
});

async function sharedHost() {
	vi.stubEnv("HERDR_ENV", undefined);
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => unknown>>();
	const ticks: Array<() => void> = [];
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
	createSessionLivenessWatcher(pi, {
		schedulePoll: (tick) => {
			ticks.push(tick);
			return () => {};
		},
	});
	createHerdrExtension({ getLoadedExtensionPaths: () => [], readHeader: () => "", now: () => 0, connect: vi.fn() })(
		pi,
	);
	todotoolsExtension(pi);
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
		schema: "v2",
		phases: shipPhases(),
	} satisfies TodoStateEntry);
	const cwd = mkdtempSync(join(tmpdir(), "liveness-shared-"));
	const widgets: Array<WidgetFactory | undefined> = [];
	const setProgramStatus = vi.fn<ExtensionContext["ui"]["setProgramStatus"]>();
	let idle = true;
	const ctx = {
		cwd,
		mode: "tui",
		isIdle: () => idle,
		sessionManager,
		ui: {
			...noOpUIContext,
			setProgramStatus,
			setWidget: (_key: string, factory: WidgetFactory | undefined) => widgets.push(factory),
		},
	} as unknown as ExtensionContext;
	const emit = async (type: string) => {
		for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx);
	};
	const publish = async (name: string, data: unknown) => {
		await Promise.all([...(bus.get(name) ?? [])].map((handler) => handler(data)));
	};
	cleanups.push(async () => {
		await emit("session_shutdown");
		rmSync(cwd, { recursive: true, force: true });
	});
	const childRecord = (status: string) => {
		const tasks = join(cwd, ".omo", "senpi-task", "tasks");
		mkdirSync(tasks, { recursive: true });
		writeFileSync(
			join(tasks, "child.json"),
			JSON.stringify({ status, parent_session_id: sessionManager.getSessionId() }),
		);
	};
	const pollAfter = async (status: string) => {
		childRecord(status);
		for (const tick of ticks) tick();
	};
	return {
		emit,
		publish,
		pollAfter,
		ticks,
		bus,
		setIdle: (value: boolean) => {
			idle = value;
		},
		paneWorking: () => setProgramStatus.mock.calls.at(-1)?.[0]?.state === "working",
		todoActive: () => renderWidget(widgets.at(-1))?.includes("[•]") === true,
	};
}

describe("one session liveness watcher for the pane report and the todo widget (senpi#1146)", () => {
	it("gives both consumers the same answer through turns, child records, blocks and their ends", async () => {
		const host = await sharedHost();
		const steps: Array<[string, () => Promise<void>, boolean]> = [
			["idle session start", () => host.emit("session_start"), false],
			[
				"turn starts",
				async () => {
					host.setIdle(false);
					await host.emit("agent_start");
				},
				true,
			],
			[
				"turn settles",
				async () => {
					host.setIdle(true);
					await host.emit("agent_settled");
				},
				false,
			],
			["child record runs, next poll", () => host.pollAfter("running"), true],
			["question blocks", () => host.publish("herdr:blocked", { active: true, id: "q", kind: "question" }), false],
			["question settles", () => host.publish("herdr:blocked", { active: false, id: "q" }), true],
			["child record ends, next poll", () => host.pollAfter("completed"), false],
		];
		for (const [step, run, working] of steps) {
			await run();
			expect({ step, pane: host.paneWorking(), todo: host.todoActive() }).toEqual({
				step,
				pane: working,
				todo: working,
			});
		}
	});

	it("subscribes each input once and polls the child records once per session", async () => {
		const host = await sharedHost();
		await host.emit("session_start");

		for (const channel of ["herdr:blocked", TERMINAL_MONITOR_STATE_EVENT, WAKE_SOURCE_STATE_EVENT])
			expect({ channel, subscribers: host.bus.get(channel)?.size }).toEqual({ channel, subscribers: 1 });
		expect(host.ticks).toHaveLength(1);
	});
});
