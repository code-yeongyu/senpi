import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import {
	SESSION_LIVENESS_CONNECT_EVENT,
	type SessionLiveness,
} from "../../src/core/extensions/builtin/session-liveness/connect.ts";
import { TODO_STATE_ENTRY_TYPE, type TodoStateEntry } from "../../src/core/extensions/builtin/todotools/state.ts";
import { noOpUIContext } from "../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";
import { renderWidget, shipPhases } from "./todo-liveness-harness.ts";

type WidgetFactory = (tui: TUI, theme: Theme) => Component;

export interface LoaderSessionOptions {
	enabledBuiltinExtensions?: string[];
	disabledBuiltinExtensions?: string[];
	/** `-e builtin:<name>` paths, which load a builtin the settings do not select. */
	explicitPaths?: string[];
	/** Load through the project-trust bootstrap (`reload({ resolveProjectTrust })`) instead of a plain reload. */
	trust?: boolean;
	/** A user extension that, like terminal on bind, re-publishes a live bounded monitor in its own session_start. */
	startupMonitorOwner?: boolean;
}

const POLL_MS = 4000;
const cleanups: Array<() => void> = [];

export function cleanupLoaderSessions(): void {
	for (const cleanup of cleanups.splice(0)) cleanup();
}

const STARTUP_MONITOR_OWNER = `export default function (pi) {
	pi.on("session_start", () => {
		pi.events.emit("terminal_monitor_state", {
			activeCount: 1,
			monitors: [{ id: "m1", description: "watch", paused: false, startedAtMs: 0, persistent: false, deadlineMs: 60000 }],
		});
	});
}
`;

/** A real `DefaultResourceLoader` selection bound to a real session, with the todo list seeded and a TUI context. */
export async function loaderSession(options: LoaderSessionOptions) {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const setInterval = vi.spyOn(globalThis, "setInterval");
	const root = mkdtempSync(join(tmpdir(), "liveness-loader-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	if (options.startupMonitorOwner) writeFileSync(join(agentDir, "extensions", "owner.ts"), STARTUP_MONITOR_OWNER);
	const { explicitPaths, trust, startupMonitorOwner: _owner, ...settings } = options;
	const disabled = [...(settings.disabledBuiltinExtensions ?? []), "codemode"];
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...settings, disabledBuiltinExtensions: disabled }));
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		noSkills: true,
		...(explicitPaths ? { additionalExtensionPaths: explicitPaths } : {}),
	});
	await (trust ? loader.reload({ resolveProjectTrust: async () => true }) : loader.reload());
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
	const ui: ExtensionUIContext = { ...noOpUIContext, setProgramStatus, setWidget };
	await harness.session.bindExtensions({});
	const runner = () => harness.getExtensionRunner();
	runner().setUIContext(ui, "tui");
	return {
		harness,
		loaded: () => loader.getExtensions().extensions.map((extension) => extension.path),
		emit: (type: "session_start" | "agent_start" | "agent_settled") =>
			runner().emit(type === "session_start" ? { type, reason: "startup" } : { type }),
		wake: (source: string, activeCount: number) =>
			runner().emitBusEvent(WAKE_SOURCE_STATE_EVENT, { source, activeCount }),
		pane: () => setProgramStatus.mock.calls.at(-1)?.[0]?.state,
		todo: () => renderWidget(widgets.at(-1)),
		watchers: () => {
			const handles: SessionLiveness[] = [];
			runner().emitBusEvent(SESSION_LIVENESS_CONNECT_EVENT, (handle: SessionLiveness) => handles.push(handle));
			return handles.length;
		},
		polls: () => setInterval.mock.calls.filter(([, ms]) => ms === POLL_MS).length,
		subscribers: (channel: string) => subscribe.mock.calls.filter(([name]) => name === channel).length,
	};
}
