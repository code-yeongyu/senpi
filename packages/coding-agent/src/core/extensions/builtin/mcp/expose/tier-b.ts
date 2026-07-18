// Tier-B adaptive exposure wiring (todo 32).
//
// Completes exposure:"auto": a server whose filtered tool count exceeds
// searchThreshold enters SEARCH mode — the full catalog is registered but only
// directTools stay active, and an always-active tool_search promotes the rest on
// demand. Prompt-cache mitigations (SPEC §5): stable name sort everywhere;
// activation turns accept a cache miss (documented); opt-in settings.stubSwap
// registers 30-70-token stubs so the tools array stays length-stable and only
// the activated entry's bytes change (stub -> full) on promotion.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "../../../types.ts";
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
import {
	createMcpSearchTool,
	rehydrateActiveToolsFromHistory,
	type SearchableMcpTool,
	TOOL_SEARCH_TOOL_NAME,
	unionStable,
} from "./tool-search.ts";

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

export interface McpTierBRegistration {
	/** Searchable catalog (for reuse by /mcp status and list_changed). */
	readonly searchable: SearchableMcpTool[];
	/**
	 * Replay activation markers found in session history through the SAME
	 * activation path tool_search uses (stub swap + stable ordering), so a
	 * resumed/compacted session restores its promoted tools without
	 * re-searching. Returns the newly activated names (empty when nothing new).
	 */
	rehydrateFromHistory(messages: readonly unknown[]): string[];
	/** Activate registered tools by name through the same stable path
	 * tool_search uses (skill lazy-reveal, todo 37). Unknown names ignored. */
	activate(names: readonly string[]): void;
}

const NOOP_REHYDRATE = (): string[] => [];

/** Register MCP tools honouring Tier-B search mode + prompt-cache mitigations. */
export function registerMcpTierBTools(
	pi: McpToolRegistrar,
	input: McpTierBRegistrationInput,
	warn?: WarnFn,
): McpTierBRegistration {
	const named = mapMcpCatalogNames(input.registeredEntries, warn);
	const searchable: SearchableMcpTool[] = named.map(({ entry, name }) => ({
		name,
		toolName: entry.tool,
		description: entry.description,
		server: entry.server,
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
	const reference = pi.getActiveTools();
	// Base tools carry over; any stale mcp_* names from a prior generation are
	// dropped (membership = base + the intended mcp set; reference orders only).
	const currentBase = reference.filter((name) => !name.startsWith("mcp_"));

	if (!input.searchMode) {
		registerToolsPreservingActiveSet(pi, fullDefs, orderActiveSet([...currentBase, ...activeMcpNames], reference));
		// Direct mode: everything registerable is already active, nothing to replay.
		const activateDirect = (names: readonly string[]): void => {
			pi.setActiveTools(orderActiveSet(unionStable(pi.getActiveTools(), names), pi.getActiveTools()));
		};
		return { activate: activateDirect, searchable, rehydrateFromHistory: NOOP_REHYDRATE };
	}

	const stubSwap = input.settings.stubSwap === true;
	const stubbed = new Set<string>();
	const activateMcpTools = (names: readonly string[]): void => {
		if (stubSwap) swapStubsToFull(pi, names, stubbed, fullByName);
		pi.setActiveTools(orderActiveSet(names, pi.getActiveTools()));
	};
	const searchTool = createMcpSearchTool({
		getSearchableTools: () => searchable,
		getActiveTools: () => pi.getActiveTools(),
		setActiveTools: activateMcpTools,
	});
	const registeredNames = new Set(fullDefs.map((def) => def.name));
	const activate = (names: readonly string[]): void => {
		const known = names.filter((name) => registeredNames.has(name));
		if (known.length === 0) return;
		activateMcpTools(unionStable(pi.getActiveTools(), known));
	};
	const rehydrateFromHistory = (messages: readonly unknown[]): string[] => {
		const restored = rehydrateActiveToolsFromHistory(messages, registeredNames);
		const current = pi.getActiveTools();
		const fresh = restored.filter((name) => !current.includes(name));
		if (fresh.length === 0) return [];
		activateMcpTools(unionStable(current, fresh));
		return fresh;
	};

	// tool_search carries a distinct param schema, so register it on its own
	// rather than mixing it into the broadly-typed catalog def array.
	pi.registerTool(searchTool);

	if (!stubSwap) {
		// Default search mode: full defs registered, only directTools + tool_search
		// active. Newly promoted tools enter the array on their activation turn
		// (an accepted cache miss).
		const active = orderActiveSet([...currentBase, TOOL_SEARCH_TOOL_NAME, ...activeMcpNames], reference);
		registerToolsPreservingActiveSet(pi, fullDefs, active);
		return { activate, searchable, rehydrateFromHistory };
	}

	// stubSwap: every search-mode tool is registered as a tiny stub and kept
	// active so the tools array is length-stable; direct tools stay full.
	const directActive = new Set(activeMcpNames);
	const toRegister: McpToolDefinition[] = fullDefs.map((def) => {
		if (directActive.has(def.name)) return def;
		stubbed.add(def.name);
		return buildMcpStubDefinition(def.name);
	});
	const active = orderActiveSet(
		[...currentBase, TOOL_SEARCH_TOOL_NAME, ...fullDefs.map((def) => def.name)],
		reference,
	);
	registerToolsPreservingActiveSet(pi, toRegister, active);
	return { activate, searchable, rehydrateFromHistory };
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

/** Order the active set deterministically WITHOUT disturbing non-MCP (base)
 * tools: base tools keep their existing relative order (by `reference` index,
 * new ones appended), MCP tools (incl. tool_search) are sorted for cache
 * stability. Sorting base tools would churn the system-prompt tool listing. */
function orderActiveSet(names: readonly string[], reference: readonly string[]): string[] {
	const unique = [...new Set(names)];
	const rank = new Map(reference.map((name, index) => [name, index] as const));
	const base = unique
		.filter((name) => !name.startsWith("mcp_"))
		.sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
	const mcp = unique.filter((name) => name.startsWith("mcp_")).sort();
	return [...base, ...mcp];
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
