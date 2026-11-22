import type { AgentSession } from "../../core/agent-session.ts";
import { AssistantEditError, assertExpectedLeaf } from "../../core/edited-assistant-message.ts";
import { lifecycleEditLeaf } from "../../core/lifecycle-edit-leaf.ts";
import { RPC_ERROR_INVALID_ARGUMENT, RPC_ERROR_STALE_LEAF } from "./rpc-types.ts";

interface PromptLeafGuard {
	readonly expectedLeafId?: string;
	readonly streamingBehavior?: "steer" | "followUp";
}

interface PromptLeafRefusal {
	readonly message: string;
	readonly errorCode: typeof RPC_ERROR_INVALID_ARGUMENT | typeof RPC_ERROR_STALE_LEAF;
}

/**
 * senpi#6922: a prompt naming the leaf it was decided at is refused before admission when the session moved.
 * Lifecycle bookkeeping after that leaf is not a move (the same rule as the edit commands). A queued delivery runs
 * later, at a leaf this admission-time check never sees, so it cannot carry the guard; neither can a prompt a live hold
 * would keep as a notice, which a later turn consumes at another leaf.
 */
export function refusePromptAtMovedLeaf(
	session: AgentSession,
	command: PromptLeafGuard,
	heldAsNotice: boolean,
): PromptLeafRefusal | undefined {
	const { expectedLeafId } = command;
	if (expectedLeafId === undefined) return undefined;
	if (command.streamingBehavior !== undefined)
		return {
			message: "expectedLeafId cannot be combined with streamingBehavior: a queued prompt runs at a later leaf.",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	if (heldAsNotice)
		return {
			message:
				"expectedLeafId cannot be honoured while a Stop or run hold keeps input as a notice for a later turn.",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	try {
		assertExpectedLeaf(expectedLeafId, lifecycleEditLeaf(session.sessionManager, expectedLeafId));
		return undefined;
	} catch (err) {
		if (err instanceof AssistantEditError) return { message: err.message, errorCode: RPC_ERROR_STALE_LEAF };
		throw err;
	}
}
