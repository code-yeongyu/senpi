import type { AnthropicSubscriptionAuthLane } from "./options.ts";
import { type ContinuityBinding, forgetBinding, getBinding, verifyRestoredTranscript } from "./session-reattach.ts";

export type RestoredBindingAdmission = {
	readonly binding: ContinuityBinding | undefined;
	readonly transcriptAvailable: boolean;
};

export async function admitRestoredBinding(
	sessionId: string,
	cwd: string | undefined,
	authLane: AnthropicSubscriptionAuthLane,
): Promise<RestoredBindingAdmission> {
	const binding = getBinding(sessionId);
	if (binding?.sentPrefixHash === undefined) return { binding, transcriptAvailable: true };
	const transcriptAvailable = cwd !== undefined && (await verifyRestoredTranscript(binding, cwd, authLane));
	if (!transcriptAvailable) forgetBinding(sessionId);
	return { binding, transcriptAvailable };
}

/**
 * Wraps one admission so that running it again reports what the first run decided. `admitRestoredBinding` forgets a
 * binding whose transcript it rejects, so a repeat (a model switch landed mid-admission, `admitSettledTurn`) would
 * otherwise read no binding and call the transcript available. A rejection stands only while nothing was recorded
 * since: a binding recorded meanwhile (a timed-out switch keeps its lineage) is admitted afresh.
 */
export function repeatableAdmission(
	sessionId: string,
	admit: () => Promise<RestoredBindingAdmission>,
): () => Promise<RestoredBindingAdmission> {
	let decided: RestoredBindingAdmission | undefined;
	return async () => {
		if (decided !== undefined && !decided.transcriptAvailable && getBinding(sessionId) === undefined) return decided;
		decided = await admit();
		return decided;
	};
}
