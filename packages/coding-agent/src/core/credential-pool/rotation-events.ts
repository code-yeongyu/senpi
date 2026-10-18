import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

/**
 * Frames that announce the message or open a block without delivering any of
 * its content. Nothing the user can read has been committed after them, so a
 * replacement attempt may still take over the stream (default-DENY: every other
 * event type, known or unknown, counts as committed).
 */
const PRE_COMMIT_EVENT_TYPES: ReadonlySet<AssistantMessageEvent["type"]> = new Set<AssistantMessageEvent["type"]>([
	"start",
	"text_start",
	"thinking_start",
	"toolcall_start",
]);

export function isCommittedRotationOutput(event: AssistantMessageEvent): boolean {
	return !PRE_COMMIT_EVENT_TYPES.has(event.type);
}

export function isRotationStreamStart(event: AssistantMessageEvent): boolean {
	return event.type === "start";
}

/** The failure a terminal error event carries, with the adapter's structured HTTP status for classification. */
export function rotationErrorFromEvent(event: AssistantMessageEvent): unknown {
	if (event.type !== "error") return undefined;
	const failure = new Error(event.error.errorMessage ?? "provider stream error");
	const status = event.error.providerDiagnostic?.httpStatus;
	return status === undefined ? failure : Object.assign(failure, { status });
}
