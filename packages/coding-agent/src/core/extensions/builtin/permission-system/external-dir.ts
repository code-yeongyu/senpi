import { type BigIntStats, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";

export type AlwaysScope = "file" | "directory";

export function toParentDirectoryPattern(inputPath: string, scope: AlwaysScope, originalPath = inputPath): string {
	if (inputPath === "~" || inputPath === "$HOME") {
		return `${inputPath}/*`;
	}
	if (scope === "directory" || /[\\/]$/.test(originalPath)) {
		return inputPath.endsWith("/") || inputPath.endsWith("\\") ? `${inputPath}*` : `${inputPath}/*`;
	}
	if (inputPath.endsWith("/") || inputPath.endsWith("\\")) {
		return `${inputPath}*`;
	}
	const parentPattern = inputPath.replace(/[\\/][^\\/]+$/, "/*");
	if (parentPattern.replaceAll("\\", "/") === `${path.parse(inputPath).root.replaceAll("\\", "/")}*`) {
		return inputPath;
	}
	return parentPattern;
}

export function expandHome(inputPath: string): string {
	if (inputPath === "~") {
		return os.homedir();
	}
	if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
		return path.join(os.homedir(), inputPath.slice(2));
	}
	if (inputPath.startsWith("$HOME/") || inputPath.startsWith("$HOME\\")) {
		return path.join(os.homedir(), inputPath.slice(6));
	}
	if (inputPath === "$HOME") {
		return os.homedir();
	}
	return inputPath;
}

/** The resolved target if it is external, shared by classification and the permission request. */
export function resolveExternalPath(inputPath: string, cwd: string): string | undefined {
	const expandedPath = expandHome(inputPath);
	// Resolution must never open(2) a component (autofs triggers block, execute-only dirs EACCES):
	// realpathWithoutOpen walks lstat/readlink only, exactly what the classifier needs.
	const normalizedCwd = realpathWithoutOpen(cwd);
	const absolutePath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(normalizedCwd, expandedPath);
	const normalizedTarget = realpathWithoutOpen(absolutePath);

	if (normalizedTarget === normalizedCwd) {
		return undefined;
	}

	const cwdWithSeparator = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;

	if (normalizedTarget.startsWith(cwdWithSeparator)) return undefined;

	// Case-preserving spellings can name the same directory on a case-insensitive volume.
	// stat compares filesystem identity without opening a directory (unlike Bun's realpath).
	// Walk through missing descendants to their existing ancestor; never lowercase names,
	// since two differently cased directories can be distinct on a case-sensitive volume.
	let cwdIdentity: BigIntStats;
	try {
		cwdIdentity = statSync(normalizedCwd, { bigint: true });
	} catch {
		return normalizedTarget;
	}
	let ancestor = normalizedTarget;
	for (;;) {
		try {
			const identity = statSync(ancestor, { bigint: true });
			if (identity.dev === cwdIdentity.dev && identity.ino === cwdIdentity.ino) return undefined;
		} catch {
			// A missing or inaccessible component does not establish containment.
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) return normalizedTarget;
		ancestor = parent;
	}
}

export function isExternalPath(inputPath: string, cwd: string): boolean {
	return resolveExternalPath(inputPath, cwd) !== undefined;
}

function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes: string | null = null;
	let escaped = false;

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\") {
			escaped = true;
			current += char;
			continue;
		}

		if (inQuotes) {
			if (char === inQuotes) {
				inQuotes = null;
			}
			current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			inQuotes = char;
			current += char;
			continue;
		}

		if (char === " " || char === "\t") {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (current.length > 0) {
		tokens.push(current);
	}

	return tokens;
}

function unquote(token: string): string {
	if (token.length < 2) return token;
	const first = token[0];
	const last = token[token.length - 1];
	if ((first === '"' || first === "'") && first === last) {
		return token.slice(1, -1);
	}
	return token;
}

function looksLikePath(token: string): boolean {
	if (token.startsWith("-")) return false;
	if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) return false;
	if (["|", "||", "&&", ";", "&", "$(", "${", "`"].some((op) => token.includes(op))) {
		return false;
	}
	if (token.startsWith("/")) return true;
	if (token.startsWith("~")) return true;
	if (token.startsWith("$HOME")) return true;
	if (token.startsWith("./") || token.startsWith("../")) return true;
	if (token.includes("/")) return true;

	return false;
}

export function extractExternalPaths(command: string, cwd: string): string[] {
	const tokens = tokenizeCommand(command);
	const externalPaths: string[] = [];

	let startIndex = 0;
	if (tokens.length > 0) {
		const firstToken = unquote(tokens[0]);
		if (
			!firstToken.startsWith("/") &&
			!firstToken.startsWith("~") &&
			!firstToken.startsWith("$") &&
			!firstToken.startsWith("./") &&
			!firstToken.startsWith("../") &&
			!firstToken.includes("/")
		) {
			startIndex = 1;
		}
	}

	for (let i = startIndex; i < tokens.length; i++) {
		const token = unquote(tokens[i]);

		if (!looksLikePath(token)) {
			continue;
		}

		if (isExternalPath(token, cwd)) {
			externalPaths.push(token);
		}
	}

	return externalPaths;
}
