import { type ComputerSettings, resolveComputerSettings } from "@code-yeongyu/senpi-desktop-tool";
import { type Settings, SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionContext } from "../../types.ts";

function computerBlock(settings: Settings): unknown {
	return "computer" in settings ? settings.computer : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `computer` block of the global and (trusted) project `settings.json`, project keys over global ones
 * (AD-1: coding-agent owns these settings; codemode declares none). Invalid values throw
 * `ComputerSettingsError`, which leaves the tool unregistered.
 */
export function loadComputerSettings(ctx: ExtensionContext, platform: string): ComputerSettings {
	const manager = SettingsManager.create(ctx.cwd, ctx.agentDir, { projectTrusted: ctx.isProjectTrusted() });
	const global = computerBlock(manager.getGlobalSettings());
	const project = computerBlock(manager.getProjectSettings());
	const merged = isRecord(global) && isRecord(project) ? { ...global, ...project } : (project ?? global);
	return resolveComputerSettings(merged, platform);
}
