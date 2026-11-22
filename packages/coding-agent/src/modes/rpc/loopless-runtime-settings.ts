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
import type { LooplessRuntimeProfile } from "./loopless-runtime.ts";
import { resolveToolSelection } from "../../core/runtime/active-tools.ts";

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

export interface LooplessToolSelection {
	/** The registry filters, as a session applies them. */
	readonly filters: LooplessToolFilters;
	/** The active set a session would request for the same flags and settings. */
	readonly initialActiveToolNames: readonly string[];
}

/**
 * The CLI's tool filters (`--tools`, `--no-tools`, `--no-builtin-tools`, `--exclude-tools`, settings `defaultTools`),
 * mapped as `main.ts` maps them and resolved by `resolveToolSelection`, as `createAgentSession` resolves them, so a
 * loopless runtime registers exactly the tools a session registers for the same flags and settings and knows the active
 * set that session would request.
 */
export function looplessToolSelection(parsed: Args, settingsManager: SettingsManager): LooplessToolSelection {
	const noTools = parsed.noTools ? "all" : parsed.noBuiltinTools ? "builtin" : undefined;
	const { defaultToolNames, allowedToolNames, excludedToolNames, initialActiveToolNames } = resolveToolSelection(
		{ tools: parsed.tools, noTools, excludeTools: parsed.excludeTools },
		settingsManager.getDefaultTools(),
	);
	return {
		filters: {
			...(defaultToolNames === undefined ? {} : { defaultToolNames: new Set(defaultToolNames) }),
			...(allowedToolNames === undefined ? {} : { allowedToolNames: new Set(allowedToolNames) }),
			...(excludedToolNames === undefined ? {} : { excludedToolNames: new Set(excludedToolNames) }),
		},
		initialActiveToolNames,
	};
}
