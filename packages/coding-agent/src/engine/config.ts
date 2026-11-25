import { isBuiltinExtension } from "../core/resource-loader.ts";
import { DefaultPackageManager, type ResolvedPaths } from "../core/package-manager.ts";
import { setResourceEnabled } from "../core/resource-overrides/global-toggle.ts";
import {
	type ConfigurableResource,
	type ProjectOverrideState,
	RESOURCE_TYPES,
	type ResourceType,
} from "../core/resource-overrides/patterns.ts";
import { ProjectResourceOverrides } from "../core/resource-overrides/project-overrides.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { canonicalizePath } from "../utils/paths.ts";
import { type EngineCommandScope, openCommandSettings, settingsDiagnostics } from "./command-settings.ts";
import { type EngineDiagnostic, type EngineResult, engineError, engineOk } from "./result.ts";

export interface ResourcesInput {
	/** Project-local overrides (`-l`) instead of global settings. */
	readonly local?: boolean;
	readonly trust?: boolean;
}

export interface ResolvedResources {
	readonly writeScope: "global" | "project";
	/** Whether the project is trusted, so its local overrides can be read and written. */
	readonly projectModeAvailable: boolean;
	readonly global: ResolvedPaths;
	readonly project: ResolvedPaths;
}

export type ResourceConfigCode = "project_untrusted" | "trust_required" | "not_found" | "not_writable" | "write_failed";

/** The resolved resources plus the settings they were read from: what the config TUI edits. */
export interface OpenedResourceConfig extends ResolvedResources {
	readonly settingsManager: SettingsManager;
}

/** Resolves every package resource with whether it is enabled, globally and for the project. */
export async function openResourceConfig(
	scope: EngineCommandScope,
	input: ResourcesInput,
): Promise<EngineResult<OpenedResourceConfig, ResourceConfigCode>> {
	const opened = await openCommandSettings(scope, input.trust);
	if ("kind" in opened) return opened;
	const { settingsManager, trustDiagnostics } = opened;
	if (input.local === true && !settingsManager.isProjectTrusted()) {
		return engineError(
			"project_untrusted",
			"Project is not trusted. Use --approve to modify local resource config.",
			{
				diagnostics: trustDiagnostics,
			},
		);
	}
	const diagnostics = [...trustDiagnostics, ...settingsDiagnostics(settingsManager, "config command")];
	const builtinExtensions = scope.extensionFactories.filter(isBuiltinExtension).map((factory) => factory.name);
	const { cwd, agentDir } = scope;
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const global = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
		builtinExtensions,
	}).resolve();
	const project = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager, builtinExtensions }).resolve()
		: global;
	return engineOk(
		{
			writeScope: input.local === true ? "project" : "global",
			projectModeAvailable: settingsManager.isProjectTrusted(),
			global,
			project,
			settingsManager,
		},
		diagnostics,
	);
}

export interface ResourceRef {
	readonly type: ResourceType;
	readonly path: string;
}

/** Global settings: the resource is enabled or disabled. */
export interface GlobalResourceSetting {
	readonly local?: false;
	readonly source: string;
	readonly resource: ResourceRef;
	readonly enabled: boolean;
}

/** Project-local overrides: the resource inherits the global decision, or the project loads or unloads it. */
export interface ProjectResourceSetting {
	readonly local: true;
	readonly trust?: boolean;
	readonly source: string;
	readonly resource: ResourceRef;
	readonly state: ProjectOverrideState;
}

export type ResourceSetting = GlobalResourceSetting | ProjectResourceSetting;

export interface ChangedResource {
	readonly source: string;
	readonly resource: ResourceRef;
	/** Whether the resource now loads in the scope that was written. */
	readonly enabled: boolean;
	readonly state?: ProjectOverrideState;
}

function resourcesOf(paths: ResolvedPaths): ConfigurableResource[] {
	return RESOURCE_TYPES.flatMap((resourceType) =>
		paths[resourceType].map((resource) => ({ ...resource, resourceType })),
	);
}

function findResource(paths: ResolvedPaths, setting: ResourceSetting): ConfigurableResource | undefined {
	const path = canonicalizePath(setting.resource.path);
	return resourcesOf(paths).find(
		(item) =>
			item.resourceType === setting.resource.type &&
			item.metadata.source === setting.source &&
			canonicalizePath(item.path) === path,
	);
}

async function persisted(
	settingsManager: SettingsManager,
	diagnostics: readonly EngineDiagnostic[],
	changed: ChangedResource,
): Promise<EngineResult<ChangedResource, ResourceConfigCode>> {
	await settingsManager.flush();
	const failure = settingsManager.drainErrors()[0];
	if (failure !== undefined) return engineError("write_failed", failure.error.message, { diagnostics });
	return engineOk(changed, diagnostics);
}

/** Writes one resource's setting the way the config TUI's space press does, and answers the changed entry. */
export async function setResource(
	scope: EngineCommandScope,
	setting: ResourceSetting,
): Promise<EngineResult<ChangedResource, ResourceConfigCode>> {
	const opened = await openResourceConfig(
		scope,
		setting.local === true
			? { local: true, ...(setting.trust === undefined ? {} : { trust: setting.trust }) }
			: { trust: false },
	);
	if (opened.kind === "error") return opened;
	const { settingsManager, global, project } = opened.value;
	const context = { settingsManager, cwd: scope.cwd, agentDir: scope.agentDir };
	// A project override keeps acting on the resource the TUI listed before any override existed: the inherited
	// global entry. Once overridden, the project resolution names it as a project resource with another source.
	const item =
		setting.local === true
			? (findResource(global, setting) ?? findResource(project, setting))
			: findResource(global, setting);
	const notFound = `No ${setting.resource.type} resource ${setting.resource.path} from ${setting.source}`;
	if (item === undefined) return engineError("not_found", notFound, { diagnostics: opened.diagnostics });
	const changedBase = { source: setting.source, resource: setting.resource };
	if (setting.local !== true) {
		if (item.metadata.scope !== "user") {
			return engineError("not_writable", `${item.path} is not a global resource`, {
				diagnostics: opened.diagnostics,
			});
		}
		setResourceEnabled(context, item, setting.enabled);
		return persisted(settingsManager, opened.diagnostics, { ...changedBase, enabled: setting.enabled });
	}
	const overrides = new ProjectResourceOverrides(context, resourcesOf(global));
	if (!overrides.set(item, setting.state)) {
		return engineError("not_writable", `${item.path} has no project override to remove`, {
			diagnostics: opened.diagnostics,
		});
	}
	return persisted(settingsManager, opened.diagnostics, {
		...changedBase,
		enabled: overrides.enabledIn(item, setting.state),
		state: setting.state,
	});
}
