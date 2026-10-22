import type { CustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

/** `items` holds each itemized notice's own payload by notice id; no later wake replaces one (senpi#3811). */
type HeldWake = { noticeIds: string[]; message?: CustomMessage; items: Map<string, CustomMessage> };
interface HeldNotice {
	noticeId: string;
	producer: string;
	pauseSeq: number;
	at: string;
	heldCount: number;
	text: string;
	action: "resume_session";
	message?: CustomMessage;
	itemId?: string;
	runRef?: unknown;
}
/** One `session-notice` entry holding every item of an itemized batch, so the batch is written or not at all. */
type HeldNoticeBatch = { notices: HeldNotice[] };
export type HeldItem = {
	readonly source: string;
	readonly message: CustomMessage;
	readonly item: { readonly itemId: string; readonly runRef?: unknown };
};

/**
 * Durable notice custody. A plain wake keeps only the latest model payload of its source; an itemized notice keeps
 * its own payload and is delivered on its own.
 */
export class EngineTurnHoldNotices {
	private wakes: Record<string, HeldWake> = Object.create(null);
	private readonly append: (type: string, data: unknown) => unknown;
	private readonly warn: (error: unknown) => void;

	constructor(
		entries: readonly SessionEntry[],
		append: (type: string, data: unknown) => unknown,
		warn: (error: unknown) => void,
	) {
		this.append = append;
		this.warn = warn;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "session-notice") {
				const data = entry.data as HeldNotice | HeldNoticeBatch;
				for (const notice of "notices" in data ? data.notices : [data]) this.remember(notice);
			} else if (entry.customType === "session-notices-consumed") {
				const ids = new Set((entry.data as { noticeIds: string[] }).noticeIds);
				for (const [source, wake] of Object.entries(this.wakes)) this.forget(source, wake, ids);
			}
		}
	}

	get sources(): Record<string, number> {
		return Object.fromEntries(Object.entries(this.wakes).map(([source, wake]) => [source, wake.noticeIds.length]));
	}

	get noticeCount(): number {
		return Object.values(this.sources).reduce((sum, count) => sum + count, 0);
	}

	noticeText(count = this.noticeCount, source?: string, stopped = false): string {
		if (stopped)
			return `Paused: ${count} ${count === 1 ? "update" : "updates"} arrived while paused. Send a message or /resume to continue.`;
		const sources = [...new Set([...Object.keys(this.wakes), ...(source ? [source] : [])])];
		const labels = sources.map((key) => (["goal", "monitor", "codemode"].includes(key) ? key : `other (${key})`));
		return `Paused while no one was here (${labels.join(", ") || "other"}): ${count} automatic wakes held. Resume or send a message to continue.`;
	}

	note(source: string, pauseSeq: number, message?: CustomMessage, stopped = false): string {
		const data: HeldNotice = {
			noticeId: crypto.randomUUID(),
			producer: source,
			pauseSeq,
			at: new Date().toISOString(),
			heldCount: this.noticeCount + 1,
			text: this.noticeText(this.noticeCount + 1, source, stopped),
			action: "resume_session",
			...(source !== "goal" && message ? { message } : {}),
		};
		try {
			this.append("session-notice", data);
		} catch (error) {
			this.warn(error);
		} finally {
			this.remember(data);
		}
		return data.noticeId;
	}

	/**
	 * Store every item of an itemized batch as its own notice, in ONE entry (senpi#3811 design 4.5): the batch is
	 * admitted all-or-nothing. Unlike `note`, a write that fails throws and keeps no item, so the sender keeps the
	 * whole batch and a retry duplicates nothing.
	 */
	noteItems(
		pauseSeq: number,
		items: readonly HeldItem[],
		stopped = false,
	): Array<{ itemId: string; noticeId: string; entryId: string }> {
		const at = new Date().toISOString();
		const held = items.map(({ source, message, item }, index) => {
			const heldCount = this.noticeCount + index + 1;
			const notice: HeldNotice = {
				noticeId: crypto.randomUUID(),
				producer: source,
				pauseSeq,
				at,
				heldCount,
				text: this.noticeText(heldCount, source, stopped),
				action: "resume_session",
				message,
				itemId: item.itemId,
				...(item.runRef === undefined ? {} : { runRef: item.runRef }),
			};
			return { itemId: item.itemId, notice };
		});
		const batch: HeldNoticeBatch = { notices: held.map(({ notice }) => notice) };
		const entryId = this.append("session-notice", batch);
		if (typeof entryId !== "string") throw new Error("the notice entry was not written");
		for (const { notice } of held) this.remember(notice);
		return held.map(({ itemId, notice }) => ({ itemId, noticeId: notice.noticeId, entryId }));
	}

	messages(): Array<{ source: string; noticeIds: readonly string[]; message: CustomMessage }> {
		return Object.entries(this.wakes).flatMap(([source, wake]) => {
			const items = [...wake.items].map(([noticeId, message]) => ({ source, noticeIds: [noticeId], message }));
			const noticeIds = wake.noticeIds.filter((id) => !wake.items.has(id));
			if (source === "goal" || !wake.message || noticeIds.length === 0) return items;
			const message = wake.message;
			if (source !== "monitor") return [{ source, noticeIds, message }, ...items];
			const prefix = `${noticeIds.length} automatic monitor wakes held. Latest event:\n`;
			const content =
				typeof message.content === "string"
					? prefix + message.content
					: [{ type: "text" as const, text: prefix }, ...message.content];
			return [{ source, noticeIds, message: { ...message, content } }, ...items];
		});
	}

	/** The single held -> released transition. Append before removal; failure retains custody. Returns the consumed ids. */
	consume(source: string, pauseSeq: number, deliveredIds?: readonly string[]): string[] {
		const wake = this.wakes[source];
		if (!wake) return [];
		const delivered = new Set(deliveredIds ?? wake.noticeIds);
		const noticeIds = wake.noticeIds.filter((id) => delivered.has(id));
		if (noticeIds.length === 0) return [];
		this.append("session-notices-consumed", { noticeIds, pauseSeq });
		this.forget(source, wake, new Set(noticeIds));
		return noticeIds;
	}

	/** Settle the notices no turn delivers: plain wakes of a source that kept no payload. */
	consumeNotices(pauseSeq: number): void {
		for (const [source, wake] of Object.entries(this.wakes)) {
			if (wake.message) continue;
			const plain = wake.noticeIds.filter((id) => !wake.items.has(id));
			if (plain.length > 0) this.consume(source, pauseSeq, plain);
		}
	}

	private remember(notice: HeldNotice): void {
		const wake = this.wakes[notice.producer] ?? { noticeIds: [], items: new Map() };
		wake.noticeIds.push(notice.noticeId);
		if (notice.itemId !== undefined && notice.message) wake.items.set(notice.noticeId, notice.message);
		else if (notice.message) wake.message = notice.message;
		this.wakes[notice.producer] = wake;
	}

	private forget(source: string, wake: HeldWake, ids: ReadonlySet<string>): void {
		wake.noticeIds = wake.noticeIds.filter((id) => !ids.has(id));
		for (const id of ids) wake.items.delete(id);
		if (!wake.noticeIds.some((id) => !wake.items.has(id))) delete wake.message;
		if (wake.noticeIds.length === 0) delete this.wakes[source];
	}
}
