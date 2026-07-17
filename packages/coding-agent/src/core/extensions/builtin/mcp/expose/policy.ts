import picomatch from "picomatch";
import type { McpToolCatalogEntry } from "../catalog.ts";
import type { McpServerConfig, McpSettings } from "../config-schema.ts";

export interface McpExposurePolicyResult {
	readonly activeEntries: McpToolCatalogEntry[];
	readonly filteredEntries: McpToolCatalogEntry[];
	readonly mode: "direct" | "search" | "proxy";
	readonly reason: "explicit" | "threshold" | "directTools";
	readonly registeredEntries: McpToolCatalogEntry[];
	readonly warnings: string[];
}

type ToolMatcher = (toolName: string) => boolean;

const PICOMATCH_OPTIONS = { bash: true, dot: true };

export function computeMcpExposurePolicy(
	entries: readonly McpToolCatalogEntry[],
	config: McpServerConfig,
	settings: McpSettings,
): McpExposurePolicyResult {
	const filteredEntries = stableSort(entries.filter((entry) => passesToolFilters(entry.tool, config)));
	const directEntries = stableSort(entriesMatchingDirectTools(filteredEntries, config.directTools));
	if (filteredEntries.length === 0) {
		return {
			activeEntries: [],
			filteredEntries,
			mode: "direct",
			reason: "explicit",
			registeredEntries: [],
			warnings: [`MCP server ${serverName(entries)} has 0 exposed tools after includeTools/excludeTools filters.`],
		};
	}

	if (config.directTools === true) {
		return directResult(filteredEntries, filteredEntries, "directTools");
	}
	if (config.exposure === "direct") {
		return directResult(filteredEntries, filteredEntries, "explicit");
	}
	// Tier-C proxy mode (todo 38): per-server OPT-IN only. The whole catalog
	// stays behind a single gateway tool; nothing registers directly and auto
	// never selects this mode (SPEC §5: -27.3pp GSM8K structured-output evidence).
	if (config.exposure === "proxy") {
		return {
			activeEntries: [],
			filteredEntries,
			mode: "proxy",
			reason: "explicit",
			registeredEntries: [],
			warnings: [],
		};
	}
	// Tier-B search mode: register the full catalog but keep only directTools
	// active; tool_search promotes the rest on demand.
	if (config.exposure === "search") {
		return searchResult(filteredEntries, directEntries, "explicit");
	}
	if (filteredEntries.length <= (settings.searchThreshold ?? 10)) {
		return directResult(filteredEntries, filteredEntries, "threshold");
	}
	return searchResult(filteredEntries, directEntries, "threshold");
}

function searchResult(
	filteredEntries: readonly McpToolCatalogEntry[],
	directEntries: readonly McpToolCatalogEntry[],
	reason: McpExposurePolicyResult["reason"],
): McpExposurePolicyResult {
	return {
		activeEntries: stableSort(directEntries),
		filteredEntries: stableSort(filteredEntries),
		mode: "search",
		reason,
		registeredEntries: stableSort(filteredEntries),
		warnings: [],
	};
}

function directResult(
	filteredEntries: readonly McpToolCatalogEntry[],
	activeEntries: readonly McpToolCatalogEntry[],
	reason: McpExposurePolicyResult["reason"],
): McpExposurePolicyResult {
	return {
		activeEntries: stableSort(activeEntries),
		filteredEntries: stableSort(filteredEntries),
		mode: "direct",
		reason,
		registeredEntries: stableSort(activeEntries),
		warnings: [],
	};
}

function passesToolFilters(toolName: string, config: McpServerConfig): boolean {
	const include = compileMatchers(config.includeTools);
	const exclude = compileMatchers(config.excludeTools);
	const included = include.length === 0 || include.some((isMatch) => isMatch(toolName));
	if (!included) return false;
	return !exclude.some((isMatch) => isMatch(toolName));
}

function entriesMatchingDirectTools(
	entries: readonly McpToolCatalogEntry[],
	directTools: McpServerConfig["directTools"],
): McpToolCatalogEntry[] {
	if (directTools === true) return stableSort(entries);
	if (!Array.isArray(directTools) || directTools.length === 0) return [];
	const matchers = compileMatchers(directTools);
	return stableSort(entries.filter((entry) => matchers.some((isMatch) => isMatch(entry.tool))));
}

function compileMatchers(patterns: readonly string[] | undefined): ToolMatcher[] {
	return (patterns ?? []).map((pattern) => safeMatcher(pattern));
}

function safeMatcher(pattern: string): ToolMatcher {
	try {
		return picomatch(pattern, PICOMATCH_OPTIONS);
	} catch {
		return (toolName) => toolName === pattern;
	}
}

function stableSort(entries: readonly McpToolCatalogEntry[]): McpToolCatalogEntry[] {
	return [...entries].sort(
		(left, right) => left.server.localeCompare(right.server) || left.tool.localeCompare(right.tool),
	);
}

function serverName(entries: readonly McpToolCatalogEntry[]): string {
	return entries[0]?.server ?? "<unknown>";
}
