import type { InlineExtension } from "../core/extensions/types.ts";
import { type AppMode, resolveProjectTrusted } from "../core/project-trust.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import type { ProjectTrustDecider } from "../engine/command-settings.ts";
import type { EngineDiagnostic } from "../engine/result.ts";
import { createProjectTrustContext } from "./project-trust.ts";

function commandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

/**
 * The package and config commands' project-trust decision when no `--approve`/`--no-approve` was given:
 * project-trust extensions, the saved decision, the default setting, and on a terminal the prompt.
 */
export function cliTrustDecider(scope: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly extensionFactories: readonly InlineExtension[];
}): ProjectTrustDecider {
	return async (settingsManager: SettingsManager) => {
		const diagnostics: EngineDiagnostic[] = [];
		const warn = (message: string) => diagnostics.push({ kind: "project_trust", message });
		const appMode = commandAppMode();
		const extensionsResult = hasTrustRequiringProjectResources(scope.cwd)
			? await new DefaultResourceLoader({
					cwd: scope.cwd,
					agentDir: scope.agentDir,
					settingsManager,
					extensionFactories: [...scope.extensionFactories],
				}).loadProjectTrustExtensions()
			: undefined;
		for (const error of extensionsResult?.errors ?? [])
			warn(`Failed to load extension "${error.path}": ${error.error}`);
		const trusted = await resolveProjectTrusted({
			cwd: scope.cwd,
			trustStore: new ProjectTrustStore(scope.agentDir),
			trustOverride: undefined,
			defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
			extensionsResult,
			projectTrustContext: createProjectTrustContext({
				cwd: scope.cwd,
				mode: appMode,
				settingsManager,
				hasUI: appMode === "interactive",
			}),
			onExtensionError: warn,
		});
		return { trusted, diagnostics };
	};
}

/** The trust `update` uses: the flag, else the saved decision for this folder, never a prompt. */
export function savedProjectTrust(cwd: string, agentDir: string, override: boolean | undefined): boolean {
	return override ?? new ProjectTrustStore(agentDir).get(cwd) === true;
}
