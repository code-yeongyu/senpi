import { loadMcpConfig, mergeExtensionMcpServers } from "../core/extensions/builtin/mcp/config.ts";
import { findNearestPackageIdentity } from "../core/package-identity.ts";
import type { PromptSizeInventory } from "../core/prompt-size-startup.ts";

/** The synchronous filesystem side of `--print-prompt-sizes`, kept off the session path. */
export const cliPromptSizeInventory: PromptSizeInventory = {
	packageNameOf: (path) => findNearestPackageIdentity(path)?.packageName,
	mcpServerNames: ({ cwd, runner }) => {
		const context = runner.createContext();
		const config = loadMcpConfig({ cwd, projectTrusted: context.isProjectTrusted() });
		if (context.extensionConnectsMcpServers?.() !== true) {
			mergeExtensionMcpServers(config, context.getRegisteredMcpServers?.() ?? []);
		}
		return Object.keys(config.servers);
	},
};
