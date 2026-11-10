import type { AgentSessionRuntimeDiagnostic } from "../../core/agent-session-services.ts";
import { presetTrustsProject, resolveProjectTrusted } from "../../core/project-trust.ts";
import type { ResourceLoaderReloadOptions } from "../../core/resource-loader.ts";
import { sessionExtensionFlagValues } from "../../core/session-extension-flags.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	getSavedProjectTrust,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../../core/trust-manager.ts";
import { createProjectTrustContext } from "../../cli/project-trust.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";
import type { Args } from "../../cli/args.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { LooplessRuntimeProfile } from "./runtime-factory-loopless.ts";

export interface LooplessRuntimeSettings {
	readonly settingsManager: SettingsManager;
	readonly flagValues: Map<string, boolean | string>;
	readonly reloadOptions: ResourceLoaderReloadOptions | undefined;
}

/**
 * The project trust a session opened from this configuration would get, decided without a UI: a runtime without a
 * loop has no one to ask, exactly like an RPC worker today (`createCliRuntimeFactory`, main.ts). A `project_trust`
 * handler's error is reported to `diagnostics`, as the CLI factory reports it.
 */
export async function resolveLooplessSettings(
	configuration: CliRuntimeConfiguration,
	startupSettingsManager: SettingsManager,
	profile: LooplessRuntimeProfile,
	diagnostics: AgentSessionRuntimeDiagnostic[],
): Promise<LooplessRuntimeSettings> {
	const { parsed, agentDir, appMode } = configuration;
	const { cwd, launchProfile } = profile;
	const trustStore = new ProjectTrustStore(agentDir);
	const flagValues = sessionExtensionFlagValues(parsed.unknownFlags, launchProfile);
	const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
	const savedProjectTrust = await getSavedProjectTrust(trustStore, cwd);
	const globalPreset = (startupSettingsManager.getGlobalSettings() as { readonly permissionPreset?: unknown })
		.permissionPreset;
	const fullAccessTrust =
		presetTrustsProject(flagValues.get("permission-preset"), globalPreset) && savedProjectTrust !== false;
	const shouldResolveProjectTrust =
		parsed.projectTrustOverride === undefined && !fullAccessTrust && hasTrustRequiringResources;
	const projectTrusted = shouldResolveProjectTrust
		? false
		: (parsed.projectTrustOverride ?? (fullAccessTrust || !hasTrustRequiringResources || savedProjectTrust === true));
	const trustFromFullAccess =
		fullAccessTrust &&
		hasTrustRequiringResources &&
		parsed.projectTrustOverride === undefined &&
		savedProjectTrust !== true;
	const settingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted,
		trustFromFullAccess,
		projectTrustLocked: parsed.projectTrustOverride !== undefined,
	});
	const reloadOptions: ResourceLoaderReloadOptions | undefined = shouldResolveProjectTrust
		? {
				resolveProjectTrust: ({ extensionsResult }) =>
					resolveProjectTrusted({
						cwd,
						trustStore,
						trustOverride: parsed.projectTrustOverride,
						defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
						extensionsResult,
						projectTrustContext: createProjectTrustContext({
							cwd,
							mode: appMode,
							settingsManager: startupSettingsManager,
							hasUI: false,
						}),
						onExtensionError: (message) => diagnostics.push({ type: "warning", message }),
					}),
			}
		: undefined;
	return { settingsManager, flagValues, reloadOptions };
}

export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

export interface LooplessToolFilters {
	readonly defaultToolNames?: ReadonlySet<string>;
	readonly allowedToolNames?: ReadonlySet<string>;
	readonly excludedToolNames?: ReadonlySet<string>;
}

/**
 * The CLI's tool filters (`--tools`, `--no-tools`, `--no-builtin-tools`, `--exclude-tools`, settings `defaultTools`),
 * mapped as `main.ts` maps them and resolved as `createAgentSession` resolves them (sdk.ts), so a loopless runtime
 * registers exactly the tools a session registers for the same flags and settings.
 */
export function looplessToolFilters(parsed: Args, settingsManager: SettingsManager): LooplessToolFilters {
	const noTools = parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined;
	const defaultToolNames =
		parsed.tools === undefined && noTools === undefined ? settingsManager.getDefaultTools() : undefined;
	const allowedToolNames = parsed.tools ?? (noTools === "all" ? [] : undefined);
	return {
		...(defaultToolNames === undefined ? {} : { defaultToolNames: new Set(defaultToolNames) }),
		...(allowedToolNames === undefined ? {} : { allowedToolNames: new Set(allowedToolNames) }),
		...(parsed.excludeTools === undefined ? {} : { excludedToolNames: new Set(parsed.excludeTools) }),
	};
}
