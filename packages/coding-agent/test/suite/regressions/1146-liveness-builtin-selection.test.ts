import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../../../src/core/extensions/builtin/monitor-state-event.ts";
import {
	SESSION_LIVENESS_CONNECT_EVENT,
	type SessionLiveness,
} from "../../../src/core/extensions/builtin/session-liveness/connect.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../../../src/core/extensions/builtin/todotools/state.ts";
import { noOpUIContext } from "../../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import type { Theme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "../harness.ts";
import { renderWidget, shipPhases } from "../todo-liveness-harness.ts";

// senpi#1146 review: the session liveness watcher is an internal dependency of the pane report and the todo
// widget. A builtin allowlist or denylist written before it existed must not lose it.

type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type BuiltinSelection = {
	enabledBuiltinExtensions?: string[];
	disabledBuiltinExtensions?: string[];
	/** `-e builtin:<name>` paths, which load a builtin the settings do not select. */
	explicitPaths?: string[];
};

const POLL_MS = 4000;
const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

async function sessionWith(selection: BuiltinSelection) {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const setInterval = vi.spyOn(globalThis, "setInterval");
	const root = mkdtempSync(join(tmpdir(), "liveness-selection-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const { explicitPaths, ...settings } = selection;
	const disabled = [...(settings.disabledBuiltinExtensions ?? []), "codemode"];
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, disabledBuiltinExtensions: disabled }));
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		...(explicitPaths ? { additionalExtensionPaths: explicitPaths } : {}),
	});
	await loader.reload();
	const bus = loader.getExtensions().eventBus;
	if (!bus) throw new Error("the loader returned no event bus");
	const subscribe = vi.spyOn(bus, "on");
	const harness: Harness = await createHarness({ resourceLoader: loader, cwd });
	cleanups.push(() => {
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	});
	harness.session.sessionManager.appendCustomEntry(TODO_STATE_ENTRY_TYPE, {
		schema: "v2",
		phases: shipPhases(),
	} satisfies TodoStateEntry);
	const widgets: Array<WidgetFactory | undefined> = [];
	const setProgramStatus = vi.fn<ExtensionUIContext["setProgramStatus"]>();
	const setWidget = ((key: string, content: unknown) => {
		if (key !== "todo-sidebar") return;
		widgets.push(typeof content === "function" ? (content as WidgetFactory) : undefined);
	}) as ExtensionUIContext["setWidget"];
	await harness.session.bindExtensions({});
	const runner = harness.getExtensionRunner();
	runner.setUIContext({ ...noOpUIContext, setProgramStatus, setWidget }, "tui");
	const loaded = loader.getExtensions().extensions.map((extension) => extension.path);
	return {
		loaded,
		emit: (type: "session_start" | "agent_start" | "agent_settled") =>
			runner.emit(type === "session_start" ? { type, reason: "startup" } : { type }),
		pane: () => setProgramStatus.mock.calls.at(-1)?.[0]?.state,
		todo: () => renderWidget(widgets.at(-1)),
		watchers: () => {
			const handles: SessionLiveness[] = [];
			runner.emitBusEvent(SESSION_LIVENESS_CONNECT_EVENT, (handle: SessionLiveness) => handles.push(handle));
			return handles.length;
		},
		polls: () => setInterval.mock.calls.filter(([, ms]) => ms === POLL_MS).length,
		subscribers: (channel: string) => subscribe.mock.calls.filter(([name]) => name === channel).length,
	};
}

describe("liveness watcher under builtin selection (senpi#1146)", () => {
	it("follows a turn in the pane report when the allowlist names only herdr", async () => {
		const session = await sessionWith({ enabledBuiltinExtensions: ["herdr"] });
		await session.emit("session_start");

		await session.emit("agent_start");
		expect(session.pane()).toBe("working");
		await session.emit("agent_settled");
		expect(session.pane()).toBe("idle");
	});

	it("draws the paused list when idle and the active mark in a turn when the allowlist names only the todo widget", async () => {
		const session = await sessionWith({ enabledBuiltinExtensions: ["todowrite"] });

		await session.emit("session_start");
		expect(session.todo()).not.toContain("[•]");
		await session.emit("agent_start");
		expect(session.todo()).toContain("[•] Open the pull request");
	});

	it.each([[["herdr", "todowrite"]], [["todowrite", "herdr"]]])(
		"loads one watcher with one poll and one subscriber per input for both consumers (allowlist %j)",
		async (enabledBuiltinExtensions) => {
			// The host session subscribes to some inputs itself; count what the extensions add over a consumer-free one.
			const hostOnly = await sessionWith({ enabledBuiltinExtensions: ["ask-user"] });
			await hostOnly.emit("session_start");
			const session = await sessionWith({ enabledBuiltinExtensions });
			await session.emit("session_start");

			expect(session.watchers()).toBe(1);
			expect(session.polls()).toBe(1);
			for (const channel of ["herdr:blocked", TERMINAL_MONITOR_STATE_EVENT, WAKE_SOURCE_STATE_EVENT]) {
				const added = session.subscribers(channel) - hostOnly.subscribers(channel);
				expect({ channel, added }).toEqual({ channel, added: 1 });
			}
		},
	);

	it("loads no watcher and starts no poll when neither consumer is selected", async () => {
		const session = await sessionWith({ enabledBuiltinExtensions: ["ask-user"] });
		await session.emit("session_start");

		expect(session.loaded).not.toContain("<builtin:session-liveness>");
		expect(session.watchers()).toBe(0);
		expect(session.polls()).toBe(0);
	});

	it("brings the watcher with a consumer named by an explicit builtin path outside the allowlist", async () => {
		const session = await sessionWith({ enabledBuiltinExtensions: ["ask-user"], explicitPaths: ["builtin:herdr"] });
		await session.emit("session_start");

		expect(session.watchers()).toBe(1);
		await session.emit("agent_start");
		expect(session.pane()).toBe("working");
	});

	it("keeps both consumers working when a denylist names the watcher's id", async () => {
		const session = await sessionWith({ disabledBuiltinExtensions: ["session-liveness"] });
		await session.emit("session_start");
		expect(session.todo()).not.toContain("[•]");

		await session.emit("agent_start");
		expect(session.pane()).toBe("working");
		expect(session.todo()).toContain("[•] Open the pull request");
	});
});
