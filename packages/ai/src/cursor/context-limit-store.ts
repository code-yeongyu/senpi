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

export type CursorContextLimitPersistence = {
	/** Limits observed by earlier processes. Called at most once per install. */
	readonly load: () => ReadonlyMap<string, number>;
	/** Called only when a recorded limit actually changed the store. */
	readonly save: (limits: ReadonlyMap<string, number>) => void;
};

const observedLimits = new Map<string, number>();
let persistence: CursorContextLimitPersistence | undefined;
let hydrated = false;

/** Installs the process-wide persistence port. Idempotent per port identity. */
export function installCursorContextLimitPersistence(port: CursorContextLimitPersistence): void {
	if (persistence === port) return;
	persistence = port;
	hydrated = false;
}

function hydrate(): void {
	if (hydrated) return;
	// Set before loading: a load that observes nothing must not retry per read.
	hydrated = true;
	if (!persistence) return;
	for (const [modelId, maxTokens] of persistence.load()) {
		if (!observedLimits.has(modelId)) observedLimits.set(modelId, maxTokens);
	}
}

/**
 * Records the server-reported ceiling for `modelId`. The first checkpoint of a
 * conversation reports 0, so non-positive and non-finite values are ignored.
 */
export function recordCursorContextLimit(modelId: string, maxTokens: number | undefined): void {
	if (maxTokens === undefined || !Number.isFinite(maxTokens) || maxTokens <= 0) return;
	hydrate();
	if (observedLimits.get(modelId) === maxTokens) return;
	observedLimits.set(modelId, maxTokens);
	persistence?.save(observedLimits);
}

export function getCursorContextLimit(modelId: string): number | undefined {
	hydrate();
	return observedLimits.get(modelId);
}

/** The window to trust for `modelId`: what the server reported, else the catalog. */
export function resolveCursorContextWindow(modelId: string, catalogWindow: number): number {
	return getCursorContextLimit(modelId) ?? catalogWindow;
}

/** Drops in-memory state so the next read re-hydrates from the installed port. */
export function resetCursorContextLimitStoreForTest(): void {
	observedLimits.clear();
	hydrated = false;
}
