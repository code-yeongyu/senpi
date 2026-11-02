import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	ExtensionRunner,
	type LoadExtensionsResult,
	type RegisteredTool,
	type ToolDefinition,
	wrapRegisteredTools,
} from "../extensions/index.ts";
import type { ExtensionContext, FilesystemPolicyChecker } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { BUILTIN_PATH_PREFIX, createSyntheticSourceInfo, type SourceInfo } from "../source-info.ts";
import type { ToolDispatcher } from "../tool-dispatch/tool-dispatcher.ts";
import { composeFilesystemPolicies } from "../tools/filesystem-policy.ts";
import { createAllToolDefinitions } from "../tools/index.ts";
import { createToolDefinitionFromAgentTool } from "../tools/tool-definition-wrapper.ts";

export interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

export type ToolContextFactory = (signal: AbortSignal | undefined) => {
	readonly context: ExtensionContext;
	dispose(): void;
};

export interface RuntimeBootstrapOptions {
	cwd: string;
	settingsManager: SettingsManager;
	/** The loaded extensions; their runtime is shared with the runner this bootstrap creates. */
	extensionsResult: LoadExtensionsResult;
	modelRegistry: ModelRegistry;
	/** Defaults to an in-memory session manager, for a runtime that owns no session. */
	sessionManager?: SessionManager;
	/** Routes the core bash tool's process work; absent means the tool's own local operations. */
	toolDispatcher?: ToolDispatcher;
	/** Used instead of the built-in tools when set. */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Extension flag values applied to the shared extension runtime before the runner is created. */
	flagValues?: ReadonlyMap<string, boolean | string>;
}

export interface RuntimeBootstrap {
	filesystemPolicy: FilesystemPolicyChecker | undefined;
	baseToolDefinitions: Map<string, ToolDefinition>;
	extensionRunner: ExtensionRunner;
}

/**
 * Build the parts of the runtime that do not depend on an agent loop or a session: the built-in tool
 * definitions, the composed filesystem policy and the extension runner (senpi#5219).
 */
export function bootstrapRuntime(options: RuntimeBootstrapOptions): RuntimeBootstrap {
	const { cwd, settingsManager, extensionsResult } = options;
	const filesystemPolicy = composeFilesystemPolicies(
		extensionsResult.extensions.flatMap((extension) => extension.filesystemPolicies ?? []),
	);
	const shellPath = settingsManager.getShellPath();
	const baseToolDefinitions = options.baseToolsOverride
		? Object.fromEntries(
				Object.entries(options.baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			)
		: createAllToolDefinitions(cwd, {
				read: { autoResizeImages: settingsManager.getImageAutoResize(), filesystemPolicy },
				// The core bash tool's process work goes through the dispatcher's operations: the same
				// local operations under in-process, and the tool child's user.bash job under child
				// (senpi#3566 todo 9), while truncation and rendering stay on the server.
				bash: {
					commandPrefix: settingsManager.getShellCommandPrefix(),
					redactSecretsInOutput: settingsManager.getBashRedactSecretsInOutput(),
					shellPath,
					...(options.toolDispatcher ? { operations: options.toolDispatcher.bashOperations({ shellPath }) } : {}),
				},
				write: { filesystemPolicy },
				edit: { filesystemPolicy },
				grep: { filesystemPolicy },
				find: { filesystemPolicy },
				glob: { filesystemPolicy },
				ls: { filesystemPolicy },
			});
	if (options.flagValues) {
		for (const [name, value] of options.flagValues) {
			extensionsResult.runtime.flagValues.set(name, value);
		}
	}
	const extensionRunner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		cwd,
		options.sessionManager ?? SessionManager.inMemory(cwd),
		options.modelRegistry,
		extensionsResult.eventBus,
	);
	return {
		filesystemPolicy,
		baseToolDefinitions: new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		),
		extensionRunner,
	};
}

export function isBuiltinExtensionPath(path: string): boolean {
	return (
		path.startsWith("<builtin:") || path.startsWith(BUILTIN_PATH_PREFIX) || /[\\/]senpi-codemode[\\/]/u.test(path)
	);
}

export interface ToolRegistryInput {
	baseToolDefinitions: ReadonlyMap<string, ToolDefinition>;
	runner: ExtensionRunner;
	/** SDK tools (`CreateAgentSessionOptions.customTools`); they replace same-named tools. */
	customTools?: readonly ToolDefinition[];
	/** Builtin-extension tools outside this set are not registered; absent means all of them. */
	defaultToolNames?: ReadonlySet<string>;
	allowedToolNames?: ReadonlySet<string>;
	excludedToolNames?: ReadonlySet<string>;
	createToolContext?: ToolContextFactory;
	dispatcher?: ToolDispatcher;
}

export interface ToolRegistryBuild {
	/** Every allowed definition: built-ins first, then extension and SDK tools, a later name replacing an earlier one. */
	definitions: Map<string, ToolDefinitionEntry>;
	/** The wrapped extension and SDK tools, in registration order. */
	extensionTools: AgentTool[];
	/** The executable tools by name: wrapped built-ins, then wrapped extension and SDK tools. */
	toolRegistry: Map<string, AgentTool>;
	isAllowedTool(name: string): boolean;
}

/**
 * Merge the built-in, extension and SDK tools, apply the default/allowed/excluded filters and wrap each
 * tool for execution. AgentSession builds its registry through this, and so does a runtime without a
 * session (senpi#5219).
 */
export function buildToolRegistry(input: ToolRegistryInput): ToolRegistryBuild {
	const { allowedToolNames, excludedToolNames, defaultToolNames } = input;
	const isAllowedTool = (name: string): boolean =>
		(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

	const registeredTools = input.runner.getAllRegisteredTools();
	const isConfiguredBuiltinTool = (tool: RegisteredTool): boolean =>
		(tool.sourceInfo.source !== "builtin" && !isBuiltinExtensionPath(tool.sourceInfo.path)) ||
		defaultToolNames === undefined ||
		defaultToolNames.has(tool.definition.name);
	const allCustomTools: RegisteredTool[] = [
		...registeredTools.filter(isConfiguredBuiltinTool),
		...(input.customTools ?? []).map((definition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
				source: "sdk",
			}),
		})),
	].filter((tool) => isAllowedTool(tool.definition.name));
	const definitions = new Map<string, ToolDefinitionEntry>(
		Array.from(input.baseToolDefinitions.entries())
			.filter(([name]) => isAllowedTool(name))
			.map(([name, definition]) => [
				name,
				{
					definition,
					sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${name}`, {
						source: "builtin",
					}),
				},
			]),
	);
	for (const tool of allCustomTools) {
		definitions.set(tool.definition.name, {
			definition: tool.definition,
			sourceInfo: tool.sourceInfo,
		});
	}

	const extensionTools = wrapRegisteredTools(allCustomTools, input.runner, input.createToolContext, input.dispatcher);
	const builtInTools = wrapRegisteredTools(
		Array.from(input.baseToolDefinitions.values())
			.filter((definition) => isAllowedTool(definition.name))
			.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`${BUILTIN_PATH_PREFIX}${definition.name}`, {
					source: "builtin",
				}),
			})),
		input.runner,
		input.createToolContext,
		input.dispatcher,
	);
	const toolRegistry = new Map(builtInTools.map((tool) => [tool.name, tool]));
	for (const tool of extensionTools) {
		toolRegistry.set(tool.name, tool);
	}
	return { definitions, extensionTools, toolRegistry, isAllowedTool };
}
