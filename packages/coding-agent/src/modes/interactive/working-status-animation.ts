import type { LoaderIndicatorOptions } from "@earendil-works/pi-tui";
import {
	formatWorkingStatusMessage,
	formatWorkingStatusTextFrame,
	formatToolHookStatusMessage,
	type ToolHookStatusHookName,
	type WorkingStatusMessageFrameStyle,
} from "./working-status.ts";

/** Content changes at the session cadence; only the label's colors are animated between those updates. */
export function workingStatusAnimation(
	getElapsedSeconds: () => number,
	interruptKey: string,
	style: WorkingStatusMessageFrameStyle,
	contentIntervalMs: number,
): Pick<
	LoaderIndicatorOptions,
	"messageFormatter" | "messageIntervalMs" | "presentationFormatter" | "presentationIntervalMs"
> {
	let label = "";
	let suffix = "";
	return {
		messageIntervalMs: contentIntervalMs,
		messageFormatter: (message) => {
			label = message;
			suffix = style.suffix(formatWorkingStatusMessage("", getElapsedSeconds(), interruptKey));
			return message + suffix;
		},
		presentationIntervalMs: Math.min(80, contentIntervalMs),
		presentationFormatter: (_message, elapsedMs) => formatWorkingStatusTextFrame(label, elapsedMs, style) + suffix,
	};
}

/** Freeze hook details/elapsed text at the content tick while its label's highlight keeps moving. */
export function hookStatusAnimation(
	hookName: ToolHookStatusHookName,
	statusMessage: string,
	startedAt: number,
	style: WorkingStatusMessageFrameStyle,
): () => string {
	const label = `Running ${hookName} hook`;
	const seconds = Math.floor(Math.max(0, Date.now() - startedAt) / 1000);
	const suffix = style.suffix(formatToolHookStatusMessage(hookName, statusMessage, seconds).slice(label.length));
	return () => formatWorkingStatusTextFrame(label, Math.max(0, Date.now() - startedAt), style) + suffix;
}
