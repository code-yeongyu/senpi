import { dirname, join, relative } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../../utils/paths.ts";
import type { PathMetadata } from "../package-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";

export type ResourceType = "extensions" | "skills" | "prompts" | "themes";
export type SettingsScope = "user" | "project";
export type ProjectOverrideState = "inherit" | "load" | "unload";

export const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

/** One package resource as the resolver answers it, with the kind of resource it is. */
export interface ConfigurableResource {
	readonly path: string;
	readonly enabled: boolean;
	readonly metadata: PathMetadata;
	readonly resourceType: ResourceType;
}

/** The settings a resource override writes, and the directories its relative patterns resolve against. */
export interface ResourceOverrideContext {
	readonly settingsManager: SettingsManager;
	readonly cwd: string;
	readonly agentDir: string;
}

export function patternEntryTarget(entry: string): string {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
}

export function resourceKey(item: ConfigurableResource): string {
	return `${item.resourceType}:${canonicalizePath(item.path)}`;
}

export function itemScope(item: ConfigurableResource): SettingsScope {
	return item.metadata.scope === "project" ? "project" : "user";
}

export function topLevelBaseDir(context: ResourceOverrideContext, scope: SettingsScope): string {
	return scope === "project" ? join(context.cwd, CONFIG_DIR_NAME) : context.agentDir;
}

export function resourcePattern(context: ResourceOverrideContext, item: ConfigurableResource): string {
	if (item.metadata.source === "builtin") return item.path;
	const baseDir = item.metadata.baseDir ?? topLevelBaseDir(context, itemScope(item));
	return relative(baseDir, item.path);
}

export function packageResourcePattern(item: ConfigurableResource): string {
	const baseDir = item.metadata.baseDir ?? dirname(item.path);
	return relative(baseDir, item.path);
}

export function resourcePatternForScope(
	context: ResourceOverrideContext,
	item: ConfigurableResource,
	scope: SettingsScope,
): string {
	const sourceScope = itemScope(item);
	if (scope !== sourceScope || item.metadata.source === "builtin") return item.path;
	const baseDir = item.metadata.baseDir ?? topLevelBaseDir(context, sourceScope);
	return relative(baseDir, item.path);
}

export function topLevelOverridePatterns(
	context: ResourceOverrideContext,
	item: ConfigurableResource,
	scope: SettingsScope,
): Set<string> {
	const patterns = new Set<string>([
		resourcePatternForScope(context, item, scope),
		item.path,
		relative(topLevelBaseDir(context, scope), item.path),
	]);
	if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
	return patterns;
}

export function packageSourceStringMatches(
	context: ResourceOverrideContext,
	left: { readonly source: string; readonly scope: SettingsScope },
	right: { readonly source: string; readonly scope: SettingsScope },
): boolean {
	if (left.source === right.source) return true;
	if (!isLocalPath(left.source) || !isLocalPath(right.source)) return false;
	const leftPath = resolvePath(left.source, topLevelBaseDir(context, left.scope), { trim: true });
	const rightPath = resolvePath(right.source, topLevelBaseDir(context, right.scope), { trim: true });
	return leftPath === rightPath;
}

export function setTopLevelPaths(
	settingsManager: SettingsManager,
	scope: SettingsScope,
	type: ResourceType,
	paths: string[],
): void {
	if (scope === "project") {
		if (type === "extensions") settingsManager.setProjectExtensionPaths(paths);
		else if (type === "skills") settingsManager.setProjectSkillPaths(paths);
		else if (type === "prompts") settingsManager.setProjectPromptTemplatePaths(paths);
		else settingsManager.setProjectThemePaths(paths);
		return;
	}
	if (type === "extensions") settingsManager.setExtensionPaths(paths);
	else if (type === "skills") settingsManager.setSkillPaths(paths);
	else if (type === "prompts") settingsManager.setPromptTemplatePaths(paths);
	else settingsManager.setThemePaths(paths);
}
