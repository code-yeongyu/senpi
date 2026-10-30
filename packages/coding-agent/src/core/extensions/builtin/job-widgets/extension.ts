/**
 * The job-widgets builtin: per session it opens the widget registry hosts feed (the terminal's
 * background sessions, omo's task jobs), binds the model author, and sends `job_widget_state` to
 * in-process listeners and to RPC clients that advertise `extension_events`. Default on, no setup;
 * `jobWidgets.enabled: false` opens nothing, so hosts tap nothing and no author is ever called.
 * In the interactive TUI the same in-process event drives the widget area above the editor. An RPC
 * client that starts receiving extension events gets the current state once (when a job shows).
 */
import { EXTENSION_RPC_SUBSCRIBED_CHANNEL } from "../../../event-bus.ts";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isStaleExtensionContextError } from "../goal/stale-context.ts";
import { JOB_WIDGET_STATE_EVENT } from "../monitor-state-event.ts";
import { secretOutputObfuscator } from "./author-redact.ts";
import { createSessionJobWidgetAuthor } from "./session-author.ts";
import {
	closeJobWidgetSession,
	openJobWidgetSession,
	parkJobWidgetSession,
	resendJobWidgetState,
} from "./session-host.ts";
import { JobWidgetArea } from "./tui-widget.ts";
import type { JobWidgetState } from "./view-types.ts";

function publishState(pi: ExtensionAPI, state: JobWidgetState): void {
	try {
		pi.events?.emit(JOB_WIDGET_STATE_EVENT, state);
		pi.rpc?.emit(JOB_WIDGET_STATE_EVENT, state);
	} catch (error) {
		// A retired generation cannot reach a listener; the next one re-sends the state when it binds.
		if (!isStaleExtensionContextError(error)) throw error;
	}
}

export default function jobWidgetsExtension(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let stopArea: (() => void) | undefined;
	let stopResend: (() => void) | undefined;

	const showInTui = (startCtx: ExtensionContext, id: string): void => {
		stopArea?.();
		stopArea = undefined;
		if (startCtx.mode !== "tui" || !startCtx.hasUI || !pi.events) return;
		const area = new JobWidgetArea({ setWidget: (key, content) => startCtx.ui.setWidget(key, content) });
		const off = pi.events.on(JOB_WIDGET_STATE_EVENT, (data) => {
			const state = data as JobWidgetState;
			if (state.sessionId === id) area.update(state);
		});
		stopArea = () => {
			off();
			area.dispose();
		};
	};

	pi.on("session_start", (_event, startCtx) => {
		ctx = startCtx;
		sessionId = startCtx.sessionManager?.getSessionId?.();
		if (sessionId === undefined) return;
		const settingsManager = SettingsManager.create(startCtx.cwd, startCtx.agentDir);
		const settings = settingsManager.getJobWidgetsSettings();
		if (!settings.enabled) {
			closeJobWidgetSession(sessionId);
			return;
		}
		showInTui(startCtx, sessionId);
		const id = sessionId;
		stopResend?.();
		stopResend = pi.events?.on(EXTENSION_RPC_SUBSCRIBED_CHANNEL, () => resendJobWidgetState(id));
		openJobWidgetSession(sessionId, {
			authorAfterMs: settings.authorAfterMs,
			author: createSessionJobWidgetAuthor(() => ctx, settings.model),
			publish: (state) => publishState(pi, state),
			...(settingsManager.getBashRedactSecretsInOutput() ? { obfuscate: secretOutputObfuscator } : {}),
		});
	});

	pi.on("model_select", (event, selectCtx) => {
		// Copy the descriptors, not the values: a spread reads every guarded getter now and freezes
		// them past the stale-instance checks (see ExtensionRunner.createCommandContext).
		const next = Object.defineProperties({}, Object.getOwnPropertyDescriptors(selectCtx)) as ExtensionContext;
		ctx = Object.defineProperty(next, "model", { value: event.model, enumerable: true, configurable: true });
	});

	pi.on("session_shutdown", (event) => {
		stopArea?.();
		stopArea = undefined;
		stopResend?.();
		stopResend = undefined;
		if (sessionId === undefined) return;
		if (event.reason === "reload") parkJobWidgetSession(sessionId);
		else closeJobWidgetSession(sessionId);
	});
}
