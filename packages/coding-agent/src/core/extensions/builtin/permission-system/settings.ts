import type { Settings, SettingsManager } from "../../../settings-manager.ts";
import { PERMISSION_PRESET_NAMES, parsePermissionPresetName } from "./cli.ts";
import { DEFAULT_PERMISSION_PRESET, fromConfig, merge, rulesForPreset } from "./config.ts";
import { loadApproved } from "./storage.ts";
import type { PermissionConfig, PermissionPresetName, Ruleset } from "./types.ts";

type PermissionSettings = {
	permission?: PermissionConfig;
	permissionPreset?: unknown;
};

/**
 * Load permission settings from global and project settings.json files.
 *
 * Merge order (highest precedence last):
 *   1. Default preset
 *   2. Global preset and rules (~/.senpi/agent/settings.json)
 *   3. Project preset and rules (.senpi/settings.json)
 *   4. CLI preset and rules
 *
 * Runtime approvals are stored separately in .senpi/permissions-approved.jsonl
 * and loaded via loadApproved() from storage.ts.
 */
export function loadPermissionSettings(
	settingsManager: SettingsManager,
	cliOverride: Ruleset,
	projectDir: string,
	cliPresetOverride?: PermissionPresetName,
	agentDir?: string,
): { staticRuleset: Ruleset; approved: Ruleset; preset: PermissionPresetName } {
	const globalSettings = settingsManager.getGlobalSettings() as Settings & PermissionSettings;
	const globalPreset = parseSettingsPreset(globalSettings.permissionPreset, "global");
	const globalPresetRuleset = globalPreset ? rulesForPreset(globalPreset) : [];
	const globalRuleset = globalSettings.permission ? fromConfig(globalSettings.permission) : [];

	const projectSettings = settingsManager.getProjectSettings() as Settings & PermissionSettings;
	const projectPreset = parseSettingsPreset(projectSettings.permissionPreset, "project");
	const projectPresetRuleset = projectPreset ? rulesForPreset(projectPreset) : [];
	const projectRuleset = projectSettings.permission ? fromConfig(projectSettings.permission) : [];

	// The default already opens with full-access's wildcard allow, so a CLI full-access preset is
	// redundant; re-appending it would only mask a user's explicit settings/CLI deny (senpi#2465).
	const cliPresetRuleset =
		cliPresetOverride && cliPresetOverride !== DEFAULT_PERMISSION_PRESET ? rulesForPreset(cliPresetOverride) : [];
	const staticRuleset = merge(
		rulesForPreset(DEFAULT_PERMISSION_PRESET),
		globalPresetRuleset,
		globalRuleset,
		projectPresetRuleset,
		projectRuleset,
		cliPresetRuleset,
		cliOverride,
	);
	const approved = agentDir === undefined ? [] : loadApproved(agentDir, projectDir);

	const preset = cliPresetOverride ?? projectPreset ?? globalPreset ?? DEFAULT_PERMISSION_PRESET;
	return { staticRuleset, approved, preset };
}

function parseSettingsPreset(value: unknown, scope: "global" | "project"): PermissionPresetName | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Invalid ${scope} permissionPreset ${JSON.stringify(value)}. Expected a string.`);
	}

	const preset = parsePermissionPresetName(value);
	if (!preset) {
		throw new Error(
			`Invalid ${scope} permissionPreset "${value}". Expected one of: ${PERMISSION_PRESET_NAMES.join(", ")}.`,
		);
	}
	return preset;
}
