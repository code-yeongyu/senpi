import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const RUNTIME_SNAPSHOT_MARKER = "runtime-snapshot.json";

export interface RuntimeSnapshotMarker {
	readonly buildId: string;
	readonly installPackageDir: string;
}

export function readRuntimeSnapshotMarker(packageRoot: string): RuntimeSnapshotMarker | undefined {
	let text: string;
	try {
		text = readFileSync(join(packageRoot, RUNTIME_SNAPSHOT_MARKER), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			return undefined;
		}
		throw error;
	}
	const parsed: unknown = JSON.parse(text);
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"buildId" in parsed &&
		typeof parsed.buildId === "string" &&
		"installPackageDir" in parsed &&
		typeof parsed.installPackageDir === "string"
	) {
		return { buildId: parsed.buildId, installPackageDir: parsed.installPackageDir };
	}
	return undefined;
}

/**
 * Maps a path inside a runtime snapshot to the same path inside the install it was taken from.
 * Install-method detection, self-update and quarantine logic reason about where the package
 * manager put the package, which a process running from its snapshot would otherwise misread.
 */
export function resolveInstallPath(path: string, packageRoot: string): string {
	const marker = readRuntimeSnapshotMarker(packageRoot);
	if (!marker) return path;
	const inside = relative(packageRoot, path);
	if (inside.startsWith("..") || isAbsolute(inside)) return path;
	return join(marker.installPackageDir, inside);
}
