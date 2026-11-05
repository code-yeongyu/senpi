import type { CustomMessage } from "./messages.ts";
import { normalizeWaitItems, type WaitSourceItems } from "./lifecycle-wait-items.ts";
import type { ObligationKind } from "./session-lifecycle-types.ts";

export interface CustodyPayload {
	readonly message: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	readonly deliverAs?: "steer" | "followUp" | "nextTurn";
	/** The item ids of the itemized batch this payload carries, so a restored carrier still knows them (senpi#4106). */
	readonly itemIds?: readonly string[];
}

/** Mutable only by the registry; every replacement is appended before installation. */
export interface WorkCustodyRecord extends WaitSourceItems {
	readonly id: string;
	readonly key: string;
	readonly kind: ObligationKind;
	readonly state: "open" | "queued" | "consumed" | "settled" | "held" | "cancelled" | "passive";
	readonly source?: string;
	readonly activeCount?: number;
	readonly detail?: string;
	readonly ticketId?: string;
	readonly payload?: CustodyPayload;
	readonly runId?: string;
	readonly transcriptEntryId?: string;
	readonly noticeId?: string;
	readonly delivery?: "failed" | "retired";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse owned JSONL data once, at restoration; unknown future records fail closed. */
export function readWorkCustody(value: unknown): WorkCustodyRecord | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.key !== "string") return undefined;
	if (value.kind !== "children" && value.kind !== "background") return undefined;
	switch (value.state) {
		case "open":
		case "queued":
		case "consumed":
		case "settled":
		case "held":
		case "cancelled":
		case "passive":
			break;
		default:
			return undefined;
	}
	const payload = readPayload(value.payload);
	return {
		id: value.id,
		key: value.key,
		kind: value.kind,
		state: value.state,
		...normalizeWaitItems(value.items, value.omittedItems),
		...(typeof value.source === "string" ? { source: value.source } : {}),
		...(typeof value.activeCount === "number" ? { activeCount: value.activeCount } : {}),
		...(typeof value.detail === "string" ? { detail: value.detail } : {}),
		...(typeof value.ticketId === "string" ? { ticketId: value.ticketId } : {}),
		...(payload ? { payload } : {}),
		...(typeof value.runId === "string" ? { runId: value.runId } : {}),
		...(typeof value.transcriptEntryId === "string" ? { transcriptEntryId: value.transcriptEntryId } : {}),
		...(typeof value.noticeId === "string" ? { noticeId: value.noticeId } : {}),
		...(value.delivery === "failed" || value.delivery === "retired" ? { delivery: value.delivery } : {}),
	};
}

function readPayload(value: unknown): CustodyPayload | undefined {
	if (!isRecord(value) || !isRecord(value.message)) return undefined;
	const message = value.message;
	if (typeof message.customType !== "string" || typeof message.display !== "boolean") return undefined;
	// Queued delivery accepts the same text/content boundary as CustomMessage.
	if (!isMessageContent(message.content)) return undefined;
	return {
		message: {
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
		},
		...(value.deliverAs === "steer" || value.deliverAs === "followUp" || value.deliverAs === "nextTurn"
			? { deliverAs: value.deliverAs }
			: {}),
		...(Array.isArray(value.itemIds) && value.itemIds.every((id) => typeof id === "string")
			? { itemIds: value.itemIds }
			: {}),
	};
}

function isMessageContent(value: unknown): value is CustomMessage["content"] {
	return (
		typeof value === "string" ||
		(Array.isArray(value) &&
			value.every(
				(part: unknown) =>
					isRecord(part) &&
					((part.type === "text" && typeof part.text === "string") ||
						(part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")),
			))
	);
}

export function custodyIsOpen(record: WorkCustodyRecord): boolean {
	switch (record.state) {
		case "open":
		case "queued":
		case "consumed":
			return true;
		case "settled":
		case "held":
		case "cancelled":
		case "passive":
			return false;
		default:
			return record.state satisfies never;
	}
}
