import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextEditEntry, ProjectedSessionEntry } from "./session-manager.ts";
import type { TranscriptFlow } from "./session-transcript-journal.ts";

type Context = readonly ProjectedSessionEntry[];

const ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

/** Only the roles compact state holds; owned JSON, since the manager's entry objects change later. */
export function ownedFlowMessage(message: AgentMessage | undefined): AgentMessage | undefined {
	return message && ROLES.has(message.role) ? JSON.parse(JSON.stringify(message)) : undefined;
}

/** The message an entry contributes to the model context, when it is a message entry compact state holds. */
function contextMessage({ sourceEntry, messages }: ProjectedSessionEntry): AgentMessage | undefined {
	const message = messages[0];
	const isMessage = sourceEntry.type === "message" || sourceEntry.type === "custom_message";
	return isMessage && message && ROLES.has(message.role) ? message : undefined;
}

function left(from: Context, to: Context): string[] {
	const kept = new Set(to.map((entry) => entry.sourceEntry.id));
	return from
		.filter((entry) => !kept.has(entry.sourceEntry.id) && contextMessage(entry))
		.map((entry) => entry.sourceEntry.id);
}

/** A compaction removes every message it took out of the model context. */
export function compactionFlow(from: Context, to: Context): TranscriptFlow {
	return { kind: "compaction", removedIds: left(from, to) };
}

/** A leaf move: the messages that left the model context, then the ones that joined it, in context order. */
export function branchFlow(from: Context, to: Context): TranscriptFlow {
	const before = new Set(from.map((entry) => entry.sourceEntry.id));
	return {
		kind: "branch",
		removedIds: left(from, to),
		installed: to.flatMap((entry) => {
			const message = before.has(entry.sourceEntry.id) ? undefined : ownedFlowMessage(contextMessage(entry));
			return message ? [{ id: entry.sourceEntry.id, message }] : [];
		}),
	};
}

/** A context edit replaces its target's message, or with no replacement removes it from the conversation. */
export function contextEditFlow(edit: ContextEditEntry, edited: AgentMessage | undefined): TranscriptFlow | undefined {
	if (edit.replacement === null) return { kind: "context_edit_removal", targetId: edit.targetId };
	return edited ? { kind: "edit", targetId: edit.targetId, message: edited } : undefined;
}
