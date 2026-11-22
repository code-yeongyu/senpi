/**
 * Per-session, per-model thinking-level memory (senpi#3819).
 *
 * The session file is the single source: every `thinking_level_change` names the model the level
 * applied to, so the map is rebuilt from the branch on resume, fork and tree navigation alike, and
 * no client (TUI, desktop, RPC) keeps a copy of its own.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Where the thinking level in force came from.
 * - `explicit`: a direct level request (`setThinkingLevel`, `/thinking`, RPC, a favorite's `:level`).
 * - `session`: this session's last level for the model, restored by a model switch.
 * - `global`: the model's last-used level from any session (`modelThinkingLevels`).
 * - `model-default`: the model's own declared default.
 * - `default`: the configured or built-in default.
 * - `fallback`: the ephemeral level a retry fallback applied.
 * - `clamped`: a requested or restored level the model cannot run, replaced by its nearest supported one.
 */
export type ThinkingLevelSource =
	| "explicit"
	| "session"
	| "global"
	| "model-default"
	| "default"
	| "fallback"
	| "clamped";

const THINKING_LEVELS: ReadonlySet<string> = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

export function modelThinkingKey(model: { readonly provider: string; readonly id: string }): string {
	return `${model.provider}/${model.id}`;
}

/**
 * The last level each model ran at on this branch, keyed `provider/id`. Entries written before
 * senpi#3819 carry no model and are skipped: attributing them by position would misfile the level a
 * switch writes just before its `model_change`.
 */
export function deriveSessionModelThinkingLevels(path: readonly SessionEntry[]): Record<string, ThinkingLevel> {
	const levels: Record<string, ThinkingLevel> = {};
	for (const entry of path) {
		if (entry.type !== "thinking_level_change") continue;
		// Session files are parsed without validation, so every field is checked here.
		if (typeof entry.provider !== "string" || typeof entry.modelId !== "string") continue;
		if (!isThinkingLevel(entry.thinkingLevel)) continue;
		levels[modelThinkingKey({ provider: entry.provider, id: entry.modelId })] = entry.thinkingLevel;
	}
	return levels;
}

/** Re-derives only when the branch leaf moved, so repeated `get_state` reads stay O(1). */
export class SessionThinkingMemory {
	private cached: { readonly leafId: string | null; readonly levels: Record<string, ThinkingLevel> } | undefined;

	private readonly source: { getLeafId(): string | null; getBranch(): SessionEntry[] };

	constructor(source: { getLeafId(): string | null; getBranch(): SessionEntry[] }) {
		this.source = source;
	}

	levels(): Record<string, ThinkingLevel> {
		const leafId = this.source.getLeafId();
		if (this.cached?.leafId !== leafId) {
			this.cached = { leafId, levels: deriveSessionModelThinkingLevels(this.source.getBranch()) };
		}
		return { ...this.cached.levels };
	}

	levelFor(model: { readonly provider: string; readonly id: string }): ThinkingLevel | undefined {
		return this.levels()[modelThinkingKey(model)];
	}
}
