import type { FileEntry, SessionEntry } from "./session-manager.ts";
import type { ResidentStringStore } from "./session-resident-store.ts";

type LoadHistoryEntries = () => readonly FileEntry[];
type OnMaterialized = (entry: SessionEntry) => void;

type MaterializeSessionEntriesOptions = {
	readonly residentStore: ResidentStringStore;
	readonly loadHistoryEntries: LoadHistoryEntries;
	readonly onMaterialized: OnMaterialized;
};

export function materializeSessionEntries(
	entries: readonly SessionEntry[],
	options: MaterializeSessionEntriesOptions,
): SessionEntry[] {
	const { residentStore, loadHistoryEntries, onMaterialized } = options;
	const missingEntryIds = new Set<string>();
	const materialized = entries.map((entry) =>
		residentStore.materialize(entry, () => {
			missingEntryIds.add(entry.id);
			return undefined;
		}),
	);
	if (missingEntryIds.size === 0) {
		for (const entry of materialized) onMaterialized(entry);
		return materialized;
	}

	const persistedById = new Map(
		loadHistoryEntries()
			.filter((entry): entry is SessionEntry => entry.type !== "session")
			.map((entry) => [entry.id, entry] as const),
	);
	const repaired = materialized.map((entry) => {
		if (!missingEntryIds.has(entry.id)) return entry;
		const persisted = persistedById.get(entry.id);
		return persisted === undefined ? entry : residentStore.materialize(persisted);
	});
	for (const entry of repaired) onMaterialized(entry);
	return repaired;
}
