/**
 * The tool list a hand's machine would show the model of a local session there, for a loop that runs elsewhere and
 * runs its tools on this hand (senpi#6749, S-CAT). A loop asks with the `describe_tools` loop hook on a scope; the hand
 * answers from that scope's runtime, with the session's own registry build, active-set and eval-only rules
 * (`core/runtime/active-tools.ts`) and the catalog projection both placements share (`modes/hand/tool-catalog.ts`).
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ResourceLoader } from "../../core/resource-loader.ts";
import {
	armedEvalOnlyToolNames,
	directActiveToolNames,
	registeredEvalOnlyToolNames,
	requestedActiveToolNames,
	resolveEvalOnlyToolNames,
} from "../../core/runtime/active-tools.ts";
import type { ToolRegistryBuild } from "../../core/runtime/bootstrap.ts";
import { toolCatalog } from "../hand/tool-catalog.ts";
import type { LooplessLoopHooks } from "./loopless-loop-hooks.ts";

const DESCRIBE_TOOLS_EVENT = "describe_tools";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** What a runtime knows that a session on the same cwd, flags and settings would decide its tool list from. */
export interface HandToolCatalogSource {
	readonly registry: ToolRegistryBuild;
	readonly initialActiveToolNames: readonly string[];
	readonly allowedToolNames: ReadonlySet<string> | undefined;
	readonly resources: Pick<ResourceLoader, "getAgentsFiles" | "getSkills">;
}

/**
 * The answer to `describe_tools`: every tool this hand serves, as the catalog projection, nothing left out (a tool that
 * acts on the calling session says so with `sessionBound: true`, so the loop calls it with its session's state); the
 * subset a local session would make active at its start, before its extensions bind; the tools that session routes
 * through `eval`; and the machine's prompt resources (context files and skills) for the scope's cwd.
 */
function describeHandTools(source: HandToolCatalogSource): JsonValue {
	const { registry } = source;
	const requested = requestedActiveToolNames(registry, {
		requested: source.initialActiveToolNames,
		explicit: true,
		includeAllExtensionTools: true,
		previousRegistryNames: new Set(),
		allowedToolNames: source.allowedToolNames,
	});
	const armed = armedEvalOnlyToolNames(
		resolveEvalOnlyToolNames(registry.definitions, undefined),
		registry.toolRegistry,
	);
	const { active } = directActiveToolNames(requested, registry, armed);
	const evalOnly = [...registeredEvalOnlyToolNames(armed, registry.toolRegistry)];
	return JSON.parse(
		JSON.stringify({
			tools: toolCatalog(Array.from(registry.definitions.values(), ({ definition }) => definition)),
			active,
			evalOnly,
			context: {
				contextFiles: source.resources.getAgentsFiles().agentsFiles,
				skills: source.resources.getSkills().skills,
			},
		}),
	) as JsonValue;
}

/**
 * `hooks`, answering `describe_tools` itself: the catalog is no extension loop hook (no handler runs and nothing is
 * sent), so it is served by any hand, whether or not it is its extensions' home. The scope comes with the payload, as
 * for every loop hook; `sessionId` and `idle` are checked like theirs.
 */
export function withToolCatalog(hooks: LooplessLoopHooks, source: HandToolCatalogSource): LooplessLoopHooks {
	return async (event, payload) => {
		if (event !== DESCRIBE_TOOLS_EVENT) return hooks(event, payload);
		if (!isRecord(payload) || typeof payload.sessionId !== "string" || typeof payload.idle !== "boolean")
			throw new Error(`malformed ${DESCRIBE_TOOLS_EVENT} payload`);
		return describeHandTools(source);
	};
}
