/**
 * Node entry point for the observed Cursor context limits.
 *
 * The store itself (`cursor/context-limit-store.ts`) is browser-safe because the
 * catalog builders that read it are bundled for the browser. Persistence needs
 * `node:fs`, so it lives here and is installed on first use rather than as an
 * import side effect, which a bundler is free to drop for a package declared
 * side-effect-free. Node callers - the `cursor-agent` stream and the coding
 * agent - use this module; browser-facing code uses the store directly.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	type CursorContextLimitPersistence,
	installCursorContextLimitPersistence,
	getCursorContextLimit as readObservedLimit,
	recordCursorContextLimit as recordObservedLimit,
	resetCursorContextLimitStoreForTest as resetObservedLimits,
	resolveCursorContextWindow as resolveObservedWindow,
} from "../cursor/context-limit-store.ts";

/**
 * Same resolution as the conversation rotation store: an explicit override
 * first, then the agent directory the host configured, then the default one.
 */
export function resolveCursorContextLimitStorePath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.CURSOR_CONTEXT_LIMIT_STORE) {
		return env.CURSOR_CONTEXT_LIMIT_STORE;
	}
	const agentDir =
		env.SENPI_CODING_AGENT_DIR ?? env.CODING_AGENT_DIR ?? `${(env.HOME ?? ".").replace(/\/$/, "")}/.senpi/agent`;
	return `${agentDir.replace(/\/$/, "")}/cursor-context-limits.json`;
}

let savingEnabled = true;

const filePersistence: CursorContextLimitPersistence = {
	load: () => {
		const limits = new Map<string, number>();
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(resolveCursorContextLimitStorePath(), "utf8"));
		} catch (error) {
			// No file on first run, and a truncated or hand-edited one is the same
			// situation for a cache: the catalog window is the documented fallback.
			if (error instanceof Error) return limits;
			throw error;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return limits;
		for (const [modelId, maxTokens] of Object.entries(parsed)) {
			if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
				limits.set(modelId, maxTokens);
			}
		}
		return limits;
	},
	save: (limits) => {
		if (!savingEnabled) return;
		const path = resolveCursorContextLimitStorePath();
		const record: Record<string, number> = {};
		for (const [modelId, maxTokens] of limits) record[modelId] = maxTokens;
		try {
			mkdirSync(dirname(path), { recursive: true });
			const temporaryPath = `${path}.${process.pid}.tmp`;
			writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`);
			renameSync(temporaryPath, path);
		} catch (error) {
			// This file is a cache for the next process. A read-only agent directory
			// must not fail the live turn that observed the limit, and one failure
			// disables saving so a broken path cannot cost a write per checkpoint.
			if (!(error instanceof Error)) throw error;
			savingEnabled = false;
		}
	},
};

function ensurePersistenceInstalled(): void {
	installCursorContextLimitPersistence(filePersistence);
}

/** Records the ceiling Cursor reported for `modelId`; ignores non-positive values. */
export function recordCursorContextLimit(modelId: string, maxTokens: number | undefined): void {
	ensurePersistenceInstalled();
	recordObservedLimit(modelId, maxTokens);
}

export function getCursorContextLimit(modelId: string): number | undefined {
	ensurePersistenceInstalled();
	return readObservedLimit(modelId);
}

/** The window to trust for `modelId`: what the server reported, else the catalog. */
export function resolveCursorContextWindow(modelId: string, catalogWindow: number): number {
	ensurePersistenceInstalled();
	return resolveObservedWindow(modelId, catalogWindow);
}

export function resetCursorContextLimitStoreForTest(): void {
	savingEnabled = true;
	resetObservedLimits();
}
