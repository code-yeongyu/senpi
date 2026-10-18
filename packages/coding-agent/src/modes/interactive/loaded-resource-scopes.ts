import type { SourceInfo, SourceScope } from "../../core/source-info.ts";
import { theme } from "./theme/theme.ts";

export type ResourceScopeGroup = "project" | "user" | "path" | "system";

export interface ScopedResource {
	readonly path: string;
	readonly sourceInfo?: SourceInfo;
}

export interface ResourceScopeGroups {
	readonly scope: ResourceScopeGroup;
	readonly paths: ScopedResource[];
	readonly packages: Map<string, ScopedResource[]>;
}

export interface ResourceScopeGroupFormat {
	readonly formatPath: (item: ScopedResource) => string;
	readonly formatPackagePath: (item: ScopedResource, source: string) => string;
}

export interface DisplaySourceInfo {
	readonly label: string;
	readonly scopeLabel?: string;
	readonly color: "accent" | "muted";
}

const GROUP_ORDER: readonly ResourceScopeGroup[] = ["project", "user", "path", "system"];

export function isSystemResource(sourceInfo?: SourceInfo): boolean {
	return sourceInfo?.scope === "system";
}

export function isPackageSourceInfo(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

export function getResourceScopeGroup(sourceInfo?: SourceInfo): ResourceScopeGroup {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (scope === "system") return "system";
	if (source === "cli") return "path";
	switch (scope) {
		case "temporary":
			return "path";
		case "user":
			return "user";
		case "project":
			return "project";
		default:
			return assertNever(scope);
	}
}

export function buildResourceScopeGroups(items: readonly ScopedResource[]): ResourceScopeGroups[] {
	const groups = new Map<ResourceScopeGroup, ResourceScopeGroups>(
		GROUP_ORDER.map((scope) => [scope, { scope, paths: [], packages: new Map() }]),
	);

	for (const item of items) {
		const group = groups.get(getResourceScopeGroup(item.sourceInfo));
		if (group === undefined) continue;
		if (isPackageSourceInfo(item.sourceInfo)) {
			const source = item.sourceInfo?.source ?? "local";
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}

	return GROUP_ORDER.map((scope) => groups.get(scope)).filter(
		(group): group is ResourceScopeGroups =>
			group !== undefined && (group.paths.length > 0 || group.packages.size > 0),
	);
}

export function formatResourceScopeGroups(
	groups: readonly ResourceScopeGroups[],
	options: ResourceScopeGroupFormat,
): string {
	const lines: string[] = [];

	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);

		const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
		for (const item of sortedPaths) {
			lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
		}

		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPackagePaths) {
				lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
			}
		}
	}

	return lines.join("\n");
}

export function getScopeAutocompleteTag(scope: SourceScope): "u" | "p" | "t" | "s" {
	switch (scope) {
		case "user":
			return "u";
		case "project":
			return "p";
		case "temporary":
			return "t";
		case "system":
			return "s";
		default:
			return assertNever(scope);
	}
}

export function getDisplaySourceInfo(sourceInfo?: SourceInfo): DisplaySourceInfo {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (scope === "system") {
		return { label: "system", color: "muted" };
	}
	if (source === "local") {
		if (scope === "user") {
			return { label: "user", color: "muted" };
		}
		if (scope === "project") {
			return { label: "project", color: "muted" };
		}
		return { label: "path", scopeLabel: "temp", color: "muted" };
	}

	if (source === "cli") {
		return {
			label: "path",
			scopeLabel: scope === "temporary" ? "temp" : undefined,
			color: "muted",
		};
	}

	const scopeLabel = scope === "user" ? "user" : scope === "project" ? "project" : "temp";
	return { label: source, scopeLabel, color: "accent" };
}

function assertNever(value: never): never {
	throw new Error(`Unexpected resource scope: ${String(value)}`);
}
