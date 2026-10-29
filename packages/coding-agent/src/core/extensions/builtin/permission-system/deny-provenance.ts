import type { SettingsManager } from "../../../settings-manager.ts";
import { fromConfig } from "./config.ts";
import type { PermissionConfig, Ruleset } from "./types.ts";
import { Wildcard } from "./wildcard.ts";

/** Last matching deny in global, project, CLI order, as used by the tool refusal. */
export function findDenyProvenance(
	settingsManager: SettingsManager,
	cliRuleset: Ruleset,
	permission: string,
	patterns: readonly string[],
):
	| {
			layer: "global" | "project" | "cli";
			permission: string;
			pattern: string;
			action: string;
			otherLayerDenies: boolean;
	  }
	| undefined {
	const matches = (rules: Ruleset) =>
		rules.filter(
			(rule) =>
				rule.action === "deny" &&
				Wildcard.match(permission, rule.permission) &&
				patterns.some(
					(value) =>
						Wildcard.match(value, rule.pattern) ||
						(rule.pattern.endsWith(" *") && Wildcard.match(value, rule.pattern.slice(0, -2))),
				),
		);
	const globalPermission = (settingsManager.getGlobalSettings() as { permission?: PermissionConfig }).permission;
	const globalMatches = matches(globalPermission ? fromConfig(globalPermission) : []);
	const projectPermission = (settingsManager.getProjectSettings() as { permission?: PermissionConfig }).permission;
	const projectMatches = matches(projectPermission ? fromConfig(projectPermission) : []);
	const cliMatches = matches(cliRuleset);
	if (cliMatches.length > 0) {
		return {
			layer: "cli",
			...cliMatches[cliMatches.length - 1],
			otherLayerDenies: projectMatches.length > 0 || globalMatches.length > 0,
		};
	}
	if (projectMatches.length > 0) {
		return {
			layer: "project",
			...projectMatches[projectMatches.length - 1],
			otherLayerDenies: globalMatches.length > 0,
		};
	}
	if (globalMatches.length > 0) {
		return { layer: "global", ...globalMatches[globalMatches.length - 1], otherLayerDenies: false };
	}
	return undefined;
}
