import type { PendingInputProjection } from "../../../core/pending-input-projection.ts";

export interface QueuedLine {
	readonly text: string;
	readonly mode: "steer" | "followUp";
	readonly clientMessageId?: string;
}

/**
 * The TUI's pending-queue lines (senpi#3549): one per queued input in queue order, labelled by its engine
 * projection's status when the input is in durable custody, plus every input the engine reports failed (those
 * have left the queue but still need the user). Status text comes from the projection, never from the TUI.
 */
export function pendingInputLines(
	queued: readonly QueuedLine[],
	projections: ReadonlyMap<string, PendingInputProjection>,
): string[] {
	const lines = queued.map((input) => {
		const label = input.mode === "steer" ? "Steering" : "Follow-up";
		const projection = input.clientMessageId === undefined ? undefined : projections.get(input.clientMessageId);
		const status = projection === undefined || projection.statusText === "" ? "" : ` (${projection.statusText})`;
		return `${label}: ${input.text}${status}`;
	});
	const queuedIds = new Set(
		queued.flatMap((input) => (input.clientMessageId === undefined ? [] : [input.clientMessageId])),
	);
	for (const projection of projections.values()) {
		if (projection.state !== "failed" || queuedIds.has(projection.clientMessageId)) continue;
		lines.push(`${projection.statusText}: ${projection.text}`);
	}
	return lines;
}

export function applyPendingInputChanges(
	projections: Map<string, PendingInputProjection>,
	changes: readonly PendingInputProjection[],
): void {
	for (const change of changes) {
		if (change.state === "delivered" || change.state === "removed") projections.delete(change.clientMessageId);
		else projections.set(change.clientMessageId, change);
	}
}
