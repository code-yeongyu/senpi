/**
 * Which registered tools a session shows its model, and which it routes through `eval` (senpi#6749). AgentSession
 * decides its active set with these functions, and a hand (the loopless runtime) answers a remote loop's
 * `describe_tools` with the same ones, so both report one active set for the same registry, flags and settings.
 */
import { deriveExtensionRegistrationId } from "../extensions/builtin/tool-search/engine/marker.ts";
import { normalizeToolExposure, type ToolExposure } from "../extensions/types.ts";
import { DEFAULT_TOOL_NAMES } from "../settings-manager.ts";
import type { ToolDefinitionEntry, ToolRegistryBuild } from "./bootstrap.ts";

type ToolDefinitions = ReadonlyMap<string, ToolDefinitionEntry>;

/** Externally registered tools routed through eval in addition to declared eval exposure. */
const EVAL_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["workflow", "monitor"]);

/** The tool that arms the eval-only routing: while it is registered, eval-only tools leave the direct list. */
const EVAL_TOOL_NAME = "eval";

/** Normalized exposure of a registered tool (C-EX-1); a name without a definition is `direct`. */
export function toolExposureOf(definitions: ToolDefinitions, name: string): ToolExposure {
	const entry = definitions.get(name);
	return entry ? normalizeToolExposure(entry.definition).exposure : "direct";
}

/**
 * Whether registering the tool activates it: `direct`, `eval` and `model-only` tools, unless the
 * definition sets `defaultActive: false`. `search` tools activate lazily; `hidden` tools never do.
 */
function isActivatedOnRegistration(definitions: ToolDefinitions, name: string): boolean {
	const entry = definitions.get(name);
	if (!entry) return false;
	const exposure = normalizeToolExposure(entry.definition).exposure;
	return (
		(exposure === "direct" || exposure === "eval" || exposure === "model-only") &&
		entry.definition.defaultActive !== false
	);
}

/** Fixed and declared eval-only tools, unless an SDK embedder supplied an override. */
export function resolveEvalOnlyToolNames(
	definitions: ToolDefinitions,
	override: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
	const declaredEvalNames = [...definitions.values()]
		.filter(({ definition }) => normalizeToolExposure(definition).exposure === "eval")
		.map(({ definition }) => definition.name);
	return override ?? new Set([...EVAL_ONLY_TOOL_NAMES, ...declaredEvalNames]);
}

/** The eval-only names while an `eval` tool is registered (the routing is armed); `undefined` while it is not. */
export function armedEvalOnlyToolNames(
	evalOnly: ReadonlySet<string> | undefined,
	toolRegistry: ReadonlyMap<string, unknown>,
): ReadonlySet<string> | undefined {
	return evalOnly !== undefined && toolRegistry.has(EVAL_TOOL_NAME) ? evalOnly : undefined;
}

/** The registered tools the armed eval-only routing withholds from the model; empty while it is not armed. */
export function registeredEvalOnlyToolNames(
	armedEvalOnly: ReadonlySet<string> | undefined,
	toolRegistry: ReadonlyMap<string, unknown>,
): ReadonlySet<string> {
	return new Set([...(armedEvalOnly ?? [])].filter((name) => toolRegistry.has(name)));
}

/** The tool flags a session is created with (`--tools`, `--no-tools`, `--no-builtin-tools`, `--exclude-tools`). */
export interface ToolSelection {
	readonly tools?: readonly string[] | undefined;
	readonly noTools?: "all" | "builtin" | undefined;
	readonly excludeTools?: readonly string[] | undefined;
}

export interface ResolvedToolSelection {
	/** Builtin-extension tools outside this set are not registered; absent means all of them. */
	readonly defaultToolNames: string[] | undefined;
	readonly allowedToolNames: string[] | undefined;
	readonly excludedToolNames: string[] | undefined;
	/** The active set a new session requests before its extension tools join it. */
	readonly initialActiveToolNames: string[];
}

/** Resolves the tool flags with the settings' `defaultTools`, as `createAgentSession` does. */
export function resolveToolSelection(
	selection: ToolSelection,
	configuredDefaultToolNames: readonly string[] | undefined,
): ResolvedToolSelection {
	const { tools, noTools, excludeTools } = selection;
	const excluded = excludeTools ? new Set(excludeTools) : undefined;
	return {
		defaultToolNames:
			tools === undefined && noTools === undefined && configuredDefaultToolNames
				? [...configuredDefaultToolNames]
				: undefined,
		allowedToolNames: tools ? [...tools] : noTools === "all" ? [] : undefined,
		excludedToolNames: excludeTools ? [...excludeTools] : undefined,
		initialActiveToolNames: (tools ?? (noTools ? [] : (configuredDefaultToolNames ?? DEFAULT_TOOL_NAMES))).filter(
			(name) => !excluded?.has(name),
		),
	};
}

export interface ActiveToolRequest {
	/** The names asked for: the caller's explicit list, else the session's previous request. */
	readonly requested: readonly string[];
	/** Whether `requested` is the caller's explicit list; a refresh without one adds newly registered tools. */
	readonly explicit: boolean;
	readonly includeAllExtensionTools?: boolean | undefined;
	/** On a reload, a requested tool stays only while the same registration provides it. */
	readonly previousRegistrationIds?: ReadonlyMap<string, string> | undefined;
	/** Tools to activate that were not active before, such as tools newly added to `defaultTools`. */
	readonly addedToolNames?: readonly string[] | undefined;
	readonly previousRegistryNames: ReadonlySet<string>;
	readonly allowedToolNames?: ReadonlySet<string> | undefined;
}

/** The names a registry refresh asks to activate, before the eval-only routing and exposure narrow them. */
export function requestedActiveToolNames(registry: ToolRegistryBuild, request: ActiveToolRequest): string[] {
	const { definitions, isAllowedTool, toolRegistry } = registry;
	const { previousRegistrationIds, allowedToolNames } = request;
	const names = request.requested.filter((name) => {
		if (!isAllowedTool(name)) return false;
		if (!previousRegistrationIds) return true;
		const current = definitions.get(name);
		return (
			current !== undefined &&
			previousRegistrationIds.get(name) === deriveExtensionRegistrationId(current.sourceInfo, name)
		);
	});
	// Newly added tools had no previous registration to match, so they skip the identity check.
	for (const name of request.addedToolNames ?? []) {
		if (isAllowedTool(name)) names.push(name);
	}
	if (allowedToolNames) {
		for (const name of toolRegistry.keys()) {
			// Naming a tool activates it even when it is not active by default; a hidden tool never is.
			if (allowedToolNames.has(name) && toolExposureOf(definitions, name) !== "hidden") names.push(name);
		}
	} else if (request.includeAllExtensionTools) {
		for (const tool of registry.extensionTools) {
			if (isActivatedOnRegistration(definitions, tool.name)) names.push(tool.name);
		}
	} else if (!request.explicit) {
		for (const name of toolRegistry.keys()) {
			if (!request.previousRegistryNames.has(name) && isActivatedOnRegistration(definitions, name)) names.push(name);
		}
	}
	return [...new Set(names)];
}

export interface DirectActiveTools {
	/** The tools the model calls directly, in request order. */
	readonly active: string[];
	/** Requested tools held back by the armed eval-only routing. */
	readonly withheld: string[];
}

/** Narrows requested names to the model's direct tools: registered, not hidden, and not routed through eval. */
export function directActiveToolNames(
	requested: readonly string[],
	registry: Pick<ToolRegistryBuild, "definitions" | "toolRegistry">,
	armedEvalOnly: ReadonlySet<string> | undefined,
): DirectActiveTools {
	return {
		active: requested.filter(
			(name) =>
				!armedEvalOnly?.has(name) &&
				registry.toolRegistry.has(name) &&
				toolExposureOf(registry.definitions, name) !== "hidden",
		),
		withheld: armedEvalOnly ? requested.filter((name) => armedEvalOnly.has(name)) : [],
	};
}
