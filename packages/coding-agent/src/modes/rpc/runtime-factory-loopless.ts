import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSessionLaunchProfile } from "../../core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../../core/agent-session-services.ts";
import type { InlineExtension } from "../../core/extensions/types.ts";
import { presetTrustsProject, resolveProjectTrusted } from "../../core/project-trust.ts";
import type { ResourceLoaderReloadOptions } from "../../core/resource-loader.ts";
import { bootstrapRuntime, buildToolRegistry, type ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";
import { sessionExtensionFlagValues } from "../../core/session-extension-flags.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { createToolDispatcher } from "../../core/tool-dispatch/tool-dispatcher.ts";
import {
	getSavedProjectTrust,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "../../core/trust-manager.ts";
import { createProjectTrustContext } from "../../cli/project-trust.ts";
import { isLocalPath, resolvePath } from "../../utils/paths.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";

/**
 * A session worker's runtime with the agent loop removed (brain/hand split, senpi#5413): the same
 * built-in and extension tools a full session serves, executed one call at a time, with no agent loop,
 * no model binding and no transcript. Its extension runtime is never bound to a loop, so an extension
 * that tries to drive one (`pi.sendUserMessage`, `pi.setModel`, ...) is refused.
 */
export interface LooplessRuntime {
	readonly cwd: string;
	/** Every tool this runtime serves: built-ins first, then extension tools, a later name replacing an earlier one. */
	readonly definitions: ReadonlyMap<string, ToolDefinitionEntry>;
	/** Runs one tool call; an unknown name is refused before anything runs. */
	execute(name: string, toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
	/** Closes the tool work this runtime still runs and marks its extension contexts stale. */
	dispose(): Promise<void>;
}

export interface LooplessRuntimeProfile {
	cwd: string;
	launchProfile?: Readonly<AgentSessionLaunchProfile>;
}

export type LooplessRuntimeFactory = (profile: LooplessRuntimeProfile) => Promise<LooplessRuntime>;

export class LooplessToolNotFoundError extends Error {
	readonly toolName: string;
	constructor(toolName: string) {
		super(`loopless_tool_not_found: ${toolName}`);
		this.toolName = toolName;
	}
}

/**
 * The project trust a session opened from this configuration would get, decided without a UI: a runtime
 * without a loop has no one to ask, exactly like an RPC worker today (`createCliRuntimeFactory`, main.ts).
 */
async function resolveRuntimeSettings(
	configuration: CliRuntimeConfiguration,
	startupSettingsManager: SettingsManager,
	profile: LooplessRuntimeProfile,
): Promise<{
	settingsManager: SettingsManager;
	flagValues: Map<string, boolean | string>;
	reloadOptions: ResourceLoaderReloadOptions | undefined;
}> {
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
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted, trustFromFullAccess });
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
					}),
			}
		: undefined;
	return { settingsManager, flagValues, reloadOptions };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/**
 * Builds loopless runtimes from the same launch configuration as `createCliRuntimeFactory`: the same
 * cwd-bound services (settings, project trust, model registry, extensions and their flags), then the tool
 * registry through `bootstrapRuntime()` / `buildToolRegistry()` (senpi#5222) on a runner without a session
 * (senpi#5223), so nothing is ever written to a session file.
 */
export function createLooplessRuntimeFactory(
	configuration: CliRuntimeConfiguration,
	local: { extensionFactories?: InlineExtension[]; startupSettingsManager?: SettingsManager } = {},
): LooplessRuntimeFactory {
	const { parsed, agentDir, toolRuntime } = configuration;
	const extensionFactories = local.extensionFactories ?? builtInExtensions;
	const startupSettingsManager =
		local.startupSettingsManager ?? SettingsManager.create(configuration.cwd, configuration.agentDir);
	return async (profile) => {
		const { cwd } = profile;
		const { settingsManager, flagValues, reloadOptions } = await resolveRuntimeSettings(
			configuration,
			startupSettingsManager,
			profile,
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager,
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: flagValues,
			...(reloadOptions ? { resourceLoaderReloadOptions: reloadOptions } : {}),
			resourceLoaderOptions: {
				sessionKind: profile.launchProfile?.sessionKind,
				sessionContext: profile.launchProfile?.sessionContext,
				additionalExtensionPaths: resolveCliPaths(cwd, parsed.extensions),
				additionalSkillPaths: resolveCliPaths(cwd, parsed.skills),
				additionalPromptTemplatePaths: resolveCliPaths(cwd, parsed.promptTemplates),
				additionalThemePaths: resolveCliPaths(cwd, parsed.themes),
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				extensionFactories,
			},
		});
		const dispatcher = createToolDispatcher({ runtime: toolRuntime ?? "in-process" });
		const runtime = bootstrapRuntime({
			cwd: services.cwd,
			settingsManager: services.settingsManager,
			extensionsResult: services.resourceLoader.getExtensions(),
			modelRegistry: services.modelRegistry,
			toolDispatcher: dispatcher,
		});
		const registry = buildToolRegistry({
			baseToolDefinitions: runtime.baseToolDefinitions,
			runner: runtime.extensionRunner,
			dispatcher,
		});
		return {
			cwd: services.cwd,
			definitions: registry.definitions,
			execute: (name, toolCallId, params, signal) => {
				const tool = registry.toolRegistry.get(name);
				if (tool === undefined) return Promise.reject(new LooplessToolNotFoundError(name));
				return tool.execute(toolCallId, params, signal, undefined);
			},
			dispose: async () => {
				await dispatcher.dispose();
				runtime.extensionRunner.invalidate("This loopless runtime was disposed.");
			},
		};
	};
}
