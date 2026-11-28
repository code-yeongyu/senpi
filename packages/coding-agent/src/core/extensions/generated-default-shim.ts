import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { generatedShimTarget } from "../generated-shim-banner.ts";
import { globalDefaultExtensionFactories, globalDefaultExtensionIds } from "./builtin/index.ts";
import type { ExtensionFactory } from "./types.ts";

export type GlobalDefaultExtensionId = (typeof globalDefaultExtensionIds)[number];

export function getGlobalDefaultExtensionShimPath(agentDir: string, extensionId: GlobalDefaultExtensionId): string {
	return join(agentDir, "extensions", `${extensionId}.js`);
}

function findGlobalDefaultExtensionId(extensionPath: string, agentDir: string): GlobalDefaultExtensionId | undefined {
	const resolvedExtensionPath = resolve(extensionPath);
	return globalDefaultExtensionIds.find(
		(extensionId) => resolvedExtensionPath === resolve(getGlobalDefaultExtensionShimPath(agentDir, extensionId)),
	);
}

/** The module a generated shim re-exports, when the file is exactly a generated shim and that module is gone. */
export function deadGeneratedShimTarget(content: string): string | undefined {
	const target = generatedShimTarget(content);
	return target !== undefined && !existsSync(target) ? target : undefined;
}

/** Whether a shim target is the default's own builtin module in some installation, source or built. */
export function namesBuiltin(target: string, id: GlobalDefaultExtensionId): boolean {
	const builtin = join("core", "extensions", "builtin", id);
	return target.endsWith(`${sep}${builtin}.js`) || target.endsWith(`${sep}${builtin}.ts`);
}

// A generated shim whose target is gone stands for "load the default extension" from an install that no
// longer exists. Importing it can only fail with "Cannot find module", so it is skipped without an error.
const skipDeadGeneratedShim: ExtensionFactory = () => {};

/**
 * The factory for a generated default-extension shim in `agentDir/extensions`, for any agent dir a loader is given.
 * A generated shim only marks the default as installed: one that names the default's builtin always runs this
 * process's own builtin, whichever installation wrote it, so no loader imports another installation's builtin and its
 * module graph. `undefined` leaves any other file, a user's file of the same name included, to the regular import.
 */
export function resolveGeneratedDefaultExtensionFactory(
	extensionPath: string,
	agentDir: string,
): ExtensionFactory | undefined {
	const extensionId = findGlobalDefaultExtensionId(extensionPath, agentDir);
	if (!extensionId) return undefined;
	let target: string | undefined;
	try {
		target = generatedShimTarget(readFileSync(extensionPath, "utf-8"));
	} catch {
		// Unreadable: let the regular load report it.
		return undefined;
	}
	if (target === undefined) return undefined;
	if (!existsSync(target)) return skipDeadGeneratedShim;
	return namesBuiltin(target, extensionId) ? globalDefaultExtensionFactories[extensionId] : undefined;
}
