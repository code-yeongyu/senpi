import { SettingsJsonSyntaxError } from "../../../settings-json-syntax-error.ts";
import type { SettingsError, SettingsManager } from "../../../settings-manager.ts";

/**
 * A settings file that fails to load reads as empty settings, which would silently drop every permission
 * rule it declares, deny rules included. Throwing here fails closed (senpi#2624, senpi#6556): the caller
 * records it as the setup error that refuses every tool call until the file loads.
 */
export function assertPermissionSettingsLoaded(settingsManager: SettingsManager): void {
	const failures = settingsManager.drainErrors();
	if (failures.length > 0) throw new Error(failures.map(describeLoadFailure).join("\n"));
}

function describeLoadFailure({ scope, path, error }: SettingsError): string {
	const position = error instanceof SettingsJsonSyntaxError ? `:${error.line}:${error.column}` : "";
	const location = path === undefined ? `the ${scope} settings` : `${path}${position}`;
	return (
		`Failed to load ${scope} settings at ${location}: ${error.message}. ` +
		"Its permission rules (deny rules included) cannot be applied, so every tool call is refused. " +
		"Fix the file at that location (or move it aside), then run /reload or restart senpi."
	);
}
