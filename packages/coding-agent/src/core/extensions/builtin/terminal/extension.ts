import { isAbsolute, join } from "node:path";
import { getShellEnv } from "../../../../utils/shell.ts";
import { encodedSessionId } from "../../../session-sidecar-store.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";
import { isEvalOnlyRouting } from "../eval-only-routing.ts";
import { TERMINAL_MONITOR_STATE_EVENT, WAKE_SOURCE_STATE_EVENT } from "../monitor-state-event.ts";
import { acquireTerminalLease, releaseTerminalLease } from "./manifest-lease.ts";
import { MonitorNotifier } from "./monitor-notify.ts";
import { MONITOR_STATUS_KEY } from "./monitor-status.ts";
import { MonitorStatusTicker } from "./monitor-status-ticker.ts";
import { getTerminalNotificationDelivery, TerminalNotifier } from "./notify.ts";
import { buildTerminalPromptSection } from "./prompt.ts";
import { type RestoreDigest, type RestoreHandlers, type RestoreOutcome, restoreTerminalState } from "./restore.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
import {
	claimParkedBundle,
	parkBundle,
	type TerminalEventSinks,
	TerminalSessionBundle,
	teardownParkedBundle,
} from "./session-bundle.ts";
import { loadTerminalSettings, type ResolvedTerminalSettings, TERMINAL_SETTINGS_DEFAULTS } from "./settings.ts";
import { TERMINAL_BASH_TOOL, TERMINAL_COMPANION_TOOLS } from "./shared.ts";
import { type ManifestMonitor, TerminalManifestWriter } from "./terminal-manifest.ts";
import { createPtyBashTool } from "./tools/bash.ts";
import { createBashInputTool } from "./tools/bash-input.ts";
import { createBashOutputTool } from "./tools/bash-output.ts";
import { createBashResizeTool } from "./tools/bash-resize.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { createKillBashTool } from "./tools/kill-bash.ts";
import { bindTerminalManifestWriter, createMonitorTool, unbindTerminalManifestWriter } from "./tools/monitor.ts";

interface TerminalExtensionState {
	bundle: TerminalSessionBundle | null;
	settings: ResolvedTerminalSettings;
	notifier: TerminalNotifier | null;
	monitorNotifier: MonitorNotifier | null;
	statusTicker: MonitorStatusTicker;
	ctx: ExtensionContext | undefined;
	shellPath: string | undefined;
	steppedAside: boolean;
	noticeShown: boolean;
	/** Set only when this generation acquired the persistence lease (non-reload starts). */
	lease: { path: string; pid: number } | null;
	/** Manifest recorder; present only while this process owns the session's lease. */
	manifestWriter: TerminalManifestWriter | null;
	recordedBackgroundIds: Set<string>;
}

/** Tests and SDK callers may hand partial contexts without a session manager. */
function sessionKeyOf(ctx: ExtensionContext | undefined): string | undefined {
	return ctx?.sessionManager?.getSessionId?.();
}

/**
 * Per-session persistence dir for the terminal lease + manifest; undefined when the context
 * carries no durable session dir (SDK/in-memory sessions must not persist terminal state).
 */
function terminalStateDir(ctx: ExtensionContext | undefined): string | undefined {
	const sessionDir = ctx?.sessionManager?.getSessionDir?.();
	if (sessionDir === undefined || sessionDir.length === 0 || !isAbsolute(sessionDir)) return undefined;
	return join(sessionDir, "extensions", "terminal");
}

function createBundle(state: TerminalExtensionState): TerminalSessionBundle {
	return new TerminalSessionBundle({
		maxSessions: state.settings.maxSessions,
		scrollback: state.settings.scrollback,
	});
}

/** Sinks read the live instance state at call time, so notifier swaps need no re-bind. */
function bundleSinks(pi: ExtensionAPI, state: TerminalExtensionState): TerminalEventSinks {
	return {
		onMonitorEvent: (event) => state.monitorNotifier?.notifyEvent(event),
		onMonitorState: (snapshot) => {
			state.statusTicker.sync(snapshot);
			const payload = {
				activeCount: snapshot.length,
				monitors: snapshot.map((entry) => ({
					id: entry.id,
					description: entry.description,
					paused: entry.paused,
					startedAtMs: entry.startedAtMs,
				})),
			};
			pi.events?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
			pi.rpc?.emit(TERMINAL_MONITOR_STATE_EVENT, payload);
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
			const writer = state.manifestWriter;
			if (!writer) return;
			for (const entry of snapshot) {
				if (state.recordedBackgroundIds.has(entry.id)) continue;
				state.recordedBackgroundIds.add(entry.id);
				void writer.recordBackgroundStart(entry.id, entry.description ?? entry.id, entry.startedAtMs);
			}
		},
		onBackgroundExit: (id, runtime) => {
			state.recordedBackgroundIds.delete(id);
			if (state.manifestWriter) void state.manifestWriter.recordBackgroundExit(id);
			state.notifier?.notifyCompletion(id, runtime);
		},
	};
}

function buildToolContext(pi: ExtensionAPI, state: TerminalExtensionState): TerminalToolContext {
	const requireBundle = (): TerminalSessionBundle => {
		// Lazily create a bundle so the tools work even when invoked directly (e.g. via the
		// SDK) before `session_start` initializes one. `session_start` replaces it with a
		// settings-configured bundle and tears down any earlier one.
		if (!state.bundle) {
			state.bundle = createBundle(state);
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
	};
}

function shouldStepAside(ctx: ExtensionContext | undefined): boolean {
	return isAnthropicBashEnabled() && ctx?.model?.api === "anthropic-messages";
}

/**
 * Keep the tool surface consistent with anthropic-bash. When native Anthropic bash is active,
 * the provider replaces the PTY `bash` function, but the companions stay active because `monitor`
 * creates its own PTY session and bash_output/input/resize/kill operate on that shared registry.
 * Otherwise the PTY `bash` + companions are (re)activated. Re-evaluated on session_start AND
 * model_select.
 */
function syncToolset(pi: ExtensionAPI, state: TerminalExtensionState): void {
	const stepAside = shouldStepAside(state.ctx);
	const active = new Set(pi.getActiveTools());
	if (stepAside) {
		for (const companion of TERMINAL_COMPANION_TOOLS) active.add(companion);
		if (!state.noticeShown) {
			state.ctx?.ui.notify("native Anthropic bash active — monitor sessions remain available", "info");
			state.noticeShown = true;
		}
	} else {
		active.add(TERMINAL_BASH_TOOL);
		for (const companion of TERMINAL_COMPANION_TOOLS) active.add(companion);
		state.noticeShown = false;
	}
	state.steppedAside = stepAside;
	pi.setActiveTools([...active]);
}

/** Send one model-visible terminal reminder; suppressed by notify `off` and non-interactive modes. */
function sendTerminalReminder(pi: ExtensionAPI, state: TerminalExtensionState, sentence: string): void {
	getTerminalNotificationDelivery({
		sendMessage: (message, options) => pi.sendMessage(message, options),
		getContext: () => state.ctx,
		getMode: () => state.settings.notify,
	})?.send(`<system-reminder>${sentence}</system-reminder>`);
}

function clauseWithDescriptions(label: string, count: number, descriptions: readonly string[]): string {
	return descriptions.length > 0 ? `${label} ${count} (${descriptions.join(", ")})` : `${label} ${count}`;
}

/**
 * The ONE coalesced restore digest. Counts come from the restore orchestrator; descriptions
 * are attributed per manifest entry so the sentence stays a single message however many
 * monitors there are. Empty clauses are omitted; undefined when there is nothing to report.
 */
function restoreDigestSentence(
	digest: RestoreDigest,
	restoredDescriptions: readonly string[],
	lostDescriptions: readonly string[],
): string | undefined {
	const clauses: string[] = [];
	if (digest.restored > 0) clauses.push(clauseWithDescriptions("restored", digest.restored, restoredDescriptions));
	if (digest.lost > 0) clauses.push(clauseWithDescriptions("lost", digest.lost, lostDescriptions));
	if (digest.expired > 0) clauses.push(`expired ${digest.expired}`);
	if (digest.muted > 0) clauses.push(`${digest.muted} still muted`);
	if (clauses.length === 0) return undefined;
	return `Terminal state after restart: ${clauses.join("; ")}.`;
}

/**
 * Non-reload startup: acquire the persistence lease, then restore from the manifest and
 * deliver EXACTLY ONE coalesced digest. A live foreign holder keeps its lease and gets one
 * attached-elsewhere reminder; an unreadable manifest fails closed with one notice and no
 * restore attempt. Only the lease owner records manifest state afterwards.
 */
async function adoptPersistedTerminalState(
	pi: ExtensionAPI,
	state: TerminalExtensionState,
	sessionKey: string,
): Promise<void> {
	const ctx = state.ctx;
	const dir = terminalStateDir(ctx);
	if (dir === undefined || !ctx?.sessionManager) return;
	const lease = await acquireTerminalLease({ dir, encodedSessionId: sessionKey });
	if (!lease.acquired) {
		sendTerminalReminder(
			pi,
			state,
			`Terminal monitors for this session are attached in another live process (pid ${lease.holder.pid}); nothing was restored here.`,
		);
		return;
	}
	state.lease = { path: lease.path, pid: lease.pid };
	const writer = new TerminalManifestWriter({ session: ctx.sessionManager });
	state.manifestWriter = writer;
	state.recordedBackgroundIds.clear();
	bindTerminalManifestWriter(sessionKey, writer);

	// Restoration handlers: this generation does not re-spawn persisted commands on its own,
	// so every durable entry reports lost; the outcomes still flow through the orchestrator.
	const outcomesById = new Map<string, RestoreOutcome>();
	const reportLost = (monitor: ManifestMonitor): { outcome: RestoreOutcome } => {
		outcomesById.set(monitor.monitorId, "lost");
		return { outcome: "lost" };
	};
	const handlers: RestoreHandlers = { "restartable-command": reportLost, "checkpointed-file": reportLost };
	const nowMs = Date.now();
	const digest = await restoreTerminalState({ manifest: writer.store, handlers, now: () => nowMs });

	let manifest = null;
	let unreadable = digest.storeError;
	if (!unreadable) {
		try {
			manifest = await writer.store.read();
		} catch {
			unreadable = true;
		}
	}
	if (unreadable) {
		sendTerminalReminder(
			pi,
			state,
			"Terminal state after restart: the persisted terminal manifest is corrupt; nothing was restored here (fail closed).",
		);
		return;
	}
	if (manifest === null) return; // nothing was ever persisted for this session

	const restoredDescriptions: string[] = [];
	const lostDescriptions: string[] = [];
	for (const monitor of manifest.monitors) {
		if (monitor.expiresAt !== null && monitor.expiresAt < nowMs) continue;
		if (outcomesById.get(monitor.monitorId) === "restored") restoredDescriptions.push(monitor.description);
		else lostDescriptions.push(monitor.description);
	}
	for (const background of manifest.backgroundSessions) lostDescriptions.push(background.command);
	const sentence = restoreDigestSentence(digest, restoredDescriptions, lostDescriptions);
	if (sentence !== undefined) sendTerminalReminder(pi, state, sentence);
}

/** Detach the manifest recorder without writing (a reload keeps live state instead). */
function detachManifestWriter(state: TerminalExtensionState, sessionKey: string | undefined): void {
	state.manifestWriter = null;
	state.recordedBackgroundIds.clear();
	if (sessionKey !== undefined) unbindTerminalManifestWriter(sessionKey);
}

/**
 * Shutdown view of the manifest: recordShutdown absorbs pending checkpoints, marks every
 * live monitor `suspended`, and persists in one write. Detach FIRST so bundle teardown's
 * empty-registry sync cannot touch the recorder afterwards.
 */
async function suspendAndFlushManifest(state: TerminalExtensionState, sessionKey: string): Promise<void> {
	const writer = state.manifestWriter;
	detachManifestWriter(state, sessionKey);
	if (writer) await writer.recordShutdown();
}

export function registerTerminalExtension(pi: ExtensionAPI): void {
	const state: TerminalExtensionState = {
		bundle: null,
		settings: TERMINAL_SETTINGS_DEFAULTS,
		notifier: null,
		monitorNotifier: null,
		statusTicker: new MonitorStatusTicker({
			render: (status) => {
				const ctx = state.ctx;
				ctx?.ui.setStatus(
					MONITOR_STATUS_KEY,
					status === undefined || ctx.mode !== "tui"
						? status
						: ctx.ui.theme.bg("selectedBg", ctx.ui.theme.fg("text", status)),
				);
			},
		}),
		ctx: undefined,
		shellPath: undefined,
		steppedAside: false,
		noticeShown: false,
		lease: null,
		manifestWriter: null,
		recordedBackgroundIds: new Set(),
	};
	const toolCtx = buildToolContext(pi, state);

	pi.registerTool(createPtyBashTool(toolCtx));
	pi.registerTool(createBashOutputTool(toolCtx));
	pi.registerTool(createBashInputTool(toolCtx));
	pi.registerTool(createBashResizeTool(toolCtx));
	pi.registerTool(createKillBashTool(toolCtx));
	pi.registerTool(createMonitorTool(toolCtx));

	pi.on("session_start", async (event, ctx) => {
		state.ctx = ctx;
		const settingsManager = SettingsManager.create(ctx.cwd);
		state.settings = loadTerminalSettings(settingsManager);
		state.shellPath = settingsManager.getShellPath();
		state.notifier = new TerminalNotifier({
			sendMessage: (message, options) => pi.sendMessage(message, options),
			getContext: () => state.ctx,
			getMode: () => state.settings.notify,
		});
		state.monitorNotifier?.dispose();
		state.monitorNotifier = new MonitorNotifier({
			sendMessage: (message, options) => pi.sendMessage(message, options),
			getContext: () => state.ctx,
			getMode: () => state.settings.notify,
			getSettings: () => state.settings.monitor,
			pauseMonitors: (ids) => state.bundle?.monitors.pause(ids) ?? [],
		});
		const sessionKey = sessionKeyOf(ctx);
		if (event.reason === "reload") {
			const claimed = sessionKey === undefined ? undefined : claimParkedBundle(sessionKey);
			if (claimed) {
				await state.bundle?.teardown();
				state.bundle = claimed;
			}
		} else {
			if (sessionKey !== undefined) await teardownParkedBundle(sessionKey);
			await state.bundle?.teardown();
			state.bundle = createBundle(state);
		}
		state.bundle ??= createBundle(state);
		state.bundle.bind(bundleSinks(pi, state));
		if (event.reason === "reload") {
			// Park/claim and the lease stay untouched: the same pid keeps holding it. The
			// reload generation only rebinds the recorder so manifest coverage continues.
			if (sessionKey !== undefined && terminalStateDir(ctx) !== undefined) {
				const writer = new TerminalManifestWriter({ session: ctx.sessionManager });
				state.manifestWriter = writer;
				state.recordedBackgroundIds.clear();
				bindTerminalManifestWriter(sessionKey, writer);
			}
		} else if (sessionKey !== undefined) {
			await adoptPersistedTerminalState(pi, state, sessionKey);
		}
		syncToolset(pi, state);
	});

	pi.on("model_select", async (event, ctx) => {
		state.ctx = { ...ctx, model: event.model };
		syncToolset(pi, state);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		state.monitorNotifier?.noteActivity();
		const resumed = state.bundle?.monitors.resume() ?? [];
		if (resumed.length > 0) state.monitorNotifier?.resume(resumed.map((monitor) => monitor.id));
	});

	pi.on("tool_call", () => {
		state.monitorNotifier?.noteActivity();
	});

	pi.on("before_agent_start", async (event) => {
		if (state.steppedAside) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n${buildTerminalPromptSection({ evalOnly: isEvalOnlyRouting(pi) })}`,
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		state.monitorNotifier?.dispose();
		state.monitorNotifier = null;
		state.notifier = null;
		state.statusTicker.stop();
		const sessionKey = sessionKeyOf(ctx) ?? sessionKeyOf(state.ctx);
		if (event.reason === "reload" && state.bundle && sessionKey !== undefined) {
			// Keep state.bundle referenced: exit listeners captured by this instance's tool
			// context still route through the shared bundle after the new owner claims it.
			// The lease is deliberately NOT released: the same pid keeps it across the reload.
			detachManifestWriter(state, sessionKey);
			state.bundle.park();
			await parkBundle(sessionKey, state.bundle);
			return;
		}
		if (sessionKey !== undefined) await suspendAndFlushManifest(state, sessionKey);
		const lease = state.lease;
		state.lease = null;
		if (lease !== null) {
			await releaseTerminalLease(lease);
		} else if (sessionKey !== undefined) {
			const dir = terminalStateDir(ctx) ?? terminalStateDir(state.ctx);
			// A reload generation inherits the pre-reload lease without re-acquiring it;
			// releasing by (path, own pid) removes exactly that file and no foreign holder's.
			if (dir !== undefined) {
				await releaseTerminalLease({
					path: join(dir, `${encodedSessionId(sessionKey)}.lease`),
					pid: process.pid,
				});
			}
		}
		const bundle = state.bundle;
		state.bundle = null;
		await bundle?.teardown();
		if (sessionKey !== undefined) await teardownParkedBundle(sessionKey);
	});
}

export default registerTerminalExtension;
