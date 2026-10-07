import { isLocalPath, resolvePath } from "../../utils/paths.ts";

/**
 * Local `--extension` paths are resolved against the invoking cwd, the same rule the global flag
 * follows, so a daemon child or a later thread cwd never reinterprets them. Package sources such
 * as `npm:` or git URLs pass through for the package manager to resolve.
 */
export function resolveAppServerExtensionPaths(extensions: readonly string[], cwd = process.cwd()): string[] {
	return extensions.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}
