/** `custom` entry types the engine writes as its journal of lifecycle state. */
const LIFECYCLE_BOOKKEEPING_TYPES: ReadonlySet<string> = new Set([
	"session-lifecycle",
	"work-custody",
	"child-lifecycle",
	"interrupted-run",
]);

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
