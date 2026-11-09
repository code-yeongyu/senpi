import type { TranscriptFlow } from "../../core/session-transcript-journal.ts";
import type { CompactColdFlow } from "./compact-cold-flows.ts";

type MessagesOf = (entryIds: readonly string[]) => Promise<readonly (string | undefined)[]>;

/**
 * A committed transcript flow in compact message ids (S03b-3b): each entry maps to the message it joined in this
 * epoch. An entry no message of this epoch joined (the loaded base, an unowned append) was never a compact message.
 */
export async function compactColdFlow(
	flow: TranscriptFlow,
	messagesOf: MessagesOf,
): Promise<CompactColdFlow | undefined> {
	const known = async (entryIds: readonly string[]) =>
		(await messagesOf(entryIds)).filter((messageId) => messageId !== undefined);
	switch (flow.kind) {
		case "edit":
		case "context_edit_removal": {
			const [messageId] = await messagesOf([flow.targetId]);
			if (messageId === undefined) return undefined;
			return flow.kind === "edit"
				? { type: "edit", messageId, message: flow.message }
				: { type: "context_edit_removal", messageId };
		}
		case "compaction":
			return { type: "compaction", removed: await known(flow.removedIds) };
		case "branch": {
			const installedIds = await messagesOf(flow.installed.map((entry) => entry.id));
			const installed = flow.installed.flatMap(({ message }, index) => {
				const messageId = installedIds[index];
				return messageId === undefined ? [] : [{ messageId, message, persistence: "appended" as const }];
			});
			return { type: "branch", removed: await known(flow.removedIds), installed };
		}
	}
}
