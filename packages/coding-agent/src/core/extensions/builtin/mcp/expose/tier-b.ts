// Tier-B adaptive exposure wiring (todo 32).
//
// Completes exposure:"auto": a server whose filtered tool count exceeds
// searchThreshold enters SEARCH mode — the full catalog is registered but only
// directTools stay active. The shared tool-search builtin owns tool_search and
// MCP feeds its searchable documents and activation hook into that service.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../types.ts";
import type { ToolSearchDocument } from "../../tool-search/engine/document.ts";
import { deriveMcpRegistrationId } from "../../tool-search/engine/marker.ts";
import type { ToolSearchService } from "../../tool-search/service.ts";
import { registerToolsPreservingActiveSet } from "../active-set.ts";
import type { McpToolCatalogEntry } from "../catalog.ts";
import type { McpSettings } from "../config-schema.ts";
import { createMcpProxyTool } from "./proxy.ts";
import {
	buildMcpToolDefinitions,
	type McpToolDefinition,
	type McpToolDetails,
	mapMcpCatalogNames,
} from "./register.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;
type WarnFn = (message: string) => void;

export interface McpTierBRegistrationInput {
	/** Full catalog to register (all filtered tools across all servers). */
	readonly registeredEntries: readonly McpToolCatalogEntry[];
	/** Subset kept active immediately (direct-mode servers + directTools). */
	readonly activeEntries: readonly McpToolCatalogEntry[];
	/** True when at least one server resolved to search mode. */
	readonly searchMode: boolean;
	/** Tier-C proxy servers (todo 38): one always-active gateway tool each. */
	readonly proxyGateways?: readonly { server: string; entries: readonly McpToolCatalogEntry[] }[];
	/** Always-active utility tools (todo 39: mcp_list_resources/mcp_read_resource). */
	readonly utilityTools?: readonly McpToolDefinition[];
	readonly settings: McpSettings;
}

export interface SearchableMcpTool {
	readonly name: string;
	readonly toolName: string;
	readonly description?: string;
	readonly server: string;
}

export interface McpTierBRegistration {
	/** Searchable catalog (for reuse by /mcp status and list_changed). */
	readonly searchable: SearchableMcpTool[];
	/** Activate registered tools through the shared feeder hook. */
	activate(names: readonly string[]): void;
}

const managedNamesByRegistrar = new WeakMap<object, ReadonlySet<string>>();

/** Register MCP tools honouring Tier-B search mode + prompt-cache mitigations. */
export function registerMcpTierBTools(
	pi: McpToolRegistrar,
	input: McpTierBRegistrationInput,
	toolSearchService: ToolSearchService,
	warn?: WarnFn,
): McpTierBRegistration {
	const named = mapMcpCatalogNames(input.registeredEntries, warn);
	const searchable: SearchableMcpTool[] = named.map(({ entry, name }) => ({
		name,
		toolName: entry.tool,
		description: entry.description,
		server: entry.server,
	}));
	const documents: ToolSearchDocument[] = named.map(({ entry, name }) => ({
		name,
		label: entry.tool,
		aliases: [entry.tool],
		description: entry.description,
		keywords: [],
		source: "mcp",
		group: entry.server,
		ownerLabel: entry.server,
		registrationId: deriveMcpRegistrationId(entry.server, entry.tool),
	}));
	const fullDefs = buildMcpToolDefinitions(input.registeredEntries, warn);
	const fullByName = new Map(fullDefs.map((def) => [def.name, def] as const));
	const gatewayNames: string[] = [];
	for (const gateway of input.proxyGateways ?? []) {
		const tool = createMcpProxyTool(gateway.server, gateway.entries);
		pi.registerTool(tool);
		gatewayNames.push(tool.name);
	}
	for (const tool of input.utilityTools ?? []) {
		pi.registerTool(tool);
		gatewayNames.push(tool.name);
	}

	const activeMcpNames = [...mapMcpCatalogNames(input.activeEntries).map(({ name }) => name), ...gatewayNames];
	const managedNames = new Set([...fullDefs.map((def) => def.name), ...gatewayNames]);
	const previousManagedNames = managedNamesByRegistrar.get(pi as object) ?? new Set<string>();
	managedNamesByRegistrar.set(pi as object, managedNames);

	const stubSwap = input.searchMode && input.settings.stubSwap === true;
	const stubbed = new Set<string>();
	const registeredNames = new Set(fullDefs.map((def) => def.name));
	const catalogNames = new Set(toolSearchService.getCatalog().map((doc) => doc.name));

	const activate = (names: readonly string[]): void => {
		const known = [...new Set(names.filter((name) => registeredNames.has(name)))];
		if (known.length === 0) return;
		if (stubSwap) swapStubsToFull(pi, known, stubbed, fullByName);
		const current = pi.getActiveTools();
		pi.setActiveTools(orderActiveSet(unionStable(current, known), current, catalogNames));
	};

	toolSearchService.feed("mcp", input.searchMode ? documents : [], { activate });
	for (const doc of toolSearchService.getCatalog()) catalogNames.add(doc.name);

	const reference = pi.getActiveTools();
	// MCP owns only names from its previous/current registration generation.
	// Everything else is a base tool, regardless of naming convention.
	const currentBase = reference.filter(
		(name) => !isLegacyMcpRegistrationName(name) && !previousManagedNames.has(name) && !managedNames.has(name),
	);

	if (!input.searchMode) {
		registerToolsPreservingActiveSet(
			pi,
			fullDefs,
			orderActiveSet([...currentBase, ...activeMcpNames], reference, catalogNames),
		);
		return { activate, searchable };
	}

	if (!stubSwap) {
		// Default search mode: full defs registered, only directTools plus the
		// shared service-managed tool_search are active. Promotions append on the
		// activation turn (an accepted cache miss).
		const active = orderActiveSet([...currentBase, ...activeMcpNames], reference, catalogNames);
		registerToolsPreservingActiveSet(pi, fullDefs, active);
		return { activate, searchable };
	}

	// stubSwap: every search-mode tool is registered as a tiny stub and kept
	// active so the tools array is length-stable; direct tools stay full.
	const directActive = new Set(activeMcpNames);
	const toRegister: McpToolDefinition[] = fullDefs.map((def) => {
		if (directActive.has(def.name)) return def;
		stubbed.add(def.name);
		return buildMcpStubDefinition(def.name);
	});
	const active = orderActiveSet([...currentBase, ...fullDefs.map((def) => def.name)], reference, catalogNames);
	registerToolsPreservingActiveSet(pi, toRegister, active);
	return { activate, searchable };
}

function swapStubsToFull(
	pi: McpToolRegistrar,
	names: readonly string[],
	stubbed: Set<string>,
	fullByName: ReadonlyMap<string, McpToolDefinition>,
): void {
	for (const name of names) {
		if (!stubbed.has(name)) continue;
		const full = fullByName.get(name);
		if (full === undefined) continue;
		pi.registerTool(full);
		stubbed.delete(name);
	}
}

/** Order the active set deterministically without disturbing base tools.
 * Base tools retain reference order; every shared-catalog member sorts by
 * canonical name so consecutive promotions remain byte-stable. */
export function orderActiveSet(
	names: readonly string[],
	reference: readonly string[],
	catalogNames: ReadonlySet<string>,
): string[] {
	const unique = [...new Set(names)];
	const rank = new Map(reference.map((name, index) => [name, index] as const));
	const base = unique
		.filter((name) => !catalogNames.has(name))
		.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
	const catalog = unique.filter((name) => catalogNames.has(name)).sort();
	return [...base, ...catalog];
}

function unionStable(current: readonly string[], added: readonly string[]): string[] {
	return [...new Set([...current, ...added])];
}

/** Preserve the existing stale-generation cleanup for active sets created
 * before MCP catalog ownership was tracked. Ordering itself is catalog-based. */
function isLegacyMcpRegistrationName(name: string): boolean {
	return name.startsWith("mcp_");
}

/** A 30-70 token placeholder for an inactive search-mode tool. Keeps the tools
 * array length-stable under stubSwap; guides the model to tool_search. */
export function buildMcpStubDefinition(name: string): McpToolDefinition {
	return {
		name,
		label: name,
		description: `Inactive MCP tool. Run tool_search to activate ${name}, then call it on your next turn.`,
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute(): Promise<AgentToolResult<McpToolDetails | undefined>> {
			return {
				content: [{ type: "text", text: `${name} is not active. Use tool_search to activate it, then call it.` }],
				details: undefined,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolOutput", `${name} (inactive stub)`), 0, 0);
		},
	};
}
