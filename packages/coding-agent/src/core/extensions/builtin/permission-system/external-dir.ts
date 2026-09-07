import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

/** Symlink hops allowed while resolving one path; realpath(3) reports ELOOP past this. */
const MAX_SYMLINK_HOPS = 40;

function splitComponents(normalizedPath: string): { readonly root: string; readonly parts: readonly string[] } {
	const { root } = path.parse(normalizedPath);
	const parts = normalizedPath
		.slice(root.length)
		.split(path.sep)
		.filter((part) => part.length > 0);
	return { root, parts };
}

/**
 * Resolve symlinks the way realpath(3) does — one lstat/readlink per component — without ever
 * open(2)-ing a component. Bun's `fs.realpath*` opens every directory it resolves, so an autofs
 * trigger such as macOS `/home` blocks the whole process (the classifier runs on the host main
 * thread, freezing the TUI) and an execute-only directory fails with EACCES; lstat needs only
 * search permission and never mounts anything. Components from the first missing one onward are
 * kept verbatim, so a file that does not exist yet still lands where its symlinked parent points.
 */
function normalizePath(inputPath: string): string {
	const { root, parts } = splitComponents(path.normalize(inputPath));
	const pending = [...parts];
	let resolved = root;
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift();
		if (part === undefined) break;
		const candidate = path.join(resolved, part);
		let link: string;
		try {
			if (!fs.lstatSync(candidate).isSymbolicLink()) {
				resolved = candidate;
				continue;
			}
			hops += 1;
			if (hops > MAX_SYMLINK_HOPS) return path.join(candidate, ...pending);
			link = fs.readlinkSync(candidate);
		} catch {
			return path.join(candidate, ...pending);
		}
		const target = splitComponents(path.resolve(resolved, link));
		resolved = target.root;
		pending.unshift(...target.parts);
	}
	return resolved;
}

export function isExternalPath(inputPath: string, cwd: string): boolean {
	const expandedPath = expandHome(inputPath);
	const normalizedCwd = normalizePath(cwd);
	const absolutePath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(normalizedCwd, expandedPath);
	const normalizedTarget = normalizePath(absolutePath);

	if (normalizedTarget === normalizedCwd) {
		return false;
	}

	const cwdWithSeparator = normalizedCwd.endsWith(path.sep) ? normalizedCwd : normalizedCwd + path.sep;

	return !normalizedTarget.startsWith(cwdWithSeparator);
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
