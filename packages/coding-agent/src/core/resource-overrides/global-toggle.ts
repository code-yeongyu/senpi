import type { PackageSource } from "../settings-manager.ts";
import {
	type ConfigurableResource,
	itemScope,
	packageResourcePattern,
	patternEntryTarget,
	RESOURCE_TYPES,
	type ResourceOverrideContext,
	resourcePattern,
	setTopLevelPaths,
} from "./patterns.ts";

function withPattern(current: readonly string[], pattern: string, enabled: boolean): string[] {
	const updated = current.filter((entry) => patternEntryTarget(entry) !== pattern);
	updated.push(`${enabled ? "+" : "-"}${pattern}`);
	return updated;
}

function setTopLevelEnabled(context: ResourceOverrideContext, item: ConfigurableResource, enabled: boolean): void {
	const scope = itemScope(item);
	const settings =
		scope === "project" ? context.settingsManager.getProjectSettings() : context.settingsManager.getGlobalSettings();
	const current = (settings[item.resourceType] ?? []) as string[];
	setTopLevelPaths(
		context.settingsManager,
		scope,
		item.resourceType,
		withPattern(current, resourcePattern(context, item), enabled),
	);
}

function setPackageResourceEnabled(
	context: ResourceOverrideContext,
	item: ConfigurableResource,
	enabled: boolean,
): void {
	const scope = itemScope(item);
	const settings =
		scope === "project" ? context.settingsManager.getProjectSettings() : context.settingsManager.getGlobalSettings();
	const packages = [...(settings.packages ?? [])] as PackageSource[];
	const index = packages.findIndex((pkg) => (typeof pkg === "string" ? pkg : pkg.source) === item.metadata.source);
	if (index === -1) return;
	const found = packages[index];
	if (found === undefined) return;
	const pkg = typeof found === "string" ? { source: found } : found;
	packages[index] = pkg;
	const updated = withPattern((pkg[item.resourceType] ?? []) as string[], packageResourcePattern(item), enabled);
	(pkg as Record<string, unknown>)[item.resourceType] = updated;
	if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) packages[index] = pkg.source;
	if (scope === "project") context.settingsManager.setProjectPackages(packages);
	else context.settingsManager.setPackages(packages);
}

/** Enables or disables one resource in the settings of the scope it comes from (the config TUI's global mode). */
export function setResourceEnabled(
	context: ResourceOverrideContext,
	item: ConfigurableResource,
	enabled: boolean,
): void {
	if (item.metadata.origin === "top-level") setTopLevelEnabled(context, item, enabled);
	else setPackageResourceEnabled(context, item, enabled);
}
