import type { DeliveryTicketId, ObligationKind, ObligationToken, WorkObligations } from "./session-lifecycle-types.ts";
import { normalizeWaitItems, waitItemSignature } from "./lifecycle-wait-items.ts";
import type { SessionEntry } from "./session-manager.ts";
import {
	closedCustody,
	type CustodyPayload,
	custodyIsOpen,
	readWorkCustody,
	type WorkCustodyRecord,
} from "./work-custody-record.ts";

/** Custody keys the engine opens itself (senpi#3986): queued deliveries and published wake sources. */
export const ENGINE_DELIVERY_KEY_PREFIX = "delivery:";
export const WAKE_SOURCE_KEY_PREFIX = "wake-source:";
export const ENGINE_CUSTODY_KEY_PREFIXES = [ENGINE_DELIVERY_KEY_PREFIX, WAKE_SOURCE_KEY_PREFIX] as const;

/** Why a delivery ticket may not take a new delivery now (senpi#3864); "admitted" when it may. */
export type TicketAdmission = "admitted" | "unknown" | "closed" | "consumed" | "delivering";

/** Why a send's ticket was refused: its admission, or a re-send whose items differ from the queued message's. */
export type DeliveryTicketRefusal = Exclude<TicketAdmission, "admitted"> | "different_items";

/** A send whose delivery ticket was refused before anything was written. */
export class DeliveryTicketRefused extends Error {
	readonly ticketId: string;
	readonly reason: DeliveryTicketRefusal;
	constructor(ticketId: string, reason: DeliveryTicketRefusal) {
		super(`Delivery ticket ${ticketId} was refused: ${reason}`);
		this.name = "DeliveryTicketRefused";
		this.ticketId = ticketId;
		this.reason = reason;
	}
}

export class CustodyViolation extends Error {
	readonly key: string;
	constructor(key: string) {
		super(`Work custody is no longer owned: ${key}`);
		this.name = "CustodyViolation";
		this.key = key;
	}
}

export interface CustodyStore {
	append(record: WorkCustodyRecord): void;
	changed(): void;
}

/** One session's durable registry. A token never acknowledges its own delivery. */
export class SessionWorkObligations implements WorkObligations {
	/** Open records by id, in the order their first record was written. A closed record leaves it (senpi#7603). */
	private readonly openRecords = new Map<string, WorkCustodyRecord>();
	/** The id of the open record holding each ticket. */
	private readonly openTickets = new Map<DeliveryTicketId, string>();
	/** Tickets whose custody closed: all that admission and the ticket transitions read of a closed record. */
	private readonly closedTickets = new Set<DeliveryTicketId>();
	private readonly unpersisted = new Map<string, WorkCustodyRecord>();
	private readonly delivering = new Set<DeliveryTicketId>();
	/** Engine delivery custody a send opened in this process and has not queued yet (senpi#6810). */
	private readonly sending = new Set<string>();
	private readonly publishedSources = new Set<string>();
	private readonly store: CustodyStore;
	/** `entries` is read here only: the restoration history is not kept for the session's life (senpi#7603). */
	constructor(store: CustodyStore, entries: readonly SessionEntry[]) {
		this.store = store;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
			const record = readWorkCustody(entry.data);
			if (record) this.keep(record);
		}
	}

	get active(): readonly WorkCustodyRecord[] {
		return [...this.openRecords.values()];
	}

	get activeCount(): number {
		return this.active.reduce((sum, record) => sum + (record.activeCount ?? 1), 0);
	}

	get persisted(): boolean {
		return this.unpersisted.size === 0;
	}

	open(key: string, kind: ObligationKind, detail?: string): ObligationToken {
		const existing = this.active.find((record) => record.key === key);
		if (existing) return this.token(existing);
		const record: WorkCustodyRecord = {
			id: crypto.randomUUID(),
			key,
			kind,
			state: "open",
			...(detail === undefined ? {} : { detail }),
		};
		if (key.startsWith(ENGINE_DELIVERY_KEY_PREFIX)) this.sending.add(record.id);
		this.install(record);
		this.store.changed();
		return this.token(record);
	}

	/**
	 * An engine delivery's own custody while its send is in flight (senpi#6810): the session is starting or joining a
	 * turn for that delivery, so this custody is never background work the session waits on.
	 */
	isDeliveryInFlight(record: WorkCustodyRecord): boolean {
		if (!record.key.startsWith(ENGINE_DELIVERY_KEY_PREFIX)) return false;
		return this.sending.has(record.id) || (record.ticketId !== undefined && this.delivering.has(record.ticketId));
	}

	/**
	 * An engine delivery's own custody that the given run consumed: that run's own work until `settleRun`, so never a
	 * background wait, even after its delivery ended (senpi#6814 review).
	 */
	isConsumedBy(record: WorkCustodyRecord, runId: string | undefined): boolean {
		if (runId === undefined || !record.key.startsWith(ENGINE_DELIVERY_KEY_PREFIX)) return false;
		return record.state === "consumed" && record.runId === runId;
	}

	syncSource(source: string, kind: ObligationKind, activeCount: number, items?: unknown): void {
		const key = `${WAKE_SOURCE_KEY_PREFIX}${source}`;
		this.publishedSources.add(key);
		const current = this.active.find((record) => record.key === key);
		if (activeCount <= 0) {
			if (current) this.close(current, "passive");
			return;
		}
		const detail = normalizeWaitItems(items);
		if (
			current?.activeCount === activeCount &&
			current.kind === kind &&
			waitItemSignature(current) === waitItemSignature(detail)
		)
			return;
		this.install({
			...current,
			id: current?.id ?? crypto.randomUUID(),
			key,
			source,
			kind,
			activeCount,
			items: detail.items,
			omittedItems: detail.omittedItems,
			state: current?.state ?? "open",
		});
		this.store.changed();
	}

	/** After a restart, a restored wake source stays open only if its producer published again. */
	retireRestoredSources(): void {
		for (const record of this.active) {
			if (record.key.startsWith(WAKE_SOURCE_KEY_PREFIX) && !this.publishedSources.has(record.key))
				this.close(record, "passive");
		}
	}

	/**
	 * The single ticket admission check every send branch runs before it writes anything (held notices, a queued
	 * message, a delivery): an unknown, closed, consumed or in-delivery ticket takes no new delivery.
	 */
	admission(ticketId: DeliveryTicketId): TicketAdmission {
		const record = this.openTicket(ticketId);
		if (!record) return this.closedTickets.has(ticketId) ? "closed" : "unknown";
		if (record.state === "consumed") return "consumed";
		return this.delivering.has(ticketId) ? "delivering" : "admitted";
	}

	queue(ticketId: DeliveryTicketId, payload: CustodyPayload): boolean {
		const admission = this.admission(ticketId);
		if (admission === "unknown") throw new CustodyViolation(ticketId);
		const record = this.openTicket(ticketId);
		if (admission !== "admitted" || !record) return false;
		// A restored queued ticket is re-sent plain; it keeps the item ids its batch was recorded with (senpi#4106).
		const itemIds = payload.itemIds ?? (record.state === "queued" ? record.payload?.itemIds : undefined);
		this.install({
			...record,
			state: "queued",
			payload: { ...payload, ...(itemIds ? { itemIds } : {}) },
			delivery: undefined,
		});
		this.delivering.add(ticketId);
		this.sending.delete(record.id);
		this.store.changed();
		return true;
	}

	/** The item ids a queued ticket's batch was recorded with, if any. */
	queuedItemIds(ticketId: DeliveryTicketId): readonly string[] | undefined {
		const record = this.openTicket(ticketId);
		return record?.state === "queued" ? record.payload?.itemIds : undefined;
	}

	/**
	 * A delivery whose custody is still open and unconsumed (kept for a later turn) is background work again: recompute.
	 * A delivery its turn consumed stays that run's own work until `settleRun`, so ending it publishes nothing (senpi#6814).
	 */
	endDelivery(ticketId: DeliveryTicketId): void {
		if (!this.delivering.delete(ticketId)) return;
		const record = this.openTicket(ticketId);
		if (record && record.state !== "consumed") this.store.changed();
	}

	passive(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (record) this.close(record, "passive");
	}

	consumed(ticketId: DeliveryTicketId, run: { readonly runId: string; readonly transcriptEntryId: string }): void {
		const record = this.ticketRecord(ticketId);
		if (!record || record.state === "consumed") return;
		this.install({ ...record, state: "consumed", ...run, delivery: undefined });
		this.store.changed();
	}

	failed(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!record || record.state === "consumed") return;
		this.install({ ...record, state: "queued", delivery: "failed" });
		this.store.changed();
	}

	held(ticketId: DeliveryTicketId, noticeId: string): void {
		const record = this.ticketRecord(ticketId);
		if (record) this.close(record, "held", noticeId);
	}

	retire(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!record || record.state === "consumed") return;
		this.install({ ...record, state: "open", delivery: "retired", payload: undefined });
		this.store.changed();
	}

	cancel(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (record && record.state !== "consumed") this.close(record, "cancelled");
	}

	settleRun(runId: string): void {
		for (const record of this.active) {
			if (record.state === "consumed" && record.runId === runId) this.install({ ...record, state: "settled" });
		}
		this.store.changed();
	}

	/**
	 * At restoration, a consumed delivery of any run other than the restored current one belongs to a run that ended:
	 * its message is already in the conversation, so it settles as `idle()` would have (senpi#4848). The current run's
	 * consumed custody stays for crash recovery and `startRun`, unless the transcript holds that run's end
	 * (`currentRunEnded`, senpi#7016). With no recorded run nothing proves the consuming run ended, so crash recovery
	 * keeps all of it.
	 */
	settleEndedRuns(currentRunId: string | undefined, currentRunEnded: boolean): void {
		if (currentRunId === undefined) return;
		const ended = this.active.filter(
			(record) => record.state === "consumed" && (record.runId !== currentRunId || currentRunEnded),
		);
		for (const record of ended) this.install({ ...record, state: "settled" });
		if (ended.length > 0) this.store.changed();
	}

	private install(record: WorkCustodyRecord): void {
		// The journal and the session's event stream get the record as written; only memory drops a closed record's
		// payload (senpi#7603), so the session file a reader or a replay sees is unchanged.
		try {
			this.store.append(record);
			this.unpersisted.delete(record.id);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			this.unpersisted.set(record.id, record);
		}
		this.keep(custodyIsOpen(record) ? record : closedCustody(record));
	}

	/** Open custody stays whole; of a closed record only its ticket stays, and one without a ticket leaves. */
	private keep(record: WorkCustodyRecord): void {
		if (custodyIsOpen(record)) {
			this.openRecords.set(record.id, record);
			if (record.ticketId !== undefined) {
				this.openTickets.set(record.ticketId, record.id);
				this.closedTickets.delete(record.ticketId);
			}
			return;
		}
		this.openRecords.delete(record.id);
		if (record.ticketId !== undefined) {
			this.openTickets.delete(record.ticketId);
			this.closedTickets.add(record.ticketId);
		}
	}

	/** A lifecycle publication cannot claim durability before its live custody is durable. */
	flush(): void {
		for (const [id, record] of this.unpersisted) {
			this.store.append(record);
			this.unpersisted.delete(id);
		}
	}

	/** The open record a token holds; a token whose record closed holds nothing, named by the record's key. */
	private owned(id: string, key: string): WorkCustodyRecord {
		const record = this.openRecords.get(id);
		if (!record) throw new CustodyViolation(key);
		return record;
	}

	private openTicket(ticketId: DeliveryTicketId): WorkCustodyRecord | undefined {
		const id = this.openTickets.get(ticketId);
		return id === undefined ? undefined : this.openRecords.get(id);
	}

	/** The open record of a ticket, or undefined for a closed one; a ticket this registry never held is a violation. */
	private ticketRecord(ticketId: DeliveryTicketId): WorkCustodyRecord | undefined {
		const record = this.openTicket(ticketId);
		if (!record && !this.closedTickets.has(ticketId)) throw new CustodyViolation(ticketId);
		return record;
	}

	private close(
		record: WorkCustodyRecord,
		state: "settled" | "held" | "cancelled" | "passive",
		noticeId?: string,
	): void {
		this.sending.delete(record.id);
		this.install({ ...record, state, ...(noticeId === undefined ? {} : { noticeId }) });
		this.store.changed();
	}

	private token({ id, key }: WorkCustodyRecord): ObligationToken {
		return {
			transfer: (nextKey, kind) => {
				const current = this.owned(id, key);
				if (nextKey === current.key) throw new CustodyViolation(nextKey);
				const next = this.active.find((record) => record.key === nextKey) ?? {
					id: crypto.randomUUID(),
					key: nextKey,
					kind: kind ?? current.kind,
					state: "open" as const,
				};
				// Both writes are synchronous; publish only after custody has moved.
				// If the second append fails, both remain open: work cannot disappear.
				try {
					this.install(next);
					this.install({ ...current, state: "cancelled" });
				} finally {
					this.store.changed();
				}
				return this.token(next);
			},
			ticket: () => {
				const record = this.owned(id, key);
				if (record.ticketId) return record.ticketId;
				const ticketId = crypto.randomUUID();
				this.install({ ...record, state: "queued", ticketId });
				this.store.changed();
				return ticketId;
			},
			heldAsNotice: (noticeId) => this.close(this.owned(id, key), "held", noticeId),
			close: (reason) => this.close(this.owned(id, key), reason === "consumed" ? "settled" : reason),
		};
	}
}
