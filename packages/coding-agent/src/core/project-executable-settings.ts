import { join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { ProjectTrustStore } from "./trust-manager.ts";

/**
 * Settings that name an executable or a command line, or enable a provider that runs one a project can choose (senpi#6362). They are honoured
 * only from global settings or from a project the person trusted; from any other project they are reported as ignored.
 */
export const EXECUTABLE_SETTING_PATHS = [
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"externalEditor",
	"cursorCliOauthProvider.enabled",
	"cursorCliOauthProvider.executablePath",
] as const;

/** Where the saved trust decisions live; a settings cache keyed on it notices a decision made after it was built. */
export function projectTrustFilePath(agentDir: string): string {
	return join(resolvePath(agentDir), "trust.json");
}

/** The decision the person saved for `cwd` (or the nearest folder above it); anything else is not trust. */
export function savedProjectTrusted(cwd: string, agentDir: string): boolean {
	try {
		return new ProjectTrustStore(agentDir).getNearestEntry(cwd)?.decision === true;
	} catch {
		return false;
	}
}

function hasPath(value: unknown, path: string): boolean {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return false;
		current = Reflect.get(current, key);
	}
	return true;
}

/** The executable-naming keys a project's (already loaded) settings set. */
export function executableSettingPathsIn(settings: object): string[] {
	return EXECUTABLE_SETTING_PATHS.filter((key) => hasPath(settings, key));
}

/** A copy of `settings` without the given dotted paths; an emptied parent object is removed too. */
export function withoutSettingPaths<T extends object>(settings: T, paths: readonly string[]): T {
	const copy = structuredClone(settings) as Record<string, unknown>;
	for (const path of paths) {
		const keys = path.split(".");
		const last = keys.pop();
		if (last === undefined) continue;
		const parent = keys.reduce<unknown>(
			(node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined),
			copy,
		);
		if (typeof parent !== "object" || parent === null) continue;
		Reflect.deleteProperty(parent, last);
		if (keys.length > 0 && Object.keys(parent).length === 0) {
			const grand = keys
				.slice(0, -1)
				.reduce<unknown>(
					(node, key) => (typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined),
					copy,
				);
			if (typeof grand === "object" && grand !== null) Reflect.deleteProperty(grand, keys[keys.length - 1] ?? "");
		}
	}
	return copy as T;
}
