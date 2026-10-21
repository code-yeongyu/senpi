import type { CustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

type HeldWake = { noticeIds: string[]; message?: CustomMessage };
interface HeldNotice {
	noticeId: string;
	producer: string;
	pauseSeq: number;
	at: string;
	heldCount: number;
	text: string;
	action: "resume_session";
	message?: CustomMessage;
}

/** Durable notice custody, retaining only the latest model payload for each source. */
export class EngineTurnHoldNotices {
	private wakes: Record<string, HeldWake> = Object.create(null);
	private readonly append: (type: string, data: unknown) => void;
	private readonly warn: (error: unknown) => void;

	constructor(
		entries: readonly SessionEntry[],
		append: (type: string, data: unknown) => void,
		warn: (error: unknown) => void,
	) {
		this.append = append;
		this.warn = warn;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "session-notice") {
				this.remember(entry.data as HeldNotice);
			} else if (entry.customType === "session-notices-consumed") {
				const ids = new Set((entry.data as { noticeIds: string[] }).noticeIds);
				for (const [source, wake] of Object.entries(this.wakes)) {
					wake.noticeIds = wake.noticeIds.filter((id) => !ids.has(id));
					if (wake.noticeIds.length === 0) delete this.wakes[source];
				}
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

	messages(): Array<{ source: string; noticeIds: readonly string[]; message: CustomMessage }> {
		return Object.entries(this.wakes).flatMap(([source, wake]) => {
			if (source === "goal" || !wake.message) return [];
			const message = wake.message;
			const noticeIds = [...wake.noticeIds];
			if (source !== "monitor") return [{ source, noticeIds, message }];
			const prefix = `${wake.noticeIds.length} automatic monitor wakes held. Latest event:\n`;
			return [
				{
					source,
					noticeIds,
					message: {
						...message,
						content:
							typeof message.content === "string"
								? prefix + message.content
								: [{ type: "text" as const, text: prefix }, ...message.content],
					},
				},
			];
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
		wake.noticeIds = wake.noticeIds.filter((id) => !delivered.has(id));
		if (wake.noticeIds.length === 0) delete this.wakes[source];
		return noticeIds;
	}

	consumeNotices(pauseSeq: number): void {
		for (const [source, wake] of Object.entries(this.wakes)) {
			if (!wake.message) this.consume(source, pauseSeq);
		}
	}

	private remember(notice: HeldNotice): void {
		const wake = this.wakes[notice.producer] ?? { noticeIds: [] };
		wake.noticeIds.push(notice.noticeId);
		if (notice.message) wake.message = notice.message;
		this.wakes[notice.producer] = wake;
	}
}
