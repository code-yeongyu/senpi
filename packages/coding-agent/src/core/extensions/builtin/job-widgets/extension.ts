/**
 * The job-widgets builtin: per session it opens the widget registry hosts feed (the terminal's
 * background sessions, omo's task jobs), binds the model author, and sends `job_widget_state` to
 * in-process listeners and to RPC clients that advertise `extension_events`. Default on, no setup;
 * `jobWidgets.enabled: false` opens nothing, so hosts tap nothing and no author is ever called.
 */
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isStaleExtensionContextError } from "../goal/stale-context.ts";
import { JOB_WIDGET_STATE_EVENT } from "../monitor-state-event.ts";
import { secretOutputObfuscator } from "./author-redact.ts";
import { createSessionJobWidgetAuthor } from "./session-author.ts";
import { closeJobWidgetSession, openJobWidgetSession, parkJobWidgetSession } from "./session-host.ts";
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
		openJobWidgetSession(sessionId, {
			authorAfterMs: settings.authorAfterMs,
			author: createSessionJobWidgetAuthor(() => ctx, settings.model),
			publish: (state) => publishState(pi, state),
			...(settingsManager.getBashRedactSecretsInOutput() ? { obfuscate: secretOutputObfuscator } : {}),
		});
	});

	pi.on("model_select", (event, selectCtx) => {
		ctx = { ...selectCtx, model: event.model };
	});

	pi.on("session_shutdown", (event) => {
		if (sessionId === undefined) return;
		if (event.reason === "reload") parkJobWidgetSession(sessionId);
		else closeJobWidgetSession(sessionId);
	});
}
