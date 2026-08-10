import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { hasGeneratedShimBanner } from "../../../generated-shim-banner.ts";

function isInsideExtensionsDirectory(path: string, agentDir: string): boolean {
	return resolve(dirname(path)) === resolve(agentDir, "extensions");
}

function isGeneratedShim(path: string): boolean {
	try {
		return hasGeneratedShimBanner(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

/**
 * Drops changes to senpi's own generated global-default extension shims.
 *
 * The shim records the running build's absolute module path, so two sessions
 * that reached the same build by different paths (npm bin symlink versus the
 * real checkout), or two genuinely different builds, rewrite it in a loop:
 * every rewrite reloads every other session, which rewrites it back. A running
 * session already loaded its own extensions, so another session's shim rewrite
 * is never a reason to reload. Content-based like the routine-settings filter,
 * because the self-write tracker is process-local and cannot see siblings.
 *
 * A shim the user replaced with real content loses the banner and is watched
 * again.
 */
export function excludeGeneratedExtensionShims(paths: readonly string[], agentDir: string): string[] {
	return paths.filter((path) => !(isInsideExtensionsDirectory(path, agentDir) && isGeneratedShim(path)));
}
