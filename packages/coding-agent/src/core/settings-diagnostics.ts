import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

function providerSettingsWarnings(settingsManager: SettingsManager): string[] {
	const warnings: string[] = [];
	for (const [providerId, settings] of Object.entries(settingsManager.getProviderSettings())) {
		const value = settings?.maxConcurrency;
		if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
			warnings.push(
				`Invalid providers.${providerId}.maxConcurrency: expected a non-negative integer; using unlimited`,
			);
		}
	}
	return warnings;
}

export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	return [
		...settingsManager.drainErrors().map(({ scope, path, error }) => ({
			type: "warning" as const,
			message: path
				? `Invalid settings file ${path}: ${error.message}`
				: `Invalid ${scope} settings: ${error.message}`,
		})),
		...providerSettingsWarnings(settingsManager).map((message) => ({ type: "warning" as const, message })),
	];
}

/**
 * The CLI labels every diagnostic with the startup phase that produced it. It shares this module's
 * validation so a settings check can never reach one collector and silently miss the other.
 */
export function collectSettingsDiagnosticsWithContext(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return [
		...settingsManager.drainErrors().map(({ scope, error }) => ({
			type: "warning" as const,
			message: `(${context}, ${scope} settings) ${error.message}`,
		})),
		...providerSettingsWarnings(settingsManager).map((message) => ({
			type: "warning" as const,
			message: `(${context}) ${message}`,
		})),
	];
}

/**
 * Remove duplicate type/message diagnostics while preserving their first occurrence.
 * Startup and runtime settings managers can report the same file error.
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
