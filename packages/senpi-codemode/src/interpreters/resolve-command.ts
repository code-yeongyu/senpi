import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve as resolvePath } from "node:path";

export interface ResolveCommandPathOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly cwd?: string;
}

export type ResolveCommandPath = (command: string, options?: ResolveCommandPathOptions) => string | undefined;

const defaultWindowsPathExt = ".COM;.EXE;.BAT;.CMD";

/**
 * Resolves a bare command name to the absolute executable path a spawn would
 * use, by scanning PATH without spawning a process. Returns undefined when the
 * command cannot be resolved; callers treat that as "no display path known".
 */
export function resolveCommandPath(command: string, options: ResolveCommandPathOptions = {}): string | undefined {
	if (command.length === 0) return undefined;
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;
	const isWindows = platform === "win32";
	if (command.includes("/") || (isWindows && command.includes("\\"))) {
		const absolute = isAbsolute(command) ? command : resolvePath(options.cwd ?? process.cwd(), command);
		return firstExecutable(candidatesFor(absolute, isWindows, env), isWindows);
	}
	const pathValue = env.PATH ?? env.Path ?? "";
	if (pathValue.length === 0) return undefined;
	for (const directory of pathValue.split(delimiter)) {
		if (directory.length === 0) continue;
		const base = `${directory}${directory.endsWith("/") || directory.endsWith("\\") ? "" : pathSeparatorFor(directory, isWindows)}${command}`;
		const found = firstExecutable(candidatesFor(base, isWindows, env), isWindows);
		if (found !== undefined) return found;
	}
	return undefined;
}

function pathSeparatorFor(directory: string, isWindows: boolean): string {
	if (isWindows && directory.includes("\\") && !directory.includes("/")) return "\\";
	return "/";
}

function candidatesFor(base: string, isWindows: boolean, env: NodeJS.ProcessEnv): readonly string[] {
	if (!isWindows) return [base];
	const extensions = (env.PATHEXT ?? defaultWindowsPathExt)
		.split(";")
		.map((extension) => extension.trim())
		.filter((extension) => extension.startsWith("."));
	const candidates = [base];
	for (const extension of extensions) {
		candidates.push(`${base}${extension.toLowerCase()}`, `${base}${extension}`);
	}
	return candidates;
}

function firstExecutable(candidates: readonly string[], isWindows: boolean): string | undefined {
	for (const candidate of candidates) {
		try {
			if (!statSync(candidate).isFile()) continue;
			if (!isWindows) accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Missing or non-executable candidate: keep scanning the remaining ones.
		}
	}
	return undefined;
}
