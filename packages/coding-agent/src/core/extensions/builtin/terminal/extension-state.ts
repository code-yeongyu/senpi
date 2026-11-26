/** The terminal extension's per-generation state, the bundle event sinks it binds, and the tool context over it. */

import { getShellEnv } from "../../../../utils/shell.ts";
import type { ExtensionRpcEvent } from "../../../event-bus.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import {
	TERMINAL_BACKGROUND_AGE_EVENT,
	TERMINAL_MONITOR_ENDED_EVENT,
	TERMINAL_MONITOR_STATE_EVENT,
	WAKE_SOURCE_STATE_EVENT,
} from "../monitor-state-event.ts";
import { withTerminalContext } from "./context-lifetime.ts";
import { tapBackgroundSession, untapBackgroundSession } from "./job-widget-tap.ts";
import type { MonitorNotifier } from "./monitor-notify.ts";
import type { MonitorSnapshotEntry } from "./monitor-registry.ts";
import { removeMonitorStateDir, terminalStateDir } from "./monitor-state-dir.ts";
import type { MonitorStatusTicker } from "./monitor-status-ticker.ts";
import { describeBackgroundAge, type TerminalNotifier } from "./notify.ts";
import type { PersistenceState } from "./restore-session.ts";
import { type TerminalEventSinks, TerminalSessionBundle } from "./session-bundle.ts";
import type { ResolvedTerminalSettings } from "./settings.ts";
import type { TerminalExitView, TerminalToolContext } from "./tools/context.ts";

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

function monitorState(snapshot: readonly MonitorSnapshotEntry[]) {
	return {
		activeCount: snapshot.length,
		monitors: snapshot.map(
			({
				id,
				description,
				paused,
				startedAtMs,
				command,
				filter,
				persistent,
				deadlineMs,
				fireCount,
				lastFiredAtMs,
			}) => ({
				id,
				description,
				paused,
				startedAtMs,
				command,
				filter,
				persistent,
				deadlineMs,
				fireCount,
				lastFiredAtMs,
			}),
		),
	};
}

function monitorWakeState(snapshot: readonly MonitorSnapshotEntry[]) {
	return {
		source: "terminal-monitors",
		activeCount: snapshot.length,
		monitors: snapshot.map((entry) => ({
			id: entry.monitorId ?? entry.id,
			description: entry.description,
			startedAtMs: entry.startedAtMs,
		})),
	};
}

function backgroundWakeState(items: ReturnType<TerminalSessionBundle["backgroundSnapshot"]>) {
	return { source: "terminal-background-sessions", activeCount: items.length, items };
}

export function replayTerminalState(bundle: TerminalSessionBundle, reply: (event: ExtensionRpcEvent) => void): void {
	const monitors = bundle.monitors.snapshot();
	reply({ name: TERMINAL_MONITOR_STATE_EVENT, data: monitorState(monitors) });
	reply({ name: WAKE_SOURCE_STATE_EVENT, data: monitorWakeState(monitors) });
	reply({ name: WAKE_SOURCE_STATE_EVENT, data: backgroundWakeState(bundle.backgroundSnapshot()) });
}

/** Sinks read the live instance state at call time, so notifier swaps need no re-bind. */
export function bundleSinks(pi: ExtensionAPI, state: TerminalExtensionState): TerminalEventSinks {
	const retire = () => {
		state.monitorNotifier?.dispose();
		state.monitorNotifier = null;
		state.notifier = null;
		state.statusTicker.stop();
		state.keeper?.stop();
	};
	return {
		onMonitorEvent: (event) => state.monitorNotifier?.notifyEvent(event),
		onMonitorEnded: (event) => {
			pi.events?.emit(TERMINAL_MONITOR_ENDED_EVENT, event);
			pi.rpc?.emit(TERMINAL_MONITOR_ENDED_EVENT, event);
			// A watch that ended in this process (its command exited, it was killed or expired) never
			// runs again, so its restore baseline goes. Disposal is a shutdown or reload: the watch is
			// suspended, not ended, and a later restore still needs the dir.
			if (event.reason === "disposed") return;
			const dir = withTerminalContext(() => terminalStateDir(state.ctx), retire);
			const monitorId = state.bundle?.manager.monitorIdOf(event.id);
			if (dir === undefined || monitorId === undefined) return;
			removeMonitorStateDir(dir, monitorId).catch((error: unknown) => {
				withTerminalContext(
					() =>
						state.ctx?.ui?.notify?.(
							`Could not remove the state dir of ${monitorId}: ${error instanceof Error ? error.message : String(error)}`,
							"warning",
						),
					retire,
				);
			});
		},
		onMonitorState: (snapshot, transition = true) => {
			if (!state.parked) state.statusTicker.sync(snapshot);
			const payload = monitorState(snapshot);
			pi.events?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
			pi.rpc?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
			if (!transition) return;
			const wake = monitorWakeState(snapshot);
			pi.events?.emit(WAKE_SOURCE_STATE_EVENT, wake);
			pi.rpc?.emit(WAKE_SOURCE_STATE_EVENT, wake);
			if (state.manifestWriter) void state.manifestWriter.observeMonitorState(snapshot);
		},
		onBackgroundState: (snapshot) => {
			const wake = backgroundWakeState(snapshot);
			pi.events?.emit(WAKE_SOURCE_STATE_EVENT, wake);
			pi.rpc?.emit(WAKE_SOURCE_STATE_EVENT, wake);
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
		onBackgroundAge: (event) => {
			pi.events?.emit(TERMINAL_BACKGROUND_AGE_EVENT, event);
			pi.rpc?.emit(TERMINAL_BACKGROUND_AGE_EVENT, event);
			withTerminalContext(
				() => state.ctx?.ui?.notify?.(describeBackgroundAge(event), event.kind === "running" ? "info" : "warning"),
				retire,
			);
			// A reap reaches the model through the session's completion notice, which names the reap.
			if (event.kind !== "reaped") state.notifier?.notifyAge(event);
		},
		onBackgroundExit: (id, runtime) => {
			state.recordedBackgroundIds.delete(id);
			if (state.manifestWriter) void state.manifestWriter.recordBackgroundExit(id);
			state.notifier?.notifyCompletion(id, runtime);
		},
	};
}

/** A background session belongs to the turn that started it, so interrupting that turn with `background: "stop"` stops it. */
function recordRunJob(state: TerminalExtensionState, id: string, description: string): void {
	const bundle = state.bundle;
	if (bundle === null) return;
	const release = withTerminalContext(
		() =>
			state.ctx?.registerRunBackgroundJob?.({
				kind: "bash",
				id,
				description,
				stop: (turnId) => bundle.stopForInterrupt(id, turnId),
			}),
		() => {},
	);
	if (release !== undefined) bundle.trackRunJob(id, release);
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
		get redactSecretsInOutput() {
			return state.settings.redactSecretsInOutput;
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
		get backgroundAutoReapMinutes() {
			return state.settings.backgroundAutoReapMinutes;
		},
		get monitorRegistry() {
			return requireBundle().monitors;
		},
		getEnv: () => getShellEnv(),
		getSessionContext: () => state.ctx,
		// Exit listeners registered before a reload reach the post-reload owner through the
		// shared bundle, so this must dispatch via the bundle, never the instance notifier.
		onBackgroundStart: (
			id: string,
			description: string,
			startedAtMs: number,
			command?: string,
			autoReapMinutes?: number,
		) => {
			state.bundle?.notifyBackgroundStart(id, description, startedAtMs, {
				...(command === undefined ? {} : { command }),
				...(autoReapMinutes === undefined ? {} : { autoReapMinutes }),
			});
			recordRunJob(state, id, description);
			const runtime = state.bundle?.manager.get(id);
			if (runtime) {
				const key = withTerminalContext(
					() => sessionKeyOf(state.ctx),
					() => {},
				);
				tapBackgroundSession(key, id, runtime, {
					command: command ?? description,
					description,
				});
			}
		},
		onSessionInput: (id: string) => untapBackgroundSession(state.bundle?.manager.get(id)),
		onBackgroundExit: (id: string, runtime: TerminalExitView) => {
			state.bundle?.notifyBackgroundExit(id, runtime);
		},
		onBackgroundReapFailed: (id: string, autoReapMinutes: number, reason: string) => {
			state.bundle?.notifyBackgroundReapFailed(id, autoReapMinutes, reason);
		},
		onMonitorRearmed: (id: string) => state.monitorNotifier?.rearm(id),
		onMonitorsResumed: (ids: readonly string[]) => state.monitorNotifier?.resume(ids),
		ensurePersistence: () => state.ensurePersistence?.() ?? Promise.resolve(),
	};
}
