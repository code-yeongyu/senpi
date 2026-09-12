import type { ClaudeSdkOauthAuthLane } from "./options.ts";
import { type ContinuityBinding, forgetBinding, getBinding, verifyRestoredTranscript } from "./session-reattach.ts";

export type RestoredBindingAdmission = {
	readonly binding: ContinuityBinding | undefined;
	readonly transcriptAvailable: boolean;
};

export async function admitRestoredBinding(
	sessionId: string,
	cwd: string | undefined,
	authLane: ClaudeSdkOauthAuthLane,
): Promise<RestoredBindingAdmission> {
	const binding = getBinding(sessionId);
	if (binding?.sentPrefixHash === undefined) return { binding, transcriptAvailable: true };
	const transcriptAvailable = cwd !== undefined && (await verifyRestoredTranscript(binding, cwd, authLane));
	if (!transcriptAvailable) forgetBinding(sessionId);
	return { binding, transcriptAvailable };
}
