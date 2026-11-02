/** How a platform compares paths: darwin and win32 fold case; win32 also treats `/` and `\` alike. */
export type PathPlatform = "posix" | "darwin" | "win32";

export function currentPathPlatform(): PathPlatform {
	if (process.platform === "win32") return "win32";
	return process.platform === "darwin" ? "darwin" : "posix";
}

export function pathSegments(path: string, platform: PathPlatform): string[] {
	if (platform !== "win32") return path.split("/").filter((segment) => segment.length > 0);
	const stripped = path.startsWith("\\\\?\\UNC\\")
		? `\\\\${path.slice(8)}`
		: path.startsWith("\\\\?\\")
			? path.slice(4)
			: path;
	return stripped.split(/[\\/]/).filter((segment) => segment.length > 0);
}

export function sameSegment(a: string, b: string, platform: PathPlatform): boolean {
	return platform === "posix" ? a === b : a.toLowerCase() === b.toLowerCase();
}

function startsWithSegments(path: readonly string[], prefix: readonly string[], platform: PathPlatform): boolean {
	return (
		prefix.length <= path.length &&
		prefix.every((segment, index) => sameSegment(path[index] ?? "", segment, platform))
	);
}

export interface MovedPrefixMatch {
	readonly prefix: readonly string[];
	/** `path`'s segments below `root`, in the spelling `path` used. */
	readonly remainder: readonly string[];
}

/** The listed prefix `path` lies under (on a segment boundary) relative to `root`, if any. */
export function matchMovedPrefix(
	path: string,
	root: string,
	moved: readonly (readonly string[])[],
	platform: PathPlatform,
): MovedPrefixMatch | undefined {
	const pathParts = pathSegments(path, platform);
	const rootParts = pathSegments(root, platform);
	if (!startsWithSegments(pathParts, rootParts, platform)) return undefined;
	const remainder = pathParts.slice(rootParts.length);
	const prefix = moved.find((candidate) => startsWithSegments(remainder, candidate, platform));
	return prefix ? { prefix, remainder } : undefined;
}
