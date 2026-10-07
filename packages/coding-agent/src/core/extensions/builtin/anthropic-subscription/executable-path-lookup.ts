import { posix, win32 } from "node:path";

export type PathLookupDeps = {
	platform: string;
	env: (name: string) => string | undefined;
	/** True when `path` names an existing regular file in THIS process. */
	isFile: (path: string) => boolean;
	/** Text of a win32 batch file on PATH; without it batch files are skipped, never returned. */
	readText?: (path: string) => string | undefined;
	/** Called for each win32 batch file that was skipped because it wraps no native binary. */
	onSkip?: (path: string) => void;
};

const WIN32_BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);

/**
 * The target of an npm cmd-shim (`"%dp0%\node_modules\...\claude.exe"   %*`, older shims spell
 * `%~dp0`). npm installs Claude Code on Windows as such a shim around its native `bin\claude.exe`.
 */
const CMD_SHIM_NATIVE_TARGET = /"%~?dp0%?\\([^"%]+?\.exe)"/i;

/**
 * The native binary a win32 batch file on PATH wraps. The SDK spawns without a shell and Node
 * refuses to exec `.cmd`/`.bat` directly, so a batch file itself is never a usable candidate.
 */
function nativeTargetOfBatchFile(batchPath: string, deps: PathLookupDeps): string | undefined {
	const text = deps.readText?.(batchPath);
	const match = text === undefined ? null : CMD_SHIM_NATIVE_TARGET.exec(text);
	if (!match?.[1]) return undefined;
	const target = win32.join(win32.dirname(batchPath), match[1]);
	return deps.isFile(target) ? target : undefined;
}

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
 * finds `claude.exe`; a `.cmd`/`.bat` hit resolves to the native binary it wraps or is skipped.
 * Directories and dangling entries are skipped, so a hit is a file this process can stat. Returns
 * `undefined` when PATH is unset or has no match.
 */
export function findExecutableOnPath(name: string, deps: PathLookupDeps): string | undefined {
	const join = deps.platform === "win32" ? win32.join : posix.join;
	const names = namesToProbe(name, deps.platform, deps.env("PATHEXT"));
	for (const directory of pathDirectories(deps.platform, deps.env("PATH"))) {
		for (const candidate of names) {
			const path = join(directory, candidate);
			if (!deps.isFile(path)) continue;
			if (deps.platform !== "win32" || !WIN32_BATCH_EXTENSIONS.has(win32.extname(path).toLowerCase())) return path;
			const target = nativeTargetOfBatchFile(path, deps);
			if (target !== undefined) return target;
			deps.onSkip?.(path);
		}
	}
	return undefined;
}
