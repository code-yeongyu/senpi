import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { parseSettingsJson } from "./settings-json.ts";
import { ProjectTrustStore } from "./trust-manager.ts";

/**
 * Settings that name an executable or a command line, or enable a provider that runs one (senpi#6362). They are honoured
 * only from global settings or from a project the person trusted; from any other project they are reported as ignored.
 */
export const EXECUTABLE_SETTING_PATHS = [
	"shellPath",
	"shellCommandPrefix",
	"npmCommand",
	"externalEditor",
	"cursorCliOauthProvider.enabled",
	"cursorCliOauthProvider.executablePath",
	"anthropicSubscriptionProvider.enabled",
	"claudeSdkOauthProvider.enabled",
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

/** The executable-naming keys an (untrusted) project settings file sets; read only, never locked or rewritten. */
export function ignoredExecutableProjectSettings(path: string): string[] {
	if (!existsSync(path)) return [];
	let raw: Record<string, unknown>;
	try {
		raw = parseSettingsJson(readFileSync(path, "utf8"));
	} catch {
		return [];
	}
	return EXECUTABLE_SETTING_PATHS.filter((key) => hasPath(raw, key));
}
