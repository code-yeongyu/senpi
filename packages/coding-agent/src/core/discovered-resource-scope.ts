import { basename, dirname, resolve, sep } from "node:path";
import type { Extension } from "./extensions/types.ts";
import type { PathMetadata } from "./package-manager.ts";
import type { SourceScope } from "./source-info.ts";

export interface DiscoveredResourceEntry {
	readonly path: string;
	readonly extensionPath: string;
	/** Scope the handler pinned explicitly; an entry without one inherits it from the contributor. */
	readonly scope?: SourceScope;
}

export interface DiscoveredResourcePath {
	readonly path: string;
	readonly metadata: PathMetadata;
}

type ContributingExtension = Pick<Extension, "path" | "sourceInfo">;

export function getExtensionSourceLabel(extensionPath: string): string {
	if (extensionPath.startsWith("<")) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	return `extension:${basename(extensionPath).replace(/\.(ts|js)$/, "")}`;
}

/**
 * Turn discover results into loader metadata. A contributed path is `system` when the handler said so,
 * or when it comes from a builtin extension, or when a system package contributes a path inside its
 * own payload; everything else keeps the `temporary` scope contributed paths always had.
 */
export function resolveDiscoveredResourcePaths(
	entries: readonly DiscoveredResourceEntry[],
	extensions: readonly ContributingExtension[],
): DiscoveredResourcePath[] {
	const contributors = new Map(extensions.map((extension) => [extension.path, extension]));
	return entries.map((entry) => {
		const contributor = contributors.get(entry.extensionPath);
		const scope =
			entry.scope ??
			(contributor !== undefined && inheritsSystemScope(contributor, entry.path) ? "system" : "temporary");
		return {
			path: entry.path,
			metadata: {
				source: getExtensionSourceLabel(entry.extensionPath),
				scope,
				origin: "top-level",
				baseDir: entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath),
			},
		};
	});
}

function inheritsSystemScope(contributor: ContributingExtension, resourcePath: string): boolean {
	if (contributor.sourceInfo.scope !== "system") return false;
	if (contributor.path.startsWith("<builtin:")) return true;
	const packageRoot = contributor.sourceInfo.baseDir;
	return packageRoot !== undefined && isUnderPath(resolve(resourcePath), resolve(packageRoot));
}

function isUnderPath(target: string, root: string): boolean {
	if (target === root) return true;
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return target.startsWith(prefix);
}
