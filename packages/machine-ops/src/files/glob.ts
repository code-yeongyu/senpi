import { spawn } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { MachineOpError } from "../errors.ts";
import type { GlobResult } from "../types.ts";

/** Resolves the `fd` binary; undefined means fd is unavailable. */
export type FdResolver = () => Promise<string | undefined>;

const DEFAULT_LIMIT = 1000;
const WALK_SKIP = new Set([".git", "node_modules"]);

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function isMissing(dir: string): Promise<boolean> {
	try {
		await stat(dir);
		return false;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR";
	}
}

/** Look `fd` (or Debian's `fdfind`) up on PATH. */
export async function findFdOnPath(): Promise<string | undefined> {
	const names = process.platform === "win32" ? ["fd.exe"] : ["fd", "fdfind"];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = path.join(dir, name);
			try {
				await access(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here.
			}
		}
	}
	return undefined;
}

/**
 * The fd search the built-in find/glob tools have always run: gitignore-aware inside a repository (parent
 * .gitignore rules stop at nested repo boundaries), `--no-require-git` outside one, hidden files included, and a
 * path-containing pattern matched against the full path. Error text is the tool's own.
 */
export function runFdGlob(
	fdPath: string,
	pattern: string,
	searchPath: string,
	limit: number,
	signal: AbortSignal,
): Promise<GlobResult> {
	return (async () => {
		const args: string[] = ["--glob", "--color=never", "--hidden"];
		// fd normally ignores .gitignore outside git repos, so keep --no-require-git there. Inside repos, use fd's
		// default git-aware behavior so parent .gitignore rules stop at nested repo boundaries:
		// https://github.com/earendil-works/pi/issues/5960
		let insideGitRepo = false;
		for (let current = searchPath; ;) {
			if (await pathExists(path.join(current, ".git"))) {
				insideGitRepo = true;
				break;
			}
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		if (!insideGitRepo) args.push("--no-require-git");
		args.push("--max-results", String(limit));

		// fd --glob matches against the basename unless --full-path is set; in --full-path mode it matches against
		// the absolute candidate path, so a path-containing pattern like 'src/**/*.spec.ts' needs a leading '**/'.
		let effectivePattern = pattern;
		if (pattern.includes("/")) {
			args.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
				effectivePattern = `**/${pattern}`;
			}
			// fd matches full paths using native separators on Windows.
			if (process.platform === "win32") effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
		}
		args.push("--", effectivePattern, searchPath);
		if (signal.aborted) throw new MachineOpError("aborted", "Operation aborted");

		const lines = await new Promise<string[]>((resolve, reject) => {
			const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
			const rl = createInterface({ input: child.stdout });
			let stderr = "";
			const collected: string[] = [];
			const onAbort = () => {
				// A child whose spawn failed has no pid; kill() on it would signal our own process group.
				if (child.pid !== undefined && !child.killed) child.kill();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			rl.on("line", (line) => {
				collected.push(line);
			});
			child.on("error", (error) => {
				rl.close();
				signal.removeEventListener("abort", onAbort);
				reject(new MachineOpError("io_error", `Failed to run fd: ${error.message}`, { cause: error }));
			});
			child.on("close", (code) => {
				rl.close();
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) {
					reject(new MachineOpError("aborted", "Operation aborted"));
					return;
				}
				if (code !== 0 && collected.join("\n") === "") {
					const message = stderr.trim() || `fd exited with code ${code}`;
					void isMissing(searchPath).then((missing) =>
						reject(new MachineOpError(missing ? "not_found" : "io_error", message)),
					);
					return;
				}
				resolve(collected);
			});
		});
		const entries: { path: string }[] = [];
		for (const rawLine of lines) {
			const line = rawLine.replace(/\r$/, "").trim();
			if (line) entries.push({ path: line });
		}
		return { entries, truncated: entries.length >= limit };
	})();
}

/** Glob syntax (`**`, `*`, `?`, `{a,b}`, `[...]`) to a whole-string regular expression over `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	let braceDepth = 0;
	for (let index = 0; index < glob.length; index += 1) {
		const char = glob[index];
		if (char === "*") {
			if (glob[index + 1] === "*") {
				const slashFollows = glob[index + 2] === "/";
				source += slashFollows ? "(?:.*/)?" : ".*";
				index += slashFollows ? 2 : 1;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else if (char === "{") {
			braceDepth += 1;
			source += "(?:";
		} else if (char === "}" && braceDepth > 0) {
			braceDepth -= 1;
			source += ")";
		} else if (char === "," && braceDepth > 0) source += "|";
		else if (char === "[") {
			const close = glob.indexOf("]", index + 1);
			if (close === -1) source += "\\[";
			else {
				source += `[${glob
					.slice(index + 1, close)
					.replace(/^!/, "^")
					.replace(/\\/g, "\\\\")}]`;
				index = close;
			}
		} else source += char.replace(/[.+^$()|\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

/** Pure-Node fallback when no fd exists: skips .git and node_modules, does not read .gitignore. */
export async function walkGlob(
	pattern: string,
	searchPath: string,
	limit: number,
	signal: AbortSignal,
): Promise<GlobResult> {
	const matcher = globToRegExp(pattern.replace(/^\.\//, ""));
	const matchBasename = !pattern.includes("/");
	const entries: { path: string }[] = [];
	const pending = [searchPath];
	await stat(searchPath);
	while (pending.length > 0 && entries.length < limit) {
		if (signal.aborted) throw new MachineOpError("aborted", "Operation aborted");
		const dir = pending.shift() as string;
		let dirents: Dirent[];
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const dirent of dirents) {
			if (WALK_SKIP.has(dirent.name)) continue;
			const full = path.join(dir, dirent.name);
			const relative = path.relative(searchPath, full).split(path.sep).join("/");
			if (matcher.test(matchBasename ? dirent.name : relative)) {
				entries.push({ path: full });
				if (entries.length >= limit) break;
			}
			if (dirent.isDirectory()) pending.push(full);
		}
	}
	return { entries, truncated: entries.length >= limit };
}

export async function localGlob(
	pattern: string,
	searchPath: string,
	limit: number | undefined,
	signal: AbortSignal,
	resolveFd: FdResolver | undefined,
): Promise<GlobResult> {
	const effectiveLimit = limit ?? DEFAULT_LIMIT;
	if (resolveFd !== undefined) {
		const fdPath = await resolveFd();
		if (signal.aborted) throw new MachineOpError("aborted", "Operation aborted");
		if (!fdPath) throw new MachineOpError("io_error", "fd is not available and could not be downloaded");
		return runFdGlob(fdPath, pattern, searchPath, effectiveLimit, signal);
	}
	const fdPath = await findFdOnPath();
	if (fdPath !== undefined) return runFdGlob(fdPath, pattern, searchPath, effectiveLimit, signal);
	return walkGlob(pattern, searchPath, effectiveLimit, signal);
}
