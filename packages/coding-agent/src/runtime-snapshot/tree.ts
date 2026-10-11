import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

export type FilePairs = [string, string][];
export const UNLOADED_FILE = /\.(?:d\.[cm]?ts|map)$/;

export function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

/** Follow links into independent files; dependencies are placed separately from their parents. */
export function planTree(
	source: string,
	target: string,
	files: FilePairs,
	skipModules: boolean,
	seen = new Set<string>(),
	excluded: (relativePath: string) => boolean = () => false,
	relativeDir = "",
): void {
	const real = realpathSync(source);
	if (seen.has(real)) return;
	seen.add(real);
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(real, { withFileTypes: true })) {
		if (skipModules && entry.name === "node_modules") continue;
		const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
		if (excluded(relativePath)) continue;
		const from = join(real, entry.name);
		const to = join(target, entry.name);
		if (entry.isDirectory()) {
			planTree(from, to, files, skipModules, seen, excluded, relativePath);
		} else if (entry.isFile()) {
			if (!UNLOADED_FILE.test(entry.name)) files.push([from, to]);
		} else if (entry.isSymbolicLink()) {
			let isDirectory: boolean;
			try {
				isDirectory = statSync(from).isDirectory();
			} catch (error) {
				if (isMissing(error)) continue;
				throw error;
			}
			if (isDirectory) planTree(from, to, files, skipModules, seen, excluded, relativePath);
			else if (!UNLOADED_FILE.test(entry.name)) files.push([realpathSync(from), to]);
		}
	}
	seen.delete(real);
}
