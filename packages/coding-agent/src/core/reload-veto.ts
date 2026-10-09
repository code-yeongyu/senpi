import type { ExtensionRunner } from "./extensions/runner.ts";
import type { ReloadVetoDecision } from "./extensions/types.ts";

export async function checkSessionReloadVeto(
	runner: Pick<ExtensionRunner, "hasHandlers" | "emit">,
	isPromptStartPending: () => boolean,
	isSessionStartDispatching: () => boolean = () => false,
): Promise<ReloadVetoDecision> {
	if (isPromptStartPending()) {
		return { cancelled: true, reason: "A prompt is being admitted." };
	}
	if (isSessionStartDispatching()) {
		return { cancelled: true, reason: "A session is starting." };
	}
	const result = runner.hasHandlers("session_before_reload")
		? await runner.emit({ type: "session_before_reload" })
		: undefined;
	if (isPromptStartPending()) {
		return { cancelled: true, reason: "A prompt is being admitted." };
	}
	if (isSessionStartDispatching()) {
		return { cancelled: true, reason: "A session is starting." };
	}
	if (result?.cancel !== true) return { cancelled: false };
	return result.reason === undefined ? { cancelled: true } : { cancelled: true, reason: result.reason };
}
