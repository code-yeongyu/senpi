import type { PathMetadata } from "./package-manager.ts";

/**
 * Where a resource comes from. `system` marks resources the harness itself provides: builtin and bundled
 * extensions, command-line packages whose manifest declares `pi.system`, and what those contribute.
 */
export type SourceScope = "user" | "project" | "temporary" | "system";
export type SourceOrigin = "package" | "top-level";

export interface SourceInfo {
	path: string;
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	baseDir?: string;
}

/** Prefix of built-in tool and extension paths, such as `builtin:read` or `builtin:mcp`. */
export const BUILTIN_PATH_PREFIX = "builtin:";

/**
 * Source of a path that names no file: `builtin` for `builtin:<name>`, or the prefix of an
 * angle-bracket path such as `inline` for `<inline:name>`. Undefined for file paths.
 */
export function getSyntheticPathSource(path: string): string | undefined {
	if (path.startsWith(BUILTIN_PATH_PREFIX)) return "builtin";
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1).split(":")[0] || "temporary";
	return undefined;
}

export function isSyntheticPath(path: string): boolean {
	return path.startsWith(BUILTIN_PATH_PREFIX) || path.startsWith("<");
}

export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
