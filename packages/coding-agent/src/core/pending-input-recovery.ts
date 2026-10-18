/**
 * Reopen recovery and attachment lifetime for pending inputs (senpi#3549 P2c). The store is the single source on
 * reopen: every still-queued input re-enters the native queue from its record, in submit order, with its images
 * read back from the attachment store. A missing image does not drop the input; its text is requeued and the
 * caller is told how many attachments were lost, so it can say so.
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { PendingInputAttachments } from "./pending-input-attachments.ts";
import type { PendingInputProjection } from "./pending-input-projection.ts";
import type { PendingInputStore } from "./pending-input-store.ts";
import type { PendingInputMode } from "./pending-input-types.ts";

export interface RecoveredInput {
	readonly clientMessageId: string;
	readonly queuedId: string;
	readonly text: string;
	readonly images: readonly ImageContent[];
	readonly mode: PendingInputMode;
	readonly enqueueOrder?: number;
	readonly missingAttachments: number;
}

/** Requeues every queued input once and returns their ids, so a later ledger restore can skip them. */
export function recoverQueuedInputs(
	store: PendingInputStore,
	attachments: PendingInputAttachments,
	requeue: (input: RecoveredInput) => void,
): Set<string> {
	const recovered = new Set<string>();
	for (const input of store.inputsInSubmitOrder()) {
		if (input.phase !== "queued") continue;
		const { images, missing } = attachments.load(input.attachments);
		requeue({
			clientMessageId: input.clientMessageId,
			queuedId: input.handle.queuedId,
			text: input.text,
			images,
			mode: input.requestedMode,
			...(input.enqueueOrder === undefined ? {} : { enqueueOrder: input.enqueueOrder }),
			missingAttachments: missing.length,
		});
		recovered.add(input.clientMessageId);
	}
	return recovered;
}

export function pruneSettledAttachments(
	store: PendingInputStore,
	attachments: PendingInputAttachments,
	projections: readonly PendingInputProjection[],
): void {
	if (!projections.some((projection) => projection.state === "delivered" || projection.state === "removed")) return;
	const referenced = new Set<string>();
	for (const input of store.inputsInSubmitOrder()) {
		if (input.phase === "delivered" || input.phase === "removed") continue;
		for (const attachment of input.attachments) referenced.add(attachment);
	}
	attachments.prune(referenced);
}
