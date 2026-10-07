import { join } from "node:path";
import { encodedSessionId } from "../../../session-sidecar-store.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";
import { isEvalOnlyRouting } from "../eval-only-routing.ts";
import {
	buildToolContext,
	bundleSinks,
	createBundle,
	sessionKeyOf,
	type TerminalExtensionState,
} from "./extension-state.ts";
import { currentLeaseToken, releaseTerminalLease, retireLeaseToken } from "./manifest-lease.ts";
import { MonitorNotifier } from "./monitor-notify.ts";
import { terminalStateDir } from "./monitor-state-dir.ts";
import { MONITOR_STATUS_KEY } from "./monitor-status.ts";
import { MonitorStatusTicker } from "./monitor-status-ticker.ts";
import { TerminalNotifier } from "./notify.ts";
import { buildTerminalPromptSection } from "./prompt.ts";
import { createDigestSlot, registerRestoreDigestRenderer } from "./restore-digest.ts";
import { detachPersistence, flushRestoreDigest, startPersistence, stopPersistence } from "./restore-session.ts";
import { claimParkedBundle, parkBundle, teardownParkedBundle } from "./session-bundle.ts";
import { loadTerminalSettings, TERMINAL_SETTINGS_DEFAULTS } from "./settings.ts";
import { TERMINAL_BASH_TOOL, TERMINAL_COMPANION_TOOLS } from "./shared.ts";
import { TerminalManifestWriter } from "./terminal-manifest.ts";
import { createPtyBashTool } from "./tools/bash.ts";
import { createBashInputTool } from "./tools/bash-input.ts";
import { createBashOutputTool } from "./tools/bash-output.ts";
import { createBashResizeTool } from "./tools/bash-resize.ts";
import { createKillBashTool } from "./tools/kill-bash.ts";
import { bindTerminalManifestWriter, createMonitorTool } from "./tools/monitor.ts";

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
		lease: null,
		manifestWriter: null,
		ensurePersistence: null,
		recordedBackgroundIds: new Set(),
		keeper: null,
		digestSlot: createDigestSlot(),
		generation: 0,
		restoreInFlight: Promise.resolve(),
		parked: false,
	};
	const toolCtx = buildToolContext(pi, state);

	pi.registerTool(createPtyBashTool(toolCtx));
	pi.registerTool(createBashOutputTool(toolCtx));
	pi.registerTool(createBashInputTool(toolCtx));
	pi.registerTool(createBashResizeTool(toolCtx));
	pi.registerTool(createKillBashTool(toolCtx));
	pi.registerTool(createMonitorTool(toolCtx));
	registerRestoreDigestRenderer(pi);

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
		const holdsLease = sessionKey !== undefined && currentLeaseToken(encodedSessionId(sessionKey)) !== undefined;
		if (event.reason === "reload" && holdsLease) {
			// Park/claim and the lease stay untouched: the same pid keeps holding it. The
			// reload generation only rebinds the recorder so manifest coverage continues.
			if (sessionKey !== undefined && terminalStateDir(ctx) !== undefined) {
				const writer = new TerminalManifestWriter({ session: ctx.sessionManager });
				// SF-2: seed from disk so the first post-reload write keeps the pre-reload entries.
				await writer.seedFromDisk();
				state.manifestWriter = writer;
				state.recordedBackgroundIds.clear();
				bindTerminalManifestWriter(sessionKey, writer);
			}
		} else if (sessionKey !== undefined) {
			await startPersistence({ pi, state, toolCtx, sessionKey });
		}
		syncToolset(pi, state);
	});

	pi.on("session_parked", () => {
		state.parked = true;
		state.bundle?.monitors.setParked(true);
		state.statusTicker.stop();
	});

	pi.on("session_resumed", () => {
		state.parked = false;
		state.bundle?.monitors.setParked(false);
		if (state.bundle) state.statusTicker.sync(state.bundle.monitors.snapshot());
	});

	pi.on("model_select", async (event, ctx) => {
		state.ctx = { ...ctx, model: event.model };
		syncToolset(pi, state);
		flushRestoreDigest(pi, state);
	});

	pi.on("input", (event) => {
		if (event.source === "extension") return;
		state.monitorNotifier?.noteActivity();
		flushRestoreDigest(pi, state);
		const resumed = state.bundle?.monitors.resume() ?? [];
		if (resumed.length > 0) state.monitorNotifier?.resume(resumed.map((monitor) => monitor.id));
	});

	pi.on("tool_call", () => {
		state.monitorNotifier?.noteActivity();
	});

	pi.on(
		"before_agent_start",
		async (event) => {
			if (state.steppedAside) return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n${buildTerminalPromptSection({ evalOnly: isEvalOnlyRouting(pi) })}`,
			};
		},
		{ previewSafe: true },
	);

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
			state.keeper?.stop();
			state.keeper = null;
			detachPersistence(state, sessionKey);
			state.bundle.park();
			await parkBundle(sessionKey, state.bundle);
			return;
		}
		const inheritedLease = state.lease === null;
		if (sessionKey !== undefined) await stopPersistence(state, sessionKey);
		if (inheritedLease && sessionKey !== undefined) {
			const dir = terminalStateDir(ctx) ?? terminalStateDir(state.ctx);
			// A reload generation inherits the pre-reload lease without re-acquiring it;
			// releasing by (path, own pid) removes exactly that file and no foreign holder's.
			if (dir !== undefined) {
				const token = currentLeaseToken(encodedSessionId(sessionKey));
				if (token !== undefined) retireLeaseToken(token);
				await releaseTerminalLease({
					path: join(dir, `${encodedSessionId(sessionKey)}.lease`),
					pid: process.pid,
					...(token === undefined ? {} : { token }),
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
