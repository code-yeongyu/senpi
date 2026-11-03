import type { SendMessageItem, SendMessageReceipt } from "./extensions/types.ts";
import type { CustomMessage } from "./messages.ts";

type BatchMessage = Pick<CustomMessage, "customType" | "content" | "display" | "details">;

/**
 * How one admitted itemized batch reports back from the delivery path (senpi#3811 design 4.5): the entry its
 * message was written to, a write that failed, or an abort that dropped it before admission so it is decided again.
 */
export interface ItemizedAdmission {
	readonly persisted: (entryId: string) => void;
	readonly failed: (error: unknown) => void;
	readonly droppedByAbort: () => void;
	/** The batch's item ids, so a re-send of a queued ticket can be checked against what will be written (senpi#4106). */
	readonly itemIds?: readonly string[];
}

/** What waits on a queued itemized message: the entry it is written to, or the write's failure. */
export type PersistWatcher = Pick<ItemizedAdmission, "persisted" | "failed" | "itemIds">;

/** A queued itemized message that `clearQueue` removed before it was written: none of its items were delivered. */
export class QueuedDeliveryCleared extends Error {
	readonly itemIds: readonly string[];
	constructor(itemIds: readonly string[] = []) {
		super("The queued message was cleared before it was written");
		this.name = "QueuedDeliveryCleared";
		this.itemIds = itemIds;
	}
}

/** The notice an item is stored as when its batch is held: its own payload and details, never the whole batch's. */
export function itemNoticeMessage(message: BatchMessage, item: SendMessageItem): CustomMessage {
	return {
		role: "custom",
		customType: message.customType,
		content: item.content ?? message.content ?? [],
		display: message.display,
		...(item.details === undefined ? {} : { details: item.details }),
		timestamp: Date.now(),
	};
}

/** One `message_persisted` receipt per item: the batch was delivered as the one message in `entryId`. */
export function deliveredReceipts(items: readonly SendMessageItem[], entryId: string): SendMessageReceipt[] {
	return items.map((item) => ({ itemId: item.itemId, entryId, disposition: "message_persisted" }));
}
