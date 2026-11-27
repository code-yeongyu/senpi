/** Engine lifecycle bookkeeping (senpi#3864): durable before any conversation, disposable without one. */
export const LIFECYCLE_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"session-lifecycle",
	"work-custody",
	"child-lifecycle",
]);

/** Every `custom` entry type the engine writes as its journal of lifecycle state: those, and the record of a run a restart cut. */
const LIFECYCLE_BOOKKEEPING_TYPES: ReadonlySet<string> = new Set([...LIFECYCLE_ENTRY_TYPES, "interrupted-run"]);

/**
 * Whether `entry` is lifecycle bookkeeping. Restoration folds these entries from the whole history through
 * `lifecycleHistory` and nothing reads them from a branch, so the resident mirror keeps none of them from before
 * the compaction window (senpi#7596).
 */
export function isLifecycleBookkeeping(entry: { readonly type: string; readonly customType?: string }): boolean {
	return (
		entry.type === "custom" && entry.customType !== undefined && LIFECYCLE_BOOKKEEPING_TYPES.has(entry.customType)
	);
}
