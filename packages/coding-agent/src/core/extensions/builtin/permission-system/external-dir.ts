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

const MAX_SYMLINK_HOPS = 40;

function splitSegments(value: string): string[] {
	return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/**
 * realpath(3) equivalent that resolves symlinks with lstat + readlink only.
 *
 * This runs on the host main thread for every classified path, so it must never
 * open(2) a component: Bun implements realpathSync (and its native variant) with
 * open(), which forces an automount for autofs triggers such as /home or /net and
 * blocks forever on a wedged map, freezing the whole TUI. lstat and readlink never
 * open the entry they inspect. Trailing components that do not exist are kept
 * verbatim after the last resolvable one, and any other failure falls back to the
 * unresolved path, matching the previous realpathSync-based behaviour.
 */
function normalizePath(inputPath: string): string {
	const normalized = path.normalize(inputPath);
	const root = path.parse(normalized).root;
	const pending = splitSegments(normalized.slice(root.length));
	let resolved = root;
	let hops = 0;

	while (pending.length > 0) {
		const segment = pending.shift();
		if (segment === undefined || segment === ".") continue;
		if (segment === "..") {
			resolved = path.dirname(resolved);
			continue;
		}

		const candidate = path.join(resolved, segment);
		let linkTarget: string | undefined;
		try {
			const entry = fs.lstatSync(candidate, { throwIfNoEntry: false });
			if (!entry) return path.join(candidate, ...pending);
			if (entry.isSymbolicLink()) linkTarget = fs.readlinkSync(candidate);
		} catch {
			return normalized;
		}

		if (linkTarget === undefined) {
			resolved = candidate;
			continue;
		}
		if (++hops > MAX_SYMLINK_HOPS) return normalized;

		const target = path.normalize(linkTarget);
		const targetRoot = path.parse(target).root;
		if (targetRoot.length > 0) resolved = targetRoot;
		pending.unshift(...splitSegments(target.slice(targetRoot.length)));
	}

	return resolved.length > 0 ? resolved : normalized;
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
