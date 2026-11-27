import { homedir } from "node:os";
import path from "node:path";
import { realpathWithoutOpen } from "./realpath-without-open.ts";

// macOS asks the user before a process reads any of these (TCC): the home folders, and under ~/Library the Mail,
// Messages, Safari, Calendar, Contacts, iCloud Drive and other apps' data; removable and network volumes under
// /Volumes and /Network; and /System/Volumes, the data volume's second path to all of them. A search that walks into
// one raises a prompt on the searching process's behalf, again for every new binary of it (omo#15240).
const DARWIN_PROTECTED_FOLDERS = [
	"~/Desktop",
	"~/Documents",
	"~/Downloads",
	"~/Library",
	"~/Movies",
	"~/Music",
	"~/Pictures",
	"/Network",
	"/System/Volumes",
	"/Volumes",
];

// The data volume is also mounted at /System/Volumes/Data, and firmlinks make /System/Volumes/Data/Users/<me>/Desktop
// the same folder as ~/Desktop. realpath does not map one spelling onto the other, so each protected folder outside
// /System/Volumes is also named through the data volume; a walk started at or under /System/Volumes then still skips it.
const DARWIN_DATA_VOLUME = "/System/Volumes/Data";

/** Folders a walk never enters unless it started at or inside one; compared the way the platform's volume does. */
export interface ProtectedDirs {
	readonly paths: readonly string[];
	readonly caseInsensitive: boolean;
}

export function privacyProtectedDirs(
	platform: NodeJS.Platform = process.platform,
	// HOME first, as Node's os.homedir() reads it on every call; Bun's keeps the home it saw first.
	home: string = process.env.HOME || homedir(),
): ProtectedDirs {
	if (platform !== "darwin") return { paths: [], caseInsensitive: false };
	const named = DARWIN_PROTECTED_FOLDERS.map((folder) =>
		folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder,
	);
	const dataVolume = named
		.filter((folder) => !folder.startsWith("/System/Volumes"))
		.map((folder) => path.join(DARWIN_DATA_VOLUME, folder));
	return { paths: [...named, ...dataVolume], caseInsensitive: true };
}

/** The protected folders strictly below one walk's start: `excluded` as fd globs relative to it, `skips` per directory. */
export interface WalkGuard {
	readonly excluded: readonly string[];
	skips(dir: string): boolean;
}

export function walkGuard(searchPath: string, dirs: ProtectedDirs): WalkGuard {
	const fold = (p: string): string => (dirs.caseInsensitive ? p.normalize("NFC").toLowerCase() : p);
	// Both sides are compared as the folders they name: a symlinked alias of the start or of HOME reaches the same
	// folders. realpathWithoutOpen never opens a component, so an automount trigger such as /Network is never mounted.
	const start = path.resolve(searchPath);
	const canonicalStart = fold(realpathWithoutOpen(start));
	const excluded: string[] = [];
	const skipped = new Set<string>();
	for (const dir of dirs.paths) {
		const relative = path.relative(canonicalStart, fold(realpathWithoutOpen(dir)));
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
		const segments = relative.split(path.sep);
		skipped.add(fold(path.join(start, ...segments)));
		excluded.push(fdGlob(segments, dirs.caseInsensitive));
	}
	return { excluded, skips: (dir) => skipped.has(fold(path.resolve(dir))) };
}

// fd matches excludes case-sensitively, so on a case-insensitive volume every letter becomes a two-case class and the
// exclude matches the folder however the disk spells it. Glob syntax in a name is escaped to match literally.
function fdGlob(segments: readonly string[], caseInsensitive: boolean): string {
	const literal = segments.join("/").replace(/[*?[\]{}\\]/g, "\\$&");
	if (!caseInsensitive) return literal;
	return literal.replace(/\p{L}/gu, (letter) => {
		const lower = letter.toLowerCase();
		const upper = letter.toUpperCase();
		return lower === upper ? letter : `[${lower}${upper}]`;
	});
}
