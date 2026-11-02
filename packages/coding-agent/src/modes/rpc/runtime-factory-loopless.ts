import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentSessionLaunchProfile } from "../../core/agent-session-runtime.ts";
import { type AgentSessionRuntimeDiagnostic, createAgentSessionServices } from "../../core/agent-session-services.ts";
import type { InlineExtension } from "../../core/extensions/types.ts";
import { bootstrapRuntime, buildToolRegistry, type ToolDefinitionEntry } from "../../core/runtime/bootstrap.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { childModuleRoots } from "../../core/tool-dispatch/offload.ts";
import { createToolChildRuntime } from "../../core/tool-dispatch/tool-child-runtime.ts";
import { builtInExtensions } from "../../extensions/index.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { looplessToolFilters, resolveCliPaths, resolveLooplessSettings } from "./loopless-runtime-settings.ts";
import { runLooplessToolCall } from "./loopless-tool-call.ts";
import { toolChildModuleRoots } from "./tool-child/session-child.ts";

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
	/** What building the runtime reported: settings, extension load and `project_trust` handler diagnostics. */
	readonly diagnostics: readonly AgentSessionRuntimeDiagnostic[];
	/**
	 * Runs one tool call: argument preparation and schema validation as the loop does, then the tool. An unknown
	 * name is refused before anything runs; invalid arguments and a failing tool come back as an `isError` result.
	 *
	 * It does NOT run the extensions' `tool_call`/`tool_result` handlers (permission checks among them): where those
	 * run for a call that reaches a tool-execution-only process is decided by the remote tool executor that calls
	 * this runtime, including forwarding a two-sided extension's handlers to the process that owns the session.
	 * Until that executor exists nothing may route an untrusted call here.
	 */
	execute(name: string, toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>>;
	/** Marks its extension contexts stale, then closes the tool work and the tool child it still runs. */
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
 * Builds loopless runtimes from the same launch configuration as `createCliRuntimeFactory`: the same
 * cwd-bound services (settings, project trust, model registry, extensions and their flags), then the tool
 * registry through `bootstrapRuntime()` / `buildToolRegistry()` (senpi#5222) on a runner without a session
 * (senpi#5223), so nothing is ever written to a session file. Tools are placed by the same tool-child runtime
 * a session builds (senpi#5227), so `--tool-runtime child` runs child-placed work on this runtime's own child.
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
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const { settingsManager, flagValues, reloadOptions } = await resolveLooplessSettings(
			configuration,
			startupSettingsManager,
			profile,
			diagnostics,
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
		const extensionsResult = services.resourceLoader.getExtensions();
		diagnostics.push(
			...services.diagnostics,
			...extensionsResult.errors.map(({ path, error }) => ({
				type: "warning" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
			...(extensionsResult.warnings ?? []).map(({ path, warning }) => ({
				type: "warning" as const,
				message: `Extension package "${path}": ${warning}`,
			})),
		);
		let execute: LooplessRuntime["execute"] = () => Promise.reject(new Error("Loopless runtime is not ready"));
		let toolNames: () => readonly string[] = () => [];
		const toolChildRuntime = createToolChildRuntime({
			toolRuntime: toolRuntime ?? "in-process",
			agentDir,
			scopeId: `loopless-${randomUUID()}`,
			cwd: services.cwd,
			moduleRoots: () => [
				...toolChildModuleRoots(runtime.extensionRunner.getAllRegisteredTools()),
				...childModuleRoots(runtime.extensionRunner.getAllChildModules()),
			],
			hostCallDeps: {
				cwd: services.cwd,
				executeNested: async (_parentToolCallId, name, args, signal) => {
					const toolCall = { type: "toolCall" as const, id: `nested-${randomUUID()}`, name, arguments: {} };
					const result = await execute(name, toolCall.id, args, signal);
					return { toolCall, result, isError: result.isError === true };
				},
				callableToolNames: () => toolNames(),
				target: () => undefined,
				filesystemPolicy: () => runtime.filesystemPolicy,
			},
			onRecord: () => {},
		});
		const { dispatcher, toolChild } = toolChildRuntime;
		const runtime = bootstrapRuntime({
			cwd: services.cwd,
			settingsManager: services.settingsManager,
			extensionsResult,
			modelRegistry: services.modelRegistry,
			toolDispatcher: dispatcher,
		});
		const registry = buildToolRegistry({
			baseToolDefinitions: runtime.baseToolDefinitions,
			runner: runtime.extensionRunner,
			dispatcher,
			...looplessToolFilters(parsed, services.settingsManager),
		});
		toolNames = () => [...registry.toolRegistry.keys()];
		execute = (name, toolCallId, params, signal) => {
			const tool = registry.toolRegistry.get(name);
			if (tool === undefined) return Promise.reject(new LooplessToolNotFoundError(name));
			return runLooplessToolCall(tool, {
				toolCallId,
				params,
				...(signal ? { signal } : {}),
			});
		};
		return {
			cwd: services.cwd,
			definitions: registry.definitions,
			diagnostics,
			execute: (name, toolCallId, params, signal) => execute(name, toolCallId, params, signal),
			dispose: async () => {
				// Stale first, as a session disposes: a close that fails must not leave the contexts usable.
				runtime.extensionRunner.invalidate("This loopless runtime was disposed.");
				// Both closes run to the end; the first failure is then reported to the caller.
				const closed = await Promise.allSettled([dispatcher.dispose(), toolChild?.close()]);
				const failure = closed.find((outcome) => outcome.status === "rejected");
				if (failure !== undefined) throw failure.reason;
			},
		};
	};
}
