import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import type { ConfigReloadLogger } from "./log.ts";

/**
 * Settings keys a running session already applies live (model/thinking picks)
 * or never reads back (changelog bookkeeping). A settings.json change limited
 * to these keys — typically /model or a thinking-level change in another
 * session or a background CLI run — must not hot-reload this session. Any
 * other key change keeps the full validate-and-reload flow.
 */
const ROUTINE_SETTINGS_KEYS: ReadonlySet<string> = new Set([
	"defaultModel",
	"defaultProvider",
	"defaultThinkingLevel",
	"lastChangelogVersion",
]);

export function joinConfigDir(cwd: string): string {
	return resolve(cwd, CONFIG_DIR_NAME);
}

export function isSettingsPath(path: string, agentDir: string, cwd: string): boolean {
	return (
		resolve(path) === resolve(agentDir, "settings.json") ||
		resolve(path) === resolve(joinConfigDir(cwd), "settings.json")
	);
}

function settingsSnapshotKey(path: string): string {
	return resolve(path);
}

export function updateSettingsContentSnapshot(contents: Map<string, string>, path: string): void {
	const key = settingsSnapshotKey(path);
	try {
		contents.set(key, readFileSync(path, "utf-8"));
	} catch {
		contents.delete(key);
	}
}

export function refreshSettingsContentSnapshots(contents: Map<string, string>, agentDir: string, cwd: string): void {
	contents.clear();
	updateSettingsContentSnapshot(contents, resolve(agentDir, "settings.json"));
	updateSettingsContentSnapshot(contents, resolve(joinConfigDir(cwd), "settings.json"));
}

function parseSettingsObject(content: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		return isPlainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function changedTopLevelKeys(previous: Record<string, unknown>, next: Record<string, unknown>): string[] {
	const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
	const changed: string[] = [];
	for (const key of keys) {
		if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changed.push(key);
	}
	return changed.sort();
}

function isRoutineOnlySettingsChange(previousContent: string | undefined, nextContent: string | undefined): boolean {
	if (previousContent === undefined || nextContent === undefined) return false;
	const previous = parseSettingsObject(previousContent);
	const next = parseSettingsObject(nextContent);
	if (previous === undefined || next === undefined) return false;
	const changedKeys = changedTopLevelKeys(previous, next);
	return changedKeys.length > 0 && changedKeys.every((key) => ROUTINE_SETTINGS_KEYS.has(key));
}

/**
 * Drops settings.json changes whose top-level diff is limited to routine keys
 * (ROUTINE_SETTINGS_KEYS). The content diff works across processes, unlike the
 * process-local self-write tracker: /model in one session no longer hot-reloads
 * every other session. The snapshot base advances for every observed settings
 * path, suppressed or not, so each event is classified against the previous
 * event's content. Missing or unparseable content is never suppressed.
 */
export function excludeRoutineOnlySettingsChanges(
	paths: readonly string[],
	contents: Map<string, string>,
	agentDir: string,
	cwd: string,
	logger: ConfigReloadLogger,
): string[] {
	return paths.filter((path) => {
		if (!isSettingsPath(path, agentDir, cwd)) return true;
		const previousContent = contents.get(settingsSnapshotKey(path));
		let nextContent: string | undefined;
		try {
			nextContent = readFileSync(path, "utf-8");
		} catch {
			nextContent = undefined;
		}
		updateSettingsContentSnapshot(contents, path);
		if (!isRoutineOnlySettingsChange(previousContent, nextContent)) return true;
		logger.debug("routine_settings_change_suppressed", { path });
		return false;
	});
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
