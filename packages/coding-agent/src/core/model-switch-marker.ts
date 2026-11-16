import type { CustomMessage } from "./messages.ts";

/** Custom type of the context note a fallback switch or its revert leaves for the model (omo#13243). */
export const MODEL_SWITCH_MARKER_TYPE = "model_switch";

export interface ModelSwitchMarkerDetails {
	readonly from: string | undefined;
	readonly to: string;
	readonly reason: "fallback" | "fallback-revert";
}

/**
 * The note the model reads on its next request after the retry engine changed which model answers:
 * without it a session keeps stating its launch model while another model writes its replies.
 */
export function modelSwitchMarker(
	details: ModelSwitchMarkerDetails,
	timestamp: number = Date.now(),
): CustomMessage<ModelSwitchMarkerDetails> {
	const from = details.from ?? "the previous model";
	const content =
		details.reason === "fallback"
			? `[model fallback] ${from} failed, so the retry engine moved this session to ${details.to}. Replies from here on are written by ${details.to}, not ${from}, until the session returns to ${from}.`
			: `[model fallback ended] The session is back on ${details.to}; replies are written by ${details.to} again.`;
	return { role: "custom", customType: MODEL_SWITCH_MARKER_TYPE, content, display: false, details, timestamp };
}
