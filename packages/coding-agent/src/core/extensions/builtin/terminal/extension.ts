import { getShellEnv } from "../../../../utils/shell.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";
import { TERMINAL_MONITOR_STATE_EVENT } from "../monitor-state-event.ts";
import { MonitorNotifier } from "./monitor-notify.ts";
import { MONITOR_STATUS_KEY } from "./monitor-status.ts";
import { MonitorStatusTicker } from "./monitor-status-ticker.ts";
import { TerminalNotifier } from "./notify.ts";
import { TERMINAL_PROMPT_SECTION } from "./prompt.ts";
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
import { createPtyBashTool } from "./tools/bash.ts";
import { createBashInputTool } from "./tools/bash-input.ts";
import { createBashOutputTool } from "./tools/bash-output.ts";
import { createBashResizeTool } from "./tools/bash-resize.ts";
import type { TerminalToolContext } from "./tools/context.ts";
import { createKillBashTool } from "./tools/kill-bash.ts";
import { createMonitorTool } from "./tools/monitor.ts";

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
}

/** Tests and SDK callers may hand partial contexts without a session manager. */
function sessionKeyOf(ctx: ExtensionContext | undefined): string | undefined {
	return ctx?.sessionManager?.getSessionId?.();
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
			pi.events?.emit(TERMINAL_MONITOR_STATE_EVENT, {
				activeCount: snapshot.length,
				monitors: snapshot.map((entry) => ({
					id: entry.id,
					description: entry.description,
					paused: entry.paused,
					startedAtMs: entry.startedAtMs,
				})),
			});
		},
		onBackgroundExit: (id, runtime) => state.notifier?.notifyCompletion(id, runtime),
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
		onBackgroundExit: (id: string, runtime: TerminalRuntimeSession) => {
			state.bundle?.notifyBackgroundExit(id, runtime);
		},
		onMonitorRearmed: (id: string) => state.monitorNotifier?.rearm(id),
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
			pauseMonitors: () => state.bundle?.monitors.pauseAll() ?? [],
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
		syncToolset(pi, state);
	});

	pi.on("model_select", async (event, ctx) => {
		state.ctx = { ...ctx, model: event.model };
		syncToolset(pi, state);
	});

	pi.on("input", (event) => {
		if (event.source !== "extension") state.monitorNotifier?.noteActivity();
	});

	pi.on("tool_call", () => {
		state.monitorNotifier?.noteActivity();
	});

	pi.on("before_agent_start", async (event) => {
		if (state.steppedAside) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n${TERMINAL_PROMPT_SECTION}` };
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
			state.bundle.park();
			await parkBundle(sessionKey, state.bundle);
			return;
		}
		const bundle = state.bundle;
		state.bundle = null;
		await bundle?.teardown();
		if (sessionKey !== undefined) await teardownParkedBundle(sessionKey);
	});
}

export default registerTerminalExtension;
