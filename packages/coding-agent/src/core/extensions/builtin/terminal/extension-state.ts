/** The terminal extension's per-generation state, the bundle event sinks it binds, and the tool context over it. */

import { getShellEnv } from "../../../../utils/shell.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	TERMINAL_MONITOR_ENDED_EVENT,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";
import type { MonitorNotifier } from "./monitor-notify.ts";
import { removeMonitorStateDir, terminalStateDir } from "./monitor-state-dir.ts";
import type { MonitorStatusTicker } from "./monitor-status-ticker.ts";
import type { TerminalNotifier } from "./notify.ts";
import type { PersistenceState } from "./restore-session.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import { type TerminalEventSinks, TerminalSessionBundle } from "./session-bundle.ts";
import type { ResolvedTerminalSettings } from "./settings.ts";
import type { TerminalToolContext } from "./tools/context.ts";

export interface TerminalExtensionState extends PersistenceState {
	settings: ResolvedTerminalSettings;
	notifier: TerminalNotifier | null;
	monitorNotifier: MonitorNotifier | null;
	statusTicker: MonitorStatusTicker;
	shellPath: string | undefined;
	steppedAside: boolean;
	noticeShown: boolean;
	parked: boolean;
}

/** Tests and SDK callers may hand partial contexts without a session manager. */
export function sessionKeyOf(ctx: ExtensionContext | undefined): string | undefined {
	return ctx?.sessionManager?.getSessionId?.();
}

export function createBundle(state: TerminalExtensionState): TerminalSessionBundle {
	return new TerminalSessionBundle({
		maxSessions: state.settings.maxSessions,
		scrollback: state.settings.scrollback,
	});
}

/** Sinks read the live instance state at call time, so notifier swaps need no re-bind. */
export function bundleSinks(pi: ExtensionAPI, state: TerminalExtensionState): TerminalEventSinks {
	return {
		onMonitorEvent: (event) => state.monitorNotifier?.notifyEvent(event),
		onMonitorEnded: (event) => {
			pi.events?.emit(TERMINAL_MONITOR_ENDED_EVENT, event);
			pi.rpc?.emit(TERMINAL_MONITOR_ENDED_EVENT, event);
			// A watch that ended in this process (its command exited, it was killed or expired) never
			// runs again, so its restore baseline goes. Disposal is a shutdown or reload: the watch is
			// suspended, not ended, and a later restore still needs the dir.
			if (event.reason === "disposed") return;
			const dir = terminalStateDir(state.ctx);
			const monitorId = state.bundle?.manager.monitorIdOf(event.id);
			if (dir === undefined || monitorId === undefined) return;
			removeMonitorStateDir(dir, monitorId).catch((error: unknown) => {
				state.ctx?.ui?.notify?.(
					`Could not remove the state dir of ${monitorId}: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			});
		},
		onMonitorState: (snapshot, transition = true) => {
			if (!state.parked) state.statusTicker.sync(snapshot);
			const payload = {
				activeCount: snapshot.length,
				monitors: snapshot.map((entry) => ({
					id: entry.id,
					description: entry.description,
					paused: entry.paused,
					startedAtMs: entry.startedAtMs,
					command: entry.command,
					filter: entry.filter,
					persistent: entry.persistent,
					deadlineMs: entry.deadlineMs,
					fireCount: entry.fireCount,
					lastFiredAtMs: entry.lastFiredAtMs,
				})),
			};
			pi.events?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
			pi.rpc?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
			if (!transition) return;
			pi.events?.emit(WAKE_SOURCE_STATE_EVENT, {
				source: "terminal-monitors",
				activeCount: snapshot.length,
				monitors: snapshot.map((entry) => ({
					id: entry.id,
					description: entry.description,
					startedAtMs: entry.startedAtMs,
				})),
			});
			if (state.manifestWriter) void state.manifestWriter.observeMonitorState(snapshot);
		},
		onBackgroundState: (snapshot) => {
			pi.events?.emit(WAKE_SOURCE_STATE_EVENT, {
				source: "terminal-background-sessions",
				activeCount: snapshot.length,
				items: snapshot,
			});
			const record = (): void => {
				const writer = state.manifestWriter;
				if (!writer) return;
				for (const entry of snapshot) {
					if (state.recordedBackgroundIds.has(entry.id)) continue;
					state.recordedBackgroundIds.add(entry.id);
					const identity = state.bundle?.manager.get(entry.id)?.identity();
					void writer.recordBackgroundStart(entry.id, entry.description ?? entry.id, entry.startedAtMs, identity);
				}
			};
			if (state.manifestWriter === null && state.ensurePersistence !== null && snapshot.length > 0) {
				void state.ensurePersistence().then(record);
				return;
			}
			record();
		},
		onBackgroundExit: (id, runtime) => {
			state.recordedBackgroundIds.delete(id);
			if (state.manifestWriter) void state.manifestWriter.recordBackgroundExit(id);
			state.notifier?.notifyCompletion(id, runtime);
		},
	};
}

export function buildToolContext(pi: ExtensionAPI, state: TerminalExtensionState): TerminalToolContext {
	const requireBundle = (): TerminalSessionBundle => {
		// Lazily create a bundle so the tools work even when invoked directly (e.g. via the
		// SDK) before `session_start` initializes one. `session_start` replaces it with a
		// settings-configured bundle and tears down any earlier one.
		if (!state.bundle) {
			state.bundle = createBundle(state);
			state.bundle.monitors.setParked(state.parked);
			state.bundle.bind(bundleSinks(pi, state));
		}
		return state.bundle;
	};
	return {
		get manager() {
			return requireBundle().manager;
		},
		get cwd() {
			return state.ctx?.cwd ?? process.cwd();
		},
		get shellPath() {
			return state.shellPath;
		},
		get defaultCols() {
			return state.settings.defaultCols;
		},
		get defaultRows() {
			return state.settings.defaultRows;
		},
		get timeoutAction() {
			return state.settings.timeoutAction;
		},
		get maxDurableMonitors() {
			return state.settings.maxDurableMonitors;
		},
		get monitorRegistry() {
			return requireBundle().monitors;
		},
		getEnv: () => getShellEnv(),
		getSessionContext: () => state.ctx,
		// Exit listeners registered before a reload reach the post-reload owner through the
		// shared bundle, so this must dispatch via the bundle, never the instance notifier.
		onBackgroundStart: (id: string, description: string, startedAtMs: number) => {
			state.bundle?.notifyBackgroundStart(id, description, startedAtMs);
		},
		onBackgroundExit: (id: string, runtime: TerminalRuntimeSession) => {
			state.bundle?.notifyBackgroundExit(id, runtime);
		},
		onMonitorRearmed: (id: string) => state.monitorNotifier?.rearm(id),
		onMonitorsResumed: (ids: readonly string[]) => state.monitorNotifier?.resume(ids),
		ensurePersistence: () => state.ensurePersistence?.() ?? Promise.resolve(),
	};
}
