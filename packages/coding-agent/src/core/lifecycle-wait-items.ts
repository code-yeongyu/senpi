import type { WakeSourceStateItem } from "./extensions/builtin/monitor-state-event.ts";
import type { LifecycleWaitItem } from "./session-lifecycle-types.ts";

export interface WaitSourceItems {
	readonly items?: readonly WakeSourceStateItem[];
	readonly omittedItems?: number;
}

/** Optional producer detail never determines custody. Lists are snapshots, bounded independently of activeCount. */
export function normalizeWaitItems(value: unknown, omitted?: unknown): WaitSourceItems {
	const byId = new Map<string, WakeSourceStateItem>();
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry !== "object" || entry === null || !("id" in entry)) continue;
			if (typeof entry.id !== "string" || entry.id.trim().length === 0) continue;
			const item: WakeSourceStateItem = {
				id: entry.id,
				...("description" in entry && typeof entry.description === "string"
					? { description: entry.description }
					: {}),
				...("startedAtMs" in entry &&
				typeof entry.startedAtMs === "number" &&
				Number.isFinite(entry.startedAtMs) &&
				Math.abs(entry.startedAtMs) <= 8.64e15
					? { startedAtMs: entry.startedAtMs }
					: {}),
			};
			const previous = byId.get(item.id);
			if (!previous || JSON.stringify(item) < JSON.stringify(previous)) byId.set(item.id, item);
		}
	}
	const items = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const omittedItems =
		Math.max(0, items.length - 32) +
		(typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted > 0 ? omitted : 0);
	return {
		...(items.length ? { items: items.slice(0, 32) } : {}),
		...(omittedItems ? { omittedItems } : {}),
	};
}

/** The one rule for a wake_source_state producer's item list: `items` when set, else the legacy `monitors`. */
export function wakeSourceItems(data: object): unknown {
	return ("items" in data ? data.items : undefined) ?? ("monitors" in data ? data.monitors : undefined);
}

export function waitItemSignature(detail: WaitSourceItems): string {
	return JSON.stringify([detail.items?.map((item) => [item.id, item.description]), detail.omittedItems]);
}

export function projectWaitItems(detail: WaitSourceItems): {
	readonly items?: readonly LifecycleWaitItem[];
	readonly omittedItems?: number;
} {
	return {
		...(detail.items
			? {
					items: detail.items.map((item) => ({
						id: item.id,
						...(item.description === undefined ? {} : { label: item.description }),
						...(item.startedAtMs === undefined ? {} : { startedAt: new Date(item.startedAtMs).toISOString() }),
					})),
				}
			: {}),
		...(detail.omittedItems ? { omittedItems: detail.omittedItems } : {}),
	};
}

export function readWaitItems(value: unknown, omitted?: unknown): ReturnType<typeof projectWaitItems> {
	const items = Array.isArray(value)
		? value.map((item: unknown) => {
				if (typeof item !== "object" || item === null) return item;
				return {
					...("id" in item ? { id: item.id } : {}),
					...("label" in item ? { description: item.label } : {}),
					...("startedAt" in item && typeof item.startedAt === "string"
						? { startedAtMs: Date.parse(item.startedAt) }
						: {}),
				};
			})
		: undefined;
	return projectWaitItems(normalizeWaitItems(items, omitted));
}
