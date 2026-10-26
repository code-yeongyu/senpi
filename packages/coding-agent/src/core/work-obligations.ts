import type { DeliveryTicketId, ObligationKind, ObligationToken, WorkObligations } from "./session-lifecycle-types.ts";
import { normalizeWaitItems, waitItemSignature } from "./lifecycle-wait-items.ts";
import type { SessionEntry } from "./session-manager.ts";
import { type CustodyPayload, custodyIsOpen, readWorkCustody, type WorkCustodyRecord } from "./work-custody-record.ts";

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
	readonly entries: readonly SessionEntry[];
	append(record: WorkCustodyRecord): void;
	changed(): void;
}

/** One session's durable registry. A token never acknowledges its own delivery. */
export class SessionWorkObligations implements WorkObligations {
	private readonly records = new Map<string, WorkCustodyRecord>();
	private readonly unpersisted = new Map<string, WorkCustodyRecord>();
	private readonly delivering = new Set<DeliveryTicketId>();
	private readonly publishedSources = new Set<string>();
	private readonly store: CustodyStore;
	constructor(store: CustodyStore) {
		this.store = store;
		for (const entry of store.entries) {
			if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
			const record = readWorkCustody(entry.data);
			if (record) this.records.set(record.id, record);
		}
	}

	get active(): readonly WorkCustodyRecord[] {
		return [...this.records.values()].filter(custodyIsOpen);
	}

	get activeCount(): number {
		return this.active.reduce((sum, record) => sum + (record.activeCount ?? 1), 0);
	}

	get persisted(): boolean {
		return this.unpersisted.size === 0;
	}

	open(key: string, kind: ObligationKind, detail?: string): ObligationToken {
		const existing = this.active.find((record) => record.key === key);
		if (existing) return this.token(existing.id);
		const record: WorkCustodyRecord = {
			id: crypto.randomUUID(),
			key,
			kind,
			state: "open",
			...(detail === undefined ? {} : { detail }),
		};
		this.install(record);
		this.store.changed();
		return this.token(record.id);
	}

	syncSource(source: string, kind: ObligationKind, activeCount: number, items?: unknown): void {
		const key = `${WAKE_SOURCE_KEY_PREFIX}${source}`;
		this.publishedSources.add(key);
		const current = this.active.find((record) => record.key === key);
		if (activeCount <= 0) {
			if (current) this.close(current.id, "passive");
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
				this.close(record.id, "passive");
		}
	}

	/**
	 * The single ticket admission check every send branch runs before it writes anything (held notices, a queued
	 * message, a delivery): an unknown, closed, consumed or in-delivery ticket takes no new delivery.
	 */
	admission(ticketId: DeliveryTicketId): TicketAdmission {
		const record = [...this.records.values()].find((value) => value.ticketId === ticketId);
		if (!record) return "unknown";
		if (!custodyIsOpen(record)) return "closed";
		if (record.state === "consumed") return "consumed";
		return this.delivering.has(ticketId) ? "delivering" : "admitted";
	}

	queue(ticketId: DeliveryTicketId, payload: CustodyPayload): boolean {
		const admission = this.admission(ticketId);
		if (admission === "unknown") throw new CustodyViolation(ticketId);
		if (admission !== "admitted") return false;
		const record = this.ticketRecord(ticketId);
		// A restored queued ticket is re-sent plain; it keeps the item ids its batch was recorded with (senpi#4106).
		const itemIds = payload.itemIds ?? (record.state === "queued" ? record.payload?.itemIds : undefined);
		this.install({
			...record,
			state: "queued",
			payload: { ...payload, ...(itemIds ? { itemIds } : {}) },
			delivery: undefined,
		});
		this.delivering.add(ticketId);
		this.store.changed();
		return true;
	}

	/** The item ids a queued ticket's batch was recorded with, if any. */
	queuedItemIds(ticketId: DeliveryTicketId): readonly string[] | undefined {
		const record = [...this.records.values()].find((value) => value.ticketId === ticketId);
		return record?.state === "queued" ? record.payload?.itemIds : undefined;
	}

	endDelivery(ticketId: DeliveryTicketId): void {
		this.delivering.delete(ticketId);
	}

	passive(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record)) this.close(record.id, "passive");
	}

	consumed(ticketId: DeliveryTicketId, run: { readonly runId: string; readonly transcriptEntryId: string }): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "consumed", ...run, delivery: undefined });
		this.store.changed();
	}

	failed(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "queued", delivery: "failed" });
		this.store.changed();
	}

	held(ticketId: DeliveryTicketId, noticeId: string): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record)) this.close(record.id, "held", noticeId);
	}

	retire(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (!custodyIsOpen(record) || record.state === "consumed") return;
		this.install({ ...record, state: "open", delivery: "retired", payload: undefined });
		this.store.changed();
	}

	cancel(ticketId: DeliveryTicketId): void {
		const record = this.ticketRecord(ticketId);
		if (custodyIsOpen(record) && record.state !== "consumed") this.close(record.id, "cancelled");
	}

	settleRun(runId: string): void {
		for (const record of this.active) {
			if (record.state === "consumed" && record.runId === runId) this.install({ ...record, state: "settled" });
		}
		this.store.changed();
	}

	private install(record: WorkCustodyRecord): void {
		try {
			this.store.append(record);
			this.unpersisted.delete(record.id);
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			this.unpersisted.set(record.id, record);
		}
		this.records.set(record.id, record);
	}

	/** A lifecycle publication cannot claim durability before its live custody is durable. */
	flush(): void {
		for (const [id, record] of this.unpersisted) {
			this.store.append(record);
			this.unpersisted.delete(id);
		}
	}

	private owned(id: string): WorkCustodyRecord {
		const record = this.records.get(id);
		if (!record || !custodyIsOpen(record)) throw new CustodyViolation(record?.key ?? id);
		return record;
	}

	private ticketRecord(ticketId: DeliveryTicketId): WorkCustodyRecord {
		const record = [...this.records.values()].find((value) => value.ticketId === ticketId);
		if (!record) throw new CustodyViolation(ticketId);
		return record;
	}

	private close(id: string, state: "settled" | "held" | "cancelled" | "passive", noticeId?: string): void {
		const record = this.owned(id);
		this.install({ ...record, state, ...(noticeId === undefined ? {} : { noticeId }) });
		this.store.changed();
	}

	private token(id: string): ObligationToken {
		return {
			transfer: (nextKey, kind) => {
				const current = this.owned(id);
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
				return this.token(next.id);
			},
			ticket: () => {
				const record = this.owned(id);
				if (record.ticketId) return record.ticketId;
				const ticketId = crypto.randomUUID();
				this.install({ ...record, state: "queued", ticketId });
				this.store.changed();
				return ticketId;
			},
			heldAsNotice: (noticeId) => this.close(id, "held", noticeId),
			close: (reason) => this.close(id, reason === "consumed" ? "settled" : reason),
		};
	}
}
