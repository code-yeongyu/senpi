import { relative } from "node:path";
import type { PackageSource } from "../settings-manager.ts";
import { resolvePath, isLocalPath } from "../../utils/paths.ts";
import {
	type ConfigurableResource,
	itemScope,
	packageResourcePattern,
	packageSourceStringMatches,
	patternEntryTarget,
	type ProjectOverrideState,
	RESOURCE_TYPES,
	type ResourceOverrideContext,
	resourceKey,
	resourcePatternForScope,
	type SettingsScope,
	setTopLevelPaths,
	topLevelBaseDir,
	topLevelOverridePatterns,
} from "./patterns.ts";

/**
 * The project-local overrides of the config TUI's `-l` mode: each resource inherits what global settings
 * decide, or the project settings load (`+`) or unload (`-`) it.
 */
export class ProjectResourceOverrides {
	private readonly context: ResourceOverrideContext;
	private readonly inheritedEnabledByKey: ReadonlyMap<string, boolean>;

	/** `inherited` are the resources global settings resolve, with whether each is enabled there. */
	constructor(context: ResourceOverrideContext, inherited: Iterable<ConfigurableResource>) {
		this.context = context;
		const byKey = new Map<string, boolean>();
		for (const item of inherited) byKey.set(resourceKey(item), item.enabled);
		this.inheritedEnabledByKey = byKey;
	}

	state(item: ConfigurableResource): ProjectOverrideState {
		const projectSettings = this.context.settingsManager.getProjectSettings();
		if (item.metadata.origin === "top-level") {
			return stateFromEntries(
				(projectSettings[item.resourceType] ?? []) as string[],
				topLevelOverridePatterns(this.context, item, "project"),
				false,
			);
		}
		const pkg = this.findMatchingPackageSource(item, "project");
		if (typeof pkg !== "object") return "inherit";
		const entries = pkg[item.resourceType];
		if (entries === undefined) return "inherit";
		return stateFromEntries(entries, new Set([packageResourcePattern(item)]), pkg.autoload !== false);
	}

	/** The state a space press moves to: inherit, then the opposite of what is inherited, then back. */
	nextState(item: ConfigurableResource): ProjectOverrideState {
		const state = this.state(item);
		const inheritedEnabled = this.inheritedEnabled(item);
		if (state === "inherit") return inheritedEnabled ? "unload" : "load";
		if (state === "unload") return inheritedEnabled ? "load" : "inherit";
		return inheritedEnabled ? "inherit" : "unload";
	}

	/** Whether the resource loads in the project once `state` applies. */
	enabledIn(item: ConfigurableResource, state: ProjectOverrideState): boolean {
		return state === "inherit" ? this.inheritedEnabled(item) : state === "load";
	}

	inheritedEnabled(item: ConfigurableResource): boolean {
		return this.inheritedEnabledByKey.get(resourceKey(item)) ?? (itemScope(item) === "user" ? item.enabled : true);
	}

	isInheritedGlobal(item: ConfigurableResource): boolean {
		return itemScope(item) === "user" || this.inheritedEnabledByKey.has(resourceKey(item));
	}

	/** Writes `state` for the resource; false when there is nothing to write (inherit with no project entry). */
	set(item: ConfigurableResource, state: ProjectOverrideState): boolean {
		return item.metadata.origin === "top-level" ? this.setTopLevel(item, state) : this.setPackage(item, state);
	}

	private setTopLevel(item: ConfigurableResource, state: ProjectOverrideState): boolean {
		const current = (this.context.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[];
		const inheritedGlobal = this.isInheritedGlobal(item);
		const pattern = inheritedGlobal ? item.path : resourcePatternForScope(this.context, item, "project");
		const patterns = topLevelOverridePatterns(this.context, item, "project");
		const updated = current.filter((entry) => {
			const target = patternEntryTarget(entry);
			if ((entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) && patterns.has(target))
				return false;
			return !(state === "inherit" && inheritedGlobal && target === pattern);
		});
		if (state !== "inherit") {
			// Project entries name inherited files to override them. Built-in paths need no entry.
			if (inheritedGlobal && item.metadata.source !== "builtin" && !updated.includes(pattern)) updated.push(pattern);
			updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		}
		setTopLevelPaths(this.context.settingsManager, "project", item.resourceType, updated);
		return true;
	}

	private setPackage(item: ConfigurableResource, state: ProjectOverrideState): boolean {
		const packages = [...(this.context.settingsManager.getProjectSettings().packages ?? [])] as PackageSource[];
		let index = packages.findIndex((pkg) => this.sourceMatches(item, typeof pkg === "string" ? pkg : pkg.source));
		if (index === -1) {
			if (state === "inherit") return false;
			packages.push(this.packageOverrideSource(item));
			index = packages.length - 1;
		}
		const found = packages[index];
		if (found === undefined) return false;
		const pkg = typeof found === "string" ? { source: found } : found;
		packages[index] = pkg;
		const pattern = packageResourcePattern(item);
		const updated = ((pkg[item.resourceType] ?? []) as string[]).filter(
			(entry) => patternEntryTarget(entry) !== pattern,
		);
		if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		(pkg as Record<string, unknown>)[item.resourceType] = updated.length > 0 ? updated : undefined;
		if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) {
			if (pkg.autoload === false) packages.splice(index, 1);
			else packages[index] = pkg.source;
		}
		this.context.settingsManager.setProjectPackages(packages);
		return true;
	}

	private sourceMatches(item: ConfigurableResource, projectSource: string): boolean {
		return packageSourceStringMatches(
			this.context,
			{ source: item.metadata.source, scope: itemScope(item) },
			{ source: projectSource, scope: "project" },
		);
	}

	private packageOverrideSource(item: ConfigurableResource): PackageSource {
		const source = item.metadata.source;
		if (!isLocalPath(source)) return { source, autoload: false };
		const sourcePath = resolvePath(source, topLevelBaseDir(this.context, itemScope(item)), { trim: true });
		return { source: relative(topLevelBaseDir(this.context, "project"), sourcePath) || ".", autoload: false };
	}

	private findMatchingPackageSource(
		item: ConfigurableResource,
		targetScope: SettingsScope,
	): PackageSource | undefined {
		const settings =
			targetScope === "project"
				? this.context.settingsManager.getProjectSettings()
				: this.context.settingsManager.getGlobalSettings();
		return (settings.packages ?? []).find((pkg) =>
			packageSourceStringMatches(
				this.context,
				{ source: item.metadata.source, scope: itemScope(item) },
				{ source: typeof pkg === "string" ? pkg : pkg.source, scope: targetScope },
			),
		);
	}
}

function stateFromEntries(
	entries: readonly string[],
	patterns: ReadonlySet<string>,
	emptyArrayIsUnload: boolean,
): ProjectOverrideState {
	if (entries.length === 0 && emptyArrayIsUnload) return "unload";
	let state: ProjectOverrideState = "inherit";
	for (const entry of entries) {
		if (!patterns.has(patternEntryTarget(entry))) continue;
		state = entry.startsWith("!") || entry.startsWith("-") ? "unload" : "load";
	}
	return state;
}
