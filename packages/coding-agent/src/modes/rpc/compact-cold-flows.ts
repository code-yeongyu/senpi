import type { CompactColdOperation } from "./compact-cold-operations.ts";
import type { SeededMessage } from "./compact-seeded-messages.ts";
import type { CompactPersistence } from "./compact-transition.ts";

/**
 * The four RULING-33 condition-2 flows that target settled messages. Each maps to ordered cold operations run after
 * acceptance, one typed outcome per operation; a live target answers `active_message` and stays the lane's
 * synchronous acceptance work (a live user delete is the accepted `message_remove` transition).
 */
export type CompactColdFlow =
	| { readonly type: "edit"; readonly messageId: string; readonly message: SeededMessage }
	| { readonly type: "user_delete"; readonly messageId: string }
	| { readonly type: "compaction"; readonly removed: readonly string[] }
	| {
			readonly type: "branch";
			readonly removed: readonly string[];
			readonly installed: readonly {
				readonly messageId: string;
				readonly message: SeededMessage;
				readonly persistence: CompactPersistence;
			}[];
	  };

export function coldFlowOperations(flow: CompactColdFlow): readonly CompactColdOperation[] {
	const remove = (messageId: string) => ({ type: "message_remove", messageId }) as const;
	switch (flow.type) {
		case "edit":
			return [{ type: "message_replace", messageId: flow.messageId, message: flow.message }];
		case "user_delete":
			return [remove(flow.messageId)];
		case "compaction":
			return flow.removed.map(remove);
		case "branch":
			return [
				...flow.removed.map(remove),
				...flow.installed.map((entry) => ({ type: "message_install", ...entry }) as const),
			];
	}
}
