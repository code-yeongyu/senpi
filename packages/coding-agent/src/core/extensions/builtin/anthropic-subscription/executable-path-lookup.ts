import { posix, win32 } from "node:path";

export type PathLookupDeps = {
	platform: string;
	env: (name: string) => string | undefined;
	/** True when `path` names an existing regular file in THIS process. */
	isFile: (path: string) => boolean;
};

/** What Windows uses when PATHEXT is unset; the executable image types come first, as `where` orders them. */
const WIN32_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** Spellings `where`/`command -v` would test for `name` inside one PATH directory. */
function namesToProbe(name: string, platform: string, pathext: string | undefined): string[] {
	if (platform !== "win32") return [name];
	const extensions = (pathext ?? WIN32_DEFAULT_PATHEXT)
		.split(";")
		.filter((extension) => extension.length > 0)
		.map((extension) => extension.toLowerCase());
	return extensions.map((extension) => `${name}${extension}`);
}

/** Entries of PATH in order, dropping empties; `cmd.exe` accepts quoted entries, so they are unquoted here. */
function pathDirectories(platform: string, path: string | undefined): string[] {
	if (path === undefined) return [];
	const delimiter = platform === "win32" ? ";" : ":";
	return path
		.split(delimiter)
		.map((entry) => (platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry))
		.filter((entry) => entry.length > 0);
}

/**
 * The first regular file `name` resolves to on PATH - the binary `where claude` (win32) or
 * `command -v claude` prints - found without a shell. Honours PATHEXT on win32 so the bare `claude`
 * finds `claude.exe`. Directories and dangling entries are skipped, so a hit is a file this process
 * can stat. Returns `undefined` when PATH is unset or has no match.
 */
export function findExecutableOnPath(name: string, deps: PathLookupDeps): string | undefined {
	const join = deps.platform === "win32" ? win32.join : posix.join;
	const names = namesToProbe(name, deps.platform, deps.env("PATHEXT"));
	for (const directory of pathDirectories(deps.platform, deps.env("PATH"))) {
		for (const candidate of names) {
			const path = join(directory, candidate);
			if (deps.isFile(path)) return path;
		}
	}
	return undefined;
}
