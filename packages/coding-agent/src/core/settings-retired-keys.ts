import { appendDebugLogEntry } from "./hidden-stdout-log.ts";
import { parseSettingsJson } from "./settings-json.ts";
import type { SettingsScope, SettingsStorage } from "./settings-manager.ts";

/**
 * Settings keys whose feature no longer exists. Each entry is `[parent, key]`: the key is deleted
 * from the parent object, and the parent is dropped once nothing is left in it.
 */
const RETIRED_NESTED_KEYS: ReadonlyArray<readonly [parent: string, key: string]> = [["experimental", "sharedHost"]];

/** Deletes every retired key from a raw parsed settings object in place; true when one was present. */
export function removeRetiredSettingsKeys(raw: Record<string, unknown>): boolean {
	let removed = false;
	for (const [parent, key] of RETIRED_NESTED_KEYS) {
		const container = raw[parent];
		if (typeof container !== "object" || container === null || Array.isArray(container) || !(key in container)) {
			continue;
		}
		const remaining: Record<string, unknown> = { ...container };
		delete remaining[key];
		if (Object.keys(remaining).length === 0) delete raw[parent];
		else raw[parent] = remaining;
		removed = true;
	}
	return removed;
}

/**
 * Settings files (or path-less storages) whose retired-key rewrite already failed in this process.
 * One launch builds several `SettingsManager`s over the same file; after the first failure the rest
 * neither retry the locked write nor log it again.
 */
const failedRewrites = new Set<string | SettingsStorage>();

/**
 * Rewrites one scope's file as its RAW parsed content with the retired keys removed. Unlike the
 * normal save path it runs no `migrateSettings()`, so every other key keeps its parsed value exactly
 * (legacy shapes included). The edit is re-derived from the content seen under the storage lock, so
 * a concurrent writer's content is edited rather than overwritten. A JSONC file loses its comments.
 *
 * A failed write never fails the load: the key is already ignored in memory, and the failure is
 * recorded once per settings file per process in the brand debug log.
 */
export function writeRawScopedSettings(storage: SettingsStorage, scope: SettingsScope): void {
	const target = storage.selectSource?.(scope)?.path ?? storage;
	if (failedRewrites.has(target)) return;
	try {
		storage.withLock(scope, (current) => {
			if (!current) return undefined;
			const raw = parseSettingsJson(current);
			return removeRetiredSettingsKeys(raw) ? JSON.stringify(raw, null, 2) : undefined;
		});
	} catch (error) {
		failedRewrites.add(target);
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		try {
			appendDebugLogEntry(`settings: could not remove retired ${scope} settings keys`, detail);
		} catch {
			// The debug log is best-effort diagnostics; an unwritable log must not fail settings loading.
		}
	}
}
