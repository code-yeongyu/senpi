import { SessionPendingInputs } from "../pending-input-session.ts";
import { SessionManager } from "../session-manager.ts";
import type { MoveId } from "./ownership.ts";

/**
 * Puts input a move took out of a session back into its pending-input journal, as follow-ups in their original
 * order. Each gets the id `move:<moveId>:<index>`, so running this twice admits each input once: the second pass is
 * answered from the journal (`replayed`). The session restores them to its queue when it is next opened.
 */
export async function requeueInput(sessionFile: string, moveId: MoveId, texts: readonly string[]): Promise<void> {
	if (texts.length === 0) return;
	const sessionManager = await SessionManager.openAsync(sessionFile);
	let next = 0;
	const inputs = new SessionPendingInputs({ sessionManager, nextQueuedId: () => `move-${moveId}-${next++}` });
	for (const [index, text] of texts.entries()) {
		await inputs.admit({ clientMessageId: `move:${moveId}:${index}`, text, mode: "followUp" }, () => undefined);
	}
}
