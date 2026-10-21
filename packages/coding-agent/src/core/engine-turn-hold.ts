import { EngineTurnHoldNotices } from "./engine-turn-hold-notices.ts";
import type { CustomMessage } from "./messages.ts";
import type { HistoryReducer } from "./session-history-reduce.ts";
import type { SessionEntry } from "./session-manager.ts";

export type HoldKind = "unattended" | "session_hold" | "run_fence" | "inherited_hold";
export type HoldReleaseCause = "input" | "resume_session" | "run_resume" | "run_cancelled" | "node_cancelled";
export interface SessionHold {
	kind: HoldKind;
	key: string;
	since: string;
	data?: unknown;
	sourceCounts: Record<string, number>;
}
export type SessionHoldEvent =
	| { type: "session_paused"; pauseSeq: number; kind: HoldKind; at: string; noticeCount: number; persisted: boolean }
	| { type: "session_resumed"; pauseSeq: number; cause: HoldReleaseCause; at: string }
	| {
			type: "session_notice";
			noticeIds: string[];
			noticeCount: number;
			disposition: "notice_persisted" | "model_consumed";
	  };
type HoldEntry =
	| { op: "add"; kind: HoldKind; key: string; data?: unknown; pauseSeq: number; at: string }
	| { op: "release"; keys: string[]; observedSeq: number; cause: HoldReleaseCause; at: string };

/** Scan only ledger entries without materializing a compacted session's transcript. */
export const engineTurnHoldHistory: HistoryReducer<SessionEntry[]> = {
	initial: () => [],
	add: (entries, entry) => {
		if (
			entry.type === "custom" &&
			["session-hold", "session-notice", "session-notices-consumed"].includes(entry.customType)
		)
			entries.push(entry);
		return entries;
	},
};

export function engineWakeSource(customType: string): string {
	if (customType === "goal-continuation") return "goal";
	if (customType.startsWith("senpi-monitor:")) return "monitor";
	if (customType.startsWith("senpi-codemode:")) return "codemode";
	return customType;
}

/** One session-scoped hold ledger, independent of the transcript leaf. */
export class EngineTurnHold {
	private records = new Map<string, SessionHold>();
	private readonly notices: EngineTurnHoldNotices;
	private pauseSeq = 0;
	private released: SessionHold[] = [];
	private releaseBarrier = false;
	private goalDeferred = false;
	private generationValue = 0;
	private attended: boolean;
	private readonly append: (type: string, data: unknown) => void;
	private readonly notify: (message: string) => void;
	private readonly emit: (event: SessionHoldEvent) => void;

	constructor(
		entries: readonly SessionEntry[],
		unattended: boolean,
		append: (type: string, data: unknown) => void,
		notify: (message: string) => void,
		emit: (event: SessionHoldEvent) => void,
	) {
		this.attended = !unattended;
		this.append = append;
		this.notify = notify;
		this.emit = emit;
		this.notices = new EngineTurnHoldNotices(entries, append, (error) => this.writeFailed(error));
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "session-hold") continue;
			const data = entry.data as HoldEntry;
			if (data.op === "add") {
				this.pauseSeq = Math.max(this.pauseSeq, data.pauseSeq);
				this.records.set(data.key, {
					kind: data.kind,
					key: data.key,
					since: data.at,
					data: data.data,
					sourceCounts: {},
				});
			} else if (data.op === "release") {
				for (const key of data.keys) this.records.delete(key);
			}
		}
	}

	/** A run fence alone holds only wakes tagged with its run (senpi#3811), so it does not hold the session. */
	isHeld(): boolean {
		for (const hold of this.records.values()) if (hold.kind !== "run_fence") return true;
		return false;
	}

	get fences(): SessionHold[] {
		return [...this.records.values()].filter((hold) => hold.kind === "run_fence");
	}

	get held(): boolean {
		return this.isHeld();
	}

	get awaitingInput(): boolean {
		return this.isHeld() || this.releaseBarrier;
	}

	get generation(): number {
		return this.generationValue;
	}

	get releasing(): boolean {
		return this.releaseBarrier;
	}

	invalidate(): void {
		this.generationValue++;
	}

	attend(): void {
		this.attended = true;
	}

	get holds(): SessionHold[] {
		return [...this.records.values()].map((hold) => ({ ...hold, sourceCounts: this.sources }));
	}

	/** The seq of the newest hold added on this session; a hold's own seq is the value read right after it was added. */
	get currentPauseSeq(): number {
		return this.pauseSeq;
	}

	getHold(key: string): SessionHold | undefined {
		const hold = this.records.get(key);
		return hold ? { ...hold, sourceCounts: this.sources } : undefined;
	}

	get sources(): Record<string, number> {
		return this.notices.sources;
	}

	get noticeCount(): number {
		return this.notices.noticeCount;
	}

	start(): void {
		if (!this.attended) this.addHold("unattended");
		if (this.isHeld() && this.noticeCount > 0) this.showNotice();
	}

	addHold(kind: HoldKind, opts?: { key?: string; data?: unknown }): void {
		const key = opts?.key ?? kind;
		if (this.records.has(key)) return;
		const wasHeld = this.isHeld();
		const at = new Date().toISOString();
		this.pauseSeq++;
		this.records.set(key, { kind, key, since: at, data: opts?.data, sourceCounts: {} });
		let persisted = false;
		try {
			this.append("session-hold", {
				op: "add",
				kind,
				key,
				data: opts?.data,
				pauseSeq: this.pauseSeq,
				at,
			} satisfies HoldEntry);
			persisted = true;
		} catch (error) {
			this.writeFailed(error);
		} finally {
			if (!wasHeld)
				this.emit({
					type: "session_paused",
					pauseSeq: this.pauseSeq,
					kind,
					at,
					noticeCount: this.noticeCount,
					persisted,
				});
			if (!persisted) this.notify("Pause could not be saved; it will not survive a restart.");
		}
	}

	release(keys: string[], cause: HoldReleaseCause): void {
		const present = [...new Set(keys)].filter((key) => this.records.has(key));
		if (present.length === 0) return;
		const at = new Date().toISOString();
		this.append("session-hold", {
			op: "release",
			keys: present,
			observedSeq: this.pauseSeq,
			cause,
			at,
		} satisfies HoldEntry);
		for (const key of present) this.records.delete(key);
		if (!this.isHeld()) this.emit({ type: "session_resumed", pauseSeq: this.pauseSeq, cause, at });
	}

	holdsSource(source: string): boolean {
		return this.isHeld() || (!this.attended && this.releaseBarrier) || (source === "goal" && this.goalDeferred);
	}

	note(source: string, message?: CustomMessage): void {
		const noticeId = this.notices.note(source, this.pauseSeq, message, this.stopped);
		this.emit({
			type: "session_notice",
			noticeIds: [noticeId],
			noticeCount: this.noticeCount,
			disposition: "notice_persisted",
		});
		if (!this.attended) this.showNotice();
	}

	messages(): ReturnType<EngineTurnHoldNotices["messages"]> {
		return this.notices.messages();
	}

	releaseAll(cause: HoldReleaseCause): Record<string, number> {
		const sources = this.sources;
		if (this.releaseBarrier || !this.isHeld()) return {};
		this.generationValue++;
		if (this.isHeld()) this.released = this.holds;
		this.releaseBarrier = true;
		this.goalDeferred = (sources.goal ?? 0) > 0;
		// Neither human input nor resume_session releases a run-owned hold: only the parent's run Resume does (senpi#3811).
		const keys = [...this.records.values()].filter((hold) => hold.kind !== "inherited_hold");
		this.release(
			keys.map((hold) => hold.key),
			cause,
		);
		return sources;
	}

	/** Undo a release whose input never reached admission: lower the barrier and keep every held wake held. */
	abandonRelease(): void {
		this.releaseBarrier = false;
		this.goalDeferred = false;
		for (const { kind, key, data } of this.released) this.addHold(kind, { key, data });
		this.released = [];
	}

	rejectInput(): void {
		this.releaseBarrier = false;
		this.goalDeferred = false;
		if (!this.attended) for (const { kind, key, data } of this.released) this.addHold(kind, { key, data });
	}

	consume(source: string, deliveredIds?: readonly string[]): boolean {
		const noticeIds = this.notices.consume(source, this.pauseSeq, deliveredIds);
		if (noticeIds.length === 0) return false;
		this.emit({ type: "session_notice", noticeIds, noticeCount: this.noticeCount, disposition: "model_consumed" });
		return true;
	}

	finish(): Record<string, number> {
		const sources = this.sources;
		this.notices.consumeNotices(this.pauseSeq);
		// Wakes arriving after the delivery snapshot still belong to the ledger.
		// Re-arm the hold rather than draining an unbounded stream in this release.
		if (this.messages().length > 0) {
			this.rejectInput();
			return sources;
		}
		this.consume("goal");
		this.goalDeferred = false;
		this.releaseBarrier = false;
		this.released = [];
		return sources;
	}

	private get stopped(): boolean {
		return [...this.records.values()].some((hold) => hold.kind === "session_hold");
	}

	private showNotice(): void {
		this.notify(this.notices.noticeText(this.noticeCount, undefined, this.stopped));
	}

	private writeFailed(error: unknown): void {
		console.warn("session_hold_write_failed", error instanceof Error ? error.message : String(error));
	}
}
