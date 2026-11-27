import { readBackgroundSource } from "./lifecycle-background-waits.ts";
import type { LifecycleWaits } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";

export type BackgroundSource = LifecycleWaits["background"][number];

/**
 * The background sources one `session-lifecycle` record changes: `set` adds or replaces a source by name, `removed`
 * names the sources that left. The record lists no other source, so its size follows the change, not the set
 * (senpi#5612).
 */
export interface BackgroundChanges {
	readonly set?: readonly BackgroundSource[];
	readonly removed?: readonly string[];
}

export function backgroundBySource(sources: readonly BackgroundSource[]): Map<string, BackgroundSource> {
	return new Map(sources.map((source) => [source.source, source]));
}

export function backgroundChanges(
	durable: ReadonlyMap<string, BackgroundSource>,
	live: readonly BackgroundSource[],
): BackgroundChanges {
	const liveNames = new Set(live.map((source) => source.source));
	const set = live.filter((source) => {
		const before = durable.get(source.source);
		return before === undefined || JSON.stringify(before) !== JSON.stringify(source);
	});
	const removed = [...durable.keys()].filter((name) => !liveNames.has(name));
	return { ...(set.length > 0 ? { set } : {}), ...(removed.length > 0 ? { removed } : {}) };
}

/**
 * Rebuilds the background sources from a session's records in write order. A record with `backgroundChanges` applies
 * them; a record written before senpi#5612 names its whole list and replaces the set, so old transcripts still load.
 */
export function replayBackground(records: readonly unknown[]): Map<string, BackgroundSource> {
	let sources = new Map<string, BackgroundSource>();
	for (const record of records) {
		if (!isRecord(record)) continue;
		const changes = record.backgroundChanges;
		if (isRecord(changes)) {
			if (Array.isArray(changes.removed))
				for (const name of changes.removed) if (typeof name === "string") sources.delete(name);
			if (Array.isArray(changes.set))
				for (const value of changes.set) {
					const source = readBackgroundSource(value);
					if (source) sources.set(source.source, source);
				}
			continue;
		}
		const listed =
			isRecord(record.waitingOn) && Array.isArray(record.waitingOn.background) ? record.waitingOn.background : [];
		sources = new Map();
		for (const value of listed) {
			const source = readBackgroundSource(value);
			if (source) sources.set(source.source, source);
		}
	}
	return sources;
}
