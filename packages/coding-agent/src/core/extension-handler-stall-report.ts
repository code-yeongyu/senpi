import { basename } from "node:path";
import type { ExtensionHandlerStall } from "./extensions/handler-budget.ts";
import type { SessionLogger } from "./session-log.ts";

type Notify = (message: string, type: "warning") => void;

function seconds(ms: number): string {
	return `${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * Makes a stalled extension handler diagnosable (senpi#3650): every stage lands in session.log with the event and
 * extension, and a handler still running past the warning is shown, because the turn is waiting on it. A timeout or
 * deadline release is shown by the runner's extension error, so it is only logged here. A slow agent_settled handler is
 * only logged: clients already saw the settle and a person's next input does not wait on it.
 */
export function reportExtensionHandlerStall(stall: ExtensionHandlerStall, logger: SessionLogger, notify: Notify): void {
	const extension = basename(stall.extensionPath);
	logger.warn("extension_handler_stalled", {
		extension,
		handlerEvent: stall.event,
		stage: stall.stage,
		durationMs: stall.elapsedMs,
		...(stall.error === undefined ? {} : { error: stall.error }),
	});
	if (stall.stage !== "warn") return;
	// The turn is already settled on clients and a person's next input does not wait on it (omo#11419): nothing to act on.
	if (stall.event === "agent_settled") return;
	const cap =
		stall.timeoutMs > 0
			? ` The session continues without it after ${seconds(stall.timeoutMs)}.`
			: " Action: set extensionEventHandlerTimeoutMs to bound it, or remove the extension.";
	notify(
		`Extension ${extension} is still running its ${stall.event} handler after ${seconds(stall.elapsedMs)}, so this turn is waiting on it.${cap}`,
		"warning",
	);
}
