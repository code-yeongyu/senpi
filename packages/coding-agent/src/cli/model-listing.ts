import { createAgentSessionServices } from "../core/agent-session-services.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { Args } from "./args.ts";

type ServiceOptions = Parameters<typeof createAgentSessionServices>[0];
type ExtensionFactories = NonNullable<NonNullable<ServiceOptions["resourceLoaderOptions"]>["extensionFactories"]>;

export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/**
 * The services `--list-models` lists from, built from the launch setup given with it: the one core the command
 * and `engine.models.list` share.
 */
export function createModelListingServices(
	parsed: Args,
	scope: {
		readonly cwd: string;
		readonly agentDir: string;
		readonly settingsManager?: SettingsManager;
		readonly extensionFactories: ExtensionFactories;
	},
): ReturnType<typeof createAgentSessionServices> {
	return createAgentSessionServices({
		cwd: scope.cwd,
		agentDir: scope.agentDir,
		...(scope.settingsManager === undefined ? {} : { settingsManager: scope.settingsManager }),
		extensionFlagValues: parsed.unknownFlags,
		resourceLoaderOptions: {
			additionalExtensionPaths: resolveCliPaths(scope.cwd, parsed.extensions),
			additionalSkillPaths: resolveCliPaths(scope.cwd, parsed.skills),
			additionalPromptTemplatePaths: resolveCliPaths(scope.cwd, parsed.promptTemplates),
			additionalThemePaths: resolveCliPaths(scope.cwd, parsed.themes),
			noExtensions: parsed.noExtensions,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: scope.extensionFactories,
		},
	});
}
