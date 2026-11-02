import { type BigIntStats, lstatSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";
import { realpathWithoutOpen } from "../../../../utils/paths.ts";
import { Wildcard } from "./wildcard.ts";

/** Recover on-disk case without replacing any lexical ancestor with its symlink target. */
export function canonicalPathCase(
	value: string,
	listDirectory: (directory: string) => readonly string[] = readdirSync,
): string {
	if (!isAbsolute(value)) return value;
	const root = parse(value).root;
	const parts = value.slice(root.length).split(sep).filter(Boolean);
	let parent = root;
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		try {
			const entries = listDirectory(parent);
			if (!entries.includes(part)) {
				const identity = lstatSync(`${parent}${parent.endsWith(sep) ? "" : sep}${part}`, { bigint: true });
				const spelling = entries.find((entry) => {
					if (entry.toLowerCase() !== part.toLowerCase()) return false;
					const candidate = lstatSync(`${parent}${parent.endsWith(sep) ? "" : sep}${entry}`, { bigint: true });
					return candidate.dev === identity.dev && candidate.ino === identity.ino;
				});
				if (spelling !== undefined) parts[index] = spelling;
			}
		} catch {
			// Missing or unreadable components have no proven alternative spelling.
			return `${parent}${parent.endsWith(sep) ? "" : sep}${parts.slice(index).join(sep)}`;
		}
		parent = `${parent}${parent.endsWith(sep) ? "" : sep}${parts[index]}`;
	}
	return parent;
}

/** Case aliases must name the same component, not merely symlinks to the same destination. */
export function sameLexicalPath(left: string, right: string): boolean {
	if (left === right) return true;
	if (left.toLowerCase() !== right.toLowerCase()) return false;
	const leftRoot = parse(left).root;
	const rightRoot = parse(right).root;
	const leftParts = left.slice(leftRoot.length).split(sep);
	const rightParts = right.slice(rightRoot.length).split(sep);
	try {
		for (let index = 0; index < leftParts.length; index++) {
			if (leftParts[index] === rightParts[index]) continue;
			const a = lstatSync(leftRoot + leftParts.slice(0, index + 1).join(sep), { bigint: true });
			const b = lstatSync(rightRoot + rightParts.slice(0, index + 1).join(sep), { bigint: true });
			if (a.dev !== b.dev || a.ino !== b.ino) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Keep filesystem observations within one evaluation, never across permission decisions. */
export function createExternalPathMatcher(
	preserveAncestry = false,
	canonicalCase = canonicalPathCase,
): (value: string, pattern: string) => boolean {
	const resolved = new Map<string, string>();
	const identities = new Map<string, BigIntStats | Error>();
	const realpath = (value: string): string => {
		let result = resolved.get(value);
		if (result === undefined) {
			result = preserveAncestry ? canonicalCase(value) : realpathWithoutOpen(value);
			resolved.set(value, result);
		}
		return result;
	};
	const stat = (value: string): BigIntStats => {
		let result = identities.get(value);
		if (result === undefined) {
			try {
				result = statSync(value, { bigint: true });
			} catch (error) {
				result = error as Error;
			}
			identities.set(value, result);
		}
		if (result instanceof Error) throw result;
		return result;
	};
	return (value, pattern) => matchesExternalPath(value, pattern, realpath, stat, preserveAncestry);
}

/**
 * Match the literal prefix and glob components by filesystem identity.
 * This also covers remembered scopes and missing descendants. Lexical matching keeps ancestry
 * and canonicalizes case through directory entries; resolved matching follows literal prefixes.
 * A case-sensitive filesystem gives distinct prefixes distinct device/inode pairs.
 */
function matchesExternalPath(
	value: string,
	pattern: string,
	realpath: (value: string) => string,
	stat: (value: string) => BigIntStats,
	preserveAncestry: boolean,
): boolean {
	if (!isAbsolute(value) || !isAbsolute(pattern)) return false;
	const wildcard = pattern.search(/[*?]/);
	const boundary =
		wildcard < 0 ? pattern.length : Math.max(pattern.lastIndexOf("/", wildcard), pattern.lastIndexOf(sep, wildcard));
	let prefix = wildcard < 0 ? pattern : pattern.slice(0, boundary + 1);
	const suffix = wildcard < 0 ? [] : [pattern.slice(boundary + 1)];
	prefix = realpath(prefix);
	let identity: BigIntStats;
	for (;;) {
		try {
			identity = stat(prefix);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
			const parent = dirname(prefix);
			if (parent === prefix) return false;
			suffix.unshift(basename(prefix));
			prefix = parent;
		}
	}

	let ancestor = realpath(value);
	const tail: string[] = [];
	for (;;) {
		try {
			const candidate = stat(ancestor);
			if (
				candidate.dev === identity.dev &&
				candidate.ino === identity.ino &&
				(!preserveAncestry || sameLexicalPath(ancestor, prefix))
			) {
				if (tail.length === 0 && suffix.length > 0) return false;
				return matchesSuffix(ancestor, tail, suffix.join("/").split(sep).join("/"));
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") return false;
		}
		const parent = dirname(ancestor);
		if (parent === ancestor) return false;
		tail.unshift(basename(ancestor));
		ancestor = parent;
	}
}

function matchesComponent(parent: string, value: string, pattern: string): boolean {
	if (Wildcard.match(value, pattern)) return true;
	if (!Wildcard.match(value.toLowerCase(), pattern.toLowerCase())) return false;

	// Instantiate the rule's literal spelling, retaining what each wildcard consumed.
	// Case-insensitive text matching only proposes an alias: lexical entry identity must prove it.
	const spelling = value.split("");
	let valueIndex = 0;
	let patternIndex = 0;
	let star = -1;
	let consumed = 0;
	while (valueIndex < value.length) {
		const token = pattern[patternIndex];
		if (token === "*") {
			star = patternIndex++;
			consumed = valueIndex;
		} else if (token !== undefined && (token === "?" || token.toLowerCase() === value[valueIndex].toLowerCase())) {
			spelling[valueIndex] = token === "?" ? value[valueIndex] : token;
			valueIndex++;
			patternIndex++;
		} else if (star >= 0) {
			// Backtracking into * discards the literal casing from its previous attempt.
			for (let index = consumed; index < valueIndex; index++) spelling[index] = value[index];
			valueIndex = ++consumed;
			patternIndex = star + 1;
		} else {
			return false;
		}
	}
	while (pattern[patternIndex] === "*") patternIndex++;
	if (patternIndex !== pattern.length) return false;
	return sameLexicalPath(join(parent, value), join(parent, spelling.join("")));
}

function matchesSuffix(parent: string, parts: readonly string[], pattern: string): boolean {
	if (Wildcard.match(parts.join("/"), pattern)) return true;
	let positions = new Set([0]);
	for (let index = 0; index < parts.length; index++) {
		const value = parts[index];
		const next = new Set<number>();
		for (const start of positions) {
			if (index === parts.length - 1) {
				if (matchesComponent(parent, value, pattern.slice(start))) return true;
				continue;
			}
			// Wildcard.match lets both * and ? consume '/'. Keep every possible
			// pattern position at a component boundary, rather than choosing one
			// greedy match whose case spelling could fail on a different volume.
			for (let end = start; end < pattern.length; end++) {
				const token = pattern[end];
				if (token !== "*" && token !== "?" && token !== "/") continue;
				const component = pattern.slice(start, token === "*" ? end + 1 : end);
				if (matchesComponent(parent, value, component)) next.add(token === "*" ? end : end + 1);
				if (token === "/") break;
			}
		}
		if (next.size === 0) return false;
		positions = next;
		parent = join(parent, value);
	}
	return false;
}
