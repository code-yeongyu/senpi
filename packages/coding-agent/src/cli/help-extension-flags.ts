import type { ExtensionFlag, InlineExtension } from "../core/extensions/types.ts";
import { DefaultResourceLoader } from "../core/resource-loader.ts";
import type { SettingsManager } from "../core/settings-manager.ts";

export interface HelpExtensionFlagsResult {
	readonly flags: ExtensionFlag[];
	readonly extensionPaths: string[];
}

/**
 * Load extensions for their CLI flags and nothing else.
 *
 * Help renders flag descriptors, so this deliberately skips every other resource class and the
 * whole model/session stack that `createAgentSessionServices` would build: skills, prompt
 * templates, themes and context files cannot register a flag.
 */
export async function resolveHelpExtensionFlags(options: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly additionalExtensionPaths: readonly string[];
	readonly noExtensions: boolean;
	readonly extensionFactories?: readonly InlineExtension[];
}): Promise<HelpExtensionFlagsResult> {
	const resourceLoader = new DefaultResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		settingsManager: options.settingsManager,
		additionalExtensionPaths: [...options.additionalExtensionPaths],
		noExtensions: options.noExtensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		...(options.extensionFactories ? { extensionFactories: [...options.extensionFactories] } : {}),
	});
	await resourceLoader.reload();
	const { extensions } = resourceLoader.getExtensions();
	return {
		flags: extensions.flatMap((extension) => [...extension.flags.values()]),
		extensionPaths: extensions.map((extension) => extension.resolvedPath),
	};
}
