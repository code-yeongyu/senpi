import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";

const PERSISTED_SOURCE_LABELS = new Set(["Operation aborted", "System operation aborted"]);
// Labels this module itself persists on the live path. A transcript replay has
// no live provenance and must render them verbatim, never re-prefix them.
const PERSISTED_PROVIDER_LABEL_RE = /^(?:Provider retry failed after \d+ attempts?|Provider request failed(?::.*)?)$/;

export function abortedMessageForRendering(
	message: AssistantMessage,
	retryAttempt: number,
	abortSource: AgentAbortSource | undefined,
): AssistantMessage {
	if (message.stopReason !== "aborted") return message;
	return { ...message, errorMessage: abortedErrorLabel(message.errorMessage, retryAttempt, abortSource) };
}

/** Result text for a tool call the model emitted but that never ran because the turn ended (senpi#5064). */
export const UNRUN_AFTER_ERROR = "Not run: the request failed.";

/**
 * `rendered` has been through `abortedMessageForRendering`. An abort keeps its label: when the turn ends in a
 * tool call, the card is the abort's only notice. An error stop shows its classified notice once elsewhere, so the
 * card never repeats the raw provider error.
 */
export function unrunToolCallText(rendered: AssistantMessage): string {
	return rendered.stopReason === "aborted" ? rendered.errorMessage || "Provider request failed" : UNRUN_AFTER_ERROR;
}

export function abortedErrorLabel(
	persisted: string | undefined,
	retryAttempt: number,
	abortSource: AgentAbortSource | undefined,
): string {
	if (abortSource === "user") return "Operation aborted";
	if (abortSource === "system") return "System operation aborted";
	if (abortSource === "provider") return persisted ?? "Provider request failed";
	if (persisted !== undefined && PERSISTED_SOURCE_LABELS.has(persisted)) return persisted;
	if (persisted !== undefined && PERSISTED_PROVIDER_LABEL_RE.test(persisted)) return persisted;
	const legacyRetry = persisted?.match(/^Aborted after (\d+) retry attempts?$/);
	if (legacyRetry) return `Provider retry failed after ${legacyRetry[1]} attempt${legacyRetry[1] === "1" ? "" : "s"}`;
	if (retryAttempt > 0) return `Provider retry failed after ${retryAttempt} attempt${retryAttempt === 1 ? "" : "s"}`;
	if (persisted !== undefined && persisted !== "Request was aborted") return `Provider request failed: ${persisted}`;
	return "Provider request failed";
}
