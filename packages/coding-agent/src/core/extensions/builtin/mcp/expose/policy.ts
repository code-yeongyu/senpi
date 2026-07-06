import picomatch from "picomatch";
import type { McpToolCatalogEntry } from "../catalog.ts";
import type { McpServerConfig, McpSettings } from "../config-schema.ts";

export interface McpExposurePolicyResult {
	readonly activeEntries: McpToolCatalogEntry[];
	readonly filteredEntries: McpToolCatalogEntry[];
	readonly mode: "direct" | "deferred";
	readonly reason: "explicit" | "threshold" | "directTools" | "pending-W4";
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
	if (config.exposure === "search" || config.exposure === "proxy") {
		return directResult(filteredEntries, directEntries, "directTools");
	}
	if (filteredEntries.length <= (settings.searchThreshold ?? 10)) {
		return directResult(filteredEntries, filteredEntries, "threshold");
	}
	return {
		activeEntries: filteredEntries,
		filteredEntries,
		mode: "deferred",
		reason: "pending-W4",
		registeredEntries: filteredEntries,
		warnings: [
			`MCP server ${serverName(filteredEntries)} has ${filteredEntries.length} exposed tools above searchThreshold ${
				settings.searchThreshold ?? 10
			}; Tier-B deferred exposure is pending-W4, so W1 registers all tools directly with no silent truncation.`,
		],
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
