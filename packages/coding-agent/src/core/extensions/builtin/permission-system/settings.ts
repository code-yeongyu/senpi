import type { Settings, SettingsManager } from "../../../settings-manager.js";
import { fromConfig, merge } from "./config.js";
import { loadApproved } from "./storage.js";
import type { PermissionConfig, Ruleset } from "./types.js";

/**
 * Load permission settings from global and project settings.json files.
 *
 * Merge order (highest precedence last):
 *   1. Global settings (~/.senpi/agent/settings.json)
 *   2. Project settings (.senpi/settings.json)
 *   3. CLI override (passed directly to this function)
 *
 * Runtime approvals are stored separately in .senpi/permissions-approved.jsonl
 * and loaded via loadApproved() from storage.ts.
 */
export function loadPermissionSettings(
	settingsManager: SettingsManager,
	cliOverride: Ruleset,
	projectDir: string,
): { staticRuleset: Ruleset; approved: Ruleset } {
	const globalSettings = settingsManager.getGlobalSettings() as Settings & { permission?: PermissionConfig };
	const globalRuleset = globalSettings.permission ? fromConfig(globalSettings.permission) : [];

	const projectSettings = settingsManager.getProjectSettings() as Settings & { permission?: PermissionConfig };
	const projectRuleset = projectSettings.permission ? fromConfig(projectSettings.permission) : [];

	const staticRuleset = merge(globalRuleset, projectRuleset, cliOverride);
	const approved = loadApproved(projectDir);

	return { staticRuleset, approved };
}
