import { normalizeModelRef } from "@earendil-works/pi-ai";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";
import { parseSettingsJson } from "./settings-json.ts";
import type { Settings, SettingsStorage } from "./settings-manager.ts";

export const STATE_KEYS: ReadonlySet<keyof Settings> = new Set([
	"tipsHistory",
	"changelogSeen",
	"lastChangelogVersion",
	"modelThinkingLevels",
	"modelLastOnThinkingLevels",
	"modelServiceTiers",
]);

const failedMigrations = new Set<string | SettingsStorage>();
const reportedStateErrors = new Set<string | SettingsStorage>();

export function logStateError(storage: SettingsStorage, error: unknown): void {
	const target = storage.selectSource?.("global")?.path ?? storage;
	if (reportedStateErrors.has(target)) return;
	reportedStateErrors.add(target);
	const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	try {
		appendDebugLogEntry("settings: could not read or save state.json; using empty bookkeeping", detail);
	} catch {
		// Diagnostics cannot disable configuration when the debug log is also unwritable.
	}
}

/** State is disposable bookkeeping: malformed bytes never disable config loading or saving. */
export function parseStateSettings(storage: SettingsStorage, content: string | undefined): Record<string, unknown> {
	let raw: Record<string, unknown>;
	try {
		raw = content ? parseSettingsJson(content) : {};
	} catch (error) {
		logStateError(storage, error);
		return {};
	}
	for (const field of ["modelThinkingLevels", "modelLastOnThinkingLevels", "modelServiceTiers"]) {
		const map = raw[field];
		if (typeof map !== "object" || map === null || Array.isArray(map)) continue;
		const normalized: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(map)) {
			const canonical = normalizeModelRef(key);
			if (key === canonical || !Object.hasOwn(map, canonical)) normalized[canonical] = value;
		}
		raw[field] = normalized;
	}
	return raw;
}

/**
 * Move raw global bookkeeping only after its state write succeeds. Re-read both files under
 * their locks, preserving existing state keys and every unrelated config key's value/order.
 */
export function migrateSettingsState(storage: SettingsStorage): void {
	const withStateLock = storage.withStateLock?.bind(storage);
	if (!withStateLock) return;
	const target = storage.selectSource?.("global")?.path ?? storage;
	if (failedMigrations.has(target)) return;
	try {
		storage.withLock("global", (current) => {
			if (!current) return undefined;
			const raw = parseSettingsJson(current);
			if (![...STATE_KEYS].some((key) => Object.hasOwn(raw, key))) return undefined;
			withStateLock((stateContent) => {
				const state = stateContent ? parseSettingsJson(stateContent) : {};
				let changed = false;
				for (const key of STATE_KEYS) {
					if (Object.hasOwn(raw, key) && !Object.hasOwn(state, key)) {
						state[key] = raw[key];
						changed = true;
					}
				}
				return changed ? JSON.stringify(state, null, 2) : undefined;
			});
			for (const key of STATE_KEYS) delete raw[key];
			return JSON.stringify(raw, null, 2);
		});
	} catch (error) {
		failedMigrations.add(target);
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		try {
			appendDebugLogEntry("settings: could not migrate global state keys", detail);
		} catch {
			// Best-effort diagnostics must not prevent reading the legacy settings fallback.
		}
	}
}

/** Only the six bookkeeping keys overlay config; arbitrary state-file keys are never settings. */
export function readSettingsState(storage: SettingsStorage): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	try {
		storage.withStateLock?.((current) => {
			const raw = parseStateSettings(storage, current);
			for (const key of STATE_KEYS) {
				if (Object.hasOwn(raw, key)) state[key] = raw[key];
			}
			return undefined;
		});
	} catch (error) {
		logStateError(storage, error);
		return {};
	}
	return state;
}
