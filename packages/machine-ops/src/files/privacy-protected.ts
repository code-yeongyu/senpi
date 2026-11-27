import { homedir } from "node:os";
import path from "node:path";

// macOS asks the user before a process reads any of these (TCC): the home folders below, and under ~/Library the Mail,
// Messages, Safari, Calendar, Contacts, iCloud Drive and other apps' data; removable and network volumes under
// /Volumes and /Network; and /System/Volumes, the data volume's second path to all of them. A search that walks into
// one raises a prompt on the searching process's behalf, again for every new binary of it (omo#15240).
const DARWIN_HOME_FOLDERS = ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"];
const DARWIN_SYSTEM_FOLDERS = ["/Network", "/System/Volumes", "/Volumes"];

/** Folders a walk never enters unless it started at or inside one; compared the way the platform's volume does. */
export interface ProtectedDirs {
	readonly paths: readonly string[];
	readonly caseInsensitive: boolean;
}

export function privacyProtectedDirs(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
): ProtectedDirs {
	if (platform !== "darwin") return { paths: [], caseInsensitive: false };
	return {
		paths: [...DARWIN_HOME_FOLDERS.map((name) => path.join(home, name)), ...DARWIN_SYSTEM_FOLDERS],
		caseInsensitive: true,
	};
}

/** The protected folders strictly below one walk's start: `excluded` relative to it, `skips` for each directory met. */
export interface WalkGuard {
	readonly excluded: readonly string[];
	skips(dir: string): boolean;
}

export function walkGuard(searchPath: string, dirs: ProtectedDirs): WalkGuard {
	const fold = (p: string): string => (dirs.caseInsensitive ? p.normalize("NFC").toLowerCase() : p);
	const start = path.resolve(searchPath);
	const excluded: string[] = [];
	const skipped = new Set<string>();
	for (const dir of dirs.paths) {
		const relative = path.relative(fold(start), fold(dir));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		// The relative part spelled as the folder itself is, so it names the entries a walk meets on disk.
		const segments = dir.split(path.sep).slice(-relative.split(path.sep).length);
		excluded.push(segments.join("/"));
		skipped.add(fold(path.join(start, ...segments)));
	}
	return { excluded, skips: (dir) => skipped.has(fold(path.resolve(dir))) };
}
