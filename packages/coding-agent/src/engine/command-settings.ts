import { createProjectTrustContext } from "../cli/project-trust.ts";
import type { InlineExtension } from "../core/extensions/types.ts";
import { type AppMode, resolveProjectTrusted } from "../core/project-trust.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../core/trust-manager.ts";
import type { EngineDiagnostic } from "./result.ts";

/** Where a package or resource command runs: the project directory, the agent directory, and the built-in extensions. */
export interface EngineCommandScope {
	readonly cwd: string;
	readonly agentDir: string;
	readonly extensionFactories: readonly InlineExtension[];
}

export interface CommandSettings {
	readonly settingsManager: SettingsManager;
	readonly trustDiagnostics: readonly EngineDiagnostic[];
}

function commandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

/**
 * The settings a one-shot package or resource command reads, with the project trusted as `trust` says,
 * as the saved trust says, or as the trust decision of an interactive launch would.
 */
export async function openCommandSettings(
	scope: EngineCommandScope,
	options: { readonly trust?: boolean; readonly useSavedProjectTrustOnly?: boolean },
): Promise<CommandSettings> {
	const settingsManager = SettingsManager.create(scope.cwd, scope.agentDir, { projectTrusted: false });
	const trustDiagnostics: EngineDiagnostic[] = [];
	const warn = (message: string) => trustDiagnostics.push({ kind: "project_trust", message });
	const trustStore = new ProjectTrustStore(scope.agentDir);
	if (options.useSavedProjectTrustOnly) {
		settingsManager.setProjectTrusted(options.trust ?? trustStore.get(scope.cwd) === true);
		return { settingsManager, trustDiagnostics };
	}

	const appMode = commandAppMode();
	const extensionsResult =
		options.trust === undefined && hasTrustRequiringProjectResources(scope.cwd)
			? await new DefaultResourceLoader({
					cwd: scope.cwd,
					agentDir: scope.agentDir,
					settingsManager,
					extensionFactories: [...scope.extensionFactories],
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) warn(`Failed to load extension "${error.path}": ${error.error}`);

	const projectTrusted = await resolveProjectTrusted({
		cwd: scope.cwd,
		trustStore,
		trustOverride: options.trust,
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
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, trustDiagnostics };
}

/** Drains the settings manager's load errors as diagnostics, labelled with the command that read them. */
export function settingsDiagnostics(settingsManager: SettingsManager, context: string): EngineDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		kind: "settings",
		context,
		scope,
		message: error.message,
		...(error.stack ? { stack: error.stack } : {}),
	}));
}
