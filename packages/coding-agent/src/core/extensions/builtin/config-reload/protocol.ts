/**
 * In-process wire contract for config-watch extensions.
 *
 * Event emitters are intentionally untyped, so consumers must use these guards
 * before accepting a payload from `pi.events`.
 */
export const configWatchChannels = {
	register: "config-watch:register",
	unregister: "config-watch:unregister",
	ready: "config-watch:ready",
	changed: "config-watch:changed",
	reloaded: "config-watch:reloaded",
	rejected: "config-watch:rejected",
} as const;

export const CONFIG_WATCH_REGISTER = configWatchChannels.register;
export const CONFIG_WATCH_UNREGISTER = configWatchChannels.unregister;
export const CONFIG_WATCH_READY = configWatchChannels.ready;
export const CONFIG_WATCH_CHANGED = configWatchChannels.changed;
export const CONFIG_WATCH_RELOADED = configWatchChannels.reloaded;
export const CONFIG_WATCH_REJECTED = configWatchChannels.rejected;

export type ConfigWatchTargetKind = "file" | "dir";

export interface ConfigWatchTarget {
	path: string;
	kind: ConfigWatchTargetKind;
	filterGlobs?: string[];
}

export type ConfigWatchValidation = { ok: true } | { ok: false; errors: string[] };

export interface ConfigWatchRegistration {
	/** Registration IDs are unique; a later registration with the same ID replaces this one. */
	id: string;
	displayName: string;
	targets: ConfigWatchTarget[];
	validate?: (changedPaths: readonly string[]) => Promise<ConfigWatchValidation> | ConfigWatchValidation;
}

export interface ConfigWatchUnregistration {
	id: string;
}

export interface ConfigWatchChanged {
	registrationId: string;
	paths: string[];
	deferred: boolean;
}

export interface ConfigWatchReloaded {
	registrationId: string;
	paths: string[];
}

export interface ConfigWatchRejected {
	registrationId: string;
	paths: string[];
	errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function isConfigWatchTarget(value: unknown): value is ConfigWatchTarget {
	return (
		isRecord(value) &&
		typeof value.path === "string" &&
		(value.kind === "file" || value.kind === "dir") &&
		(value.filterGlobs === undefined || isStringArray(value.filterGlobs))
	);
}

export function isConfigWatchRegistration(value: unknown): value is ConfigWatchRegistration {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.displayName === "string" &&
		Array.isArray(value.targets) &&
		value.targets.every(isConfigWatchTarget) &&
		(value.validate === undefined || typeof value.validate === "function")
	);
}

export function isConfigWatchValidation(value: unknown): value is ConfigWatchValidation {
	if (!isRecord(value) || typeof value.ok !== "boolean") return false;
	return value.ok || isStringArray(value.errors);
}

export function isConfigWatchUnregistration(value: unknown): value is ConfigWatchUnregistration {
	return isRecord(value) && typeof value.id === "string";
}

export function isConfigWatchChanged(value: unknown): value is ConfigWatchChanged {
	return (
		isRecord(value) &&
		typeof value.registrationId === "string" &&
		isStringArray(value.paths) &&
		typeof value.deferred === "boolean"
	);
}

export function isConfigWatchReloaded(value: unknown): value is ConfigWatchReloaded {
	return isRecord(value) && typeof value.registrationId === "string" && isStringArray(value.paths);
}

export function isConfigWatchRejected(value: unknown): value is ConfigWatchRejected {
	return (
		isRecord(value) &&
		typeof value.registrationId === "string" &&
		isStringArray(value.paths) &&
		isStringArray(value.errors)
	);
}

/**
 * Matches plain file names, path suffixes, and a leading-star suffix pattern.
 * This intentionally does not implement a full glob language.
 */
export function matchesConfigWatchFilter(path: string, filterGlobs: readonly string[] | undefined): boolean {
	if (filterGlobs === undefined || filterGlobs.length === 0) return true;

	const normalizedPath = path.replaceAll("\\", "/");
	const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
	return filterGlobs.some((filterGlob) => {
		if (filterGlob.startsWith("*")) return normalizedPath.endsWith(filterGlob.slice(1));
		return basename === filterGlob || normalizedPath.endsWith(`/${filterGlob}`);
	});
}

/** Returns registrations keyed by ID, with later duplicate registrations taking precedence. */
export function resolveConfigWatchRegistrations(
	registrations: Iterable<ConfigWatchRegistration>,
): ConfigWatchRegistration[] {
	return [...new Map([...registrations].map((registration) => [registration.id, registration])).values()];
}
