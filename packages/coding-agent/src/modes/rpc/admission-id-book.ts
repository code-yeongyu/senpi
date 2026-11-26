/**
 * One admission id space per session (senpi#7479): a prompt's `clientMessageId` and a delivery's `deliveryId` are the
 * same id `X`, whichever command carries it and whichever connection it arrives on. The book is keyed by the session
 * and the raw `X`; the device a delivery came from stays recorded on its entry and is no longer part of the key. Class
 * separation (an owner's id against a connector's) is the sender's: it derives distinct ids, and the engine does not
 * assert a class of its own.
 *
 * The second arrival of `X` with the same message is a duplicate, answered as the first admission in the asking
 * command's vocabulary; a different message under `X` is the typed conflict. "The same message" is its text plus its
 * images, compared by digest. A duplicate or a conflict answers the outcome and the id only: never the first message,
 * its sender or the device it came from.
 *
 * Prompts are remembered for the life of the session file through their admission records. A written delivery is
 * remembered through its transcript entry; one still pending in this process through the entry the RPC layer keeps
 * here until it is written.
 */
import { createHash } from "node:crypto";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	isSessionControlDeliveryDetails,
	SESSION_CONTROL_DELIVERY_TYPE,
} from "../../core/extensions/session-control-types.ts";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";

type DigestImage = { readonly type: string; readonly data: string; readonly mimeType: string };

/** The digest two admissions under one id are compared by: the message text and its images. */
export function messageDigest(text: string, images?: readonly DigestImage[]): string {
	const payload = { text, images: images?.map(({ type, data, mimeType }) => ({ type, data, mimeType })) ?? [] };
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface DeliveryAdmission {
	readonly digest: string;
	readonly disposition: "started" | "queued";
	readonly turnId?: string;
}

/** The raw id a delivery's ledger key carries: `rpc:local/X` and `device:<id>/X` are both `X`; any other key is itself. */
export function rawDeliveryId(ledgerId: string): string {
	if (ledgerId.startsWith("rpc:local/")) return ledgerId.slice("rpc:local/".length);
	const device = /^device:[^/]*\//.exec(ledgerId);
	return device === null ? ledgerId : ledgerId.slice(device[0].length);
}

/** Every delivery the transcript holds, by raw id: what answers for the in-process book after a restart. */
const writtenDeliveries: HistoryReducer<Map<string, DeliveryAdmission>> = {
	initial: () => new Map(),
	add: (book, entry) => {
		if (
			entry.type === "custom_message" &&
			entry.customType === SESSION_CONTROL_DELIVERY_TYPE &&
			isSessionControlDeliveryDetails(entry.details) &&
			typeof entry.content === "string"
		) {
			const id = rawDeliveryId(entry.details.delivery_id);
			if (!book.has(id)) book.set(id, { digest: messageDigest(entry.content), disposition: "started" });
		}
		return book;
	},
};

type BookSession = Pick<AgentSession, "sessionManager">;

/** Deliveries admitted in this process and not necessarily written yet, per session object and durable session id. */
const admittedHere = new WeakMap<object, { durableSessionId: string; deliveries: Map<string, DeliveryAdmission> }>();

function hereFor(session: BookSession): Map<string, DeliveryAdmission> {
	const durableSessionId = session.sessionManager.getSessionId();
	const current = admittedHere.get(session);
	if (current?.durableSessionId === durableSessionId) return current.deliveries;
	const deliveries = new Map<string, DeliveryAdmission>();
	admittedHere.set(session, { durableSessionId, deliveries });
	return deliveries;
}

export function deliveryUnder(session: BookSession, id: string): DeliveryAdmission | undefined {
	return hereFor(session).get(id) ?? session.sessionManager.reduceHistory(writtenDeliveries).get(id);
}

export function noteDeliveryAdmitted(session: BookSession, id: string, admission: DeliveryAdmission): void {
	const here = hereFor(session);
	if (!here.has(id)) here.set(id, admission);
}
