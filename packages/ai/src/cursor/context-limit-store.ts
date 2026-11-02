/**
 * Context ceilings Cursor itself reported, keyed by model id.
 *
 * `GetUsableModels` carries no window, so `CURSOR_MODEL_CAPABILITIES` is a
 * committed guess at what each family accepts. The server states the truth on
 * every conversation checkpoint (`tokenDetails.maxTokens`), so once a model has
 * been observed, that value outranks the catalog for every later request.
 *
 * This module stays browser-safe: `providers/cursor.ts` and
 * `cursor/store-migration.ts` materialize catalog windows and are bundled for
 * the browser. Node processes install file persistence through
 * `installCursorContextLimitPersistence` - see `utils/cursor-context-limit.ts`.
 */

import { processSingleton } from "../utils/process-singleton.ts";

export type CursorContextLimitPersistence = {
	/** Limits observed by earlier processes. Called at most once per install. */
	readonly load: () => ReadonlyMap<string, number>;
	/** Called only when a recorded limit actually changed the store. */
	readonly save: (limits: ReadonlyMap<string, number>) => void;
};

type ObservedLimitsStore = {
	readonly limits: Map<string, number>;
	persistence: CursorContextLimitPersistence | undefined;
	hydrated: boolean;
};

// The Cursor stream records into this store and the coding agent reads it; the release bundle
// gives each of them its own copy of this module, so the state is process-wide.
const store = processSingleton<ObservedLimitsStore>("@earendil-works/pi-ai:cursor-context-limits", () => ({
	limits: new Map(),
	persistence: undefined,
	hydrated: false,
}));

/** Installs the process-wide persistence port. Idempotent per port identity. */
export function installCursorContextLimitPersistence(port: CursorContextLimitPersistence): void {
	if (store.persistence === port) return;
	store.persistence = port;
	store.hydrated = false;
}

function hydrate(): void {
	if (store.hydrated) return;
	// Set before loading: a load that observes nothing must not retry per read.
	store.hydrated = true;
	if (!store.persistence) return;
	for (const [modelId, maxTokens] of store.persistence.load()) {
		if (!store.limits.has(modelId)) store.limits.set(modelId, maxTokens);
	}
}

/**
 * Records the server-reported ceiling for `modelId`. The first checkpoint of a
 * conversation reports 0, so non-positive and non-finite values are ignored.
 */
export function recordCursorContextLimit(modelId: string, maxTokens: number | undefined): void {
	if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens <= 0) return;
	hydrate();
	if (store.limits.get(modelId) === maxTokens) return;
	store.limits.set(modelId, maxTokens);
	store.persistence?.save(store.limits);
}

export function getCursorContextLimit(modelId: string): number | undefined {
	hydrate();
	return store.limits.get(modelId);
}

/** The window to trust for `modelId`: what the server reported, else the catalog. */
export function resolveCursorContextWindow(modelId: string, catalogWindow: number): number {
	return getCursorContextLimit(modelId) ?? catalogWindow;
}

/** Drops in-memory state so the next read re-hydrates from the installed port. */
export function resetCursorContextLimitStoreForTest(): void {
	store.limits.clear();
	store.hydrated = false;
}
