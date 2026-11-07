import {
	closeSync,
	type Dirent,
	existsSync,
	fstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import {
	authorizeSkillPath,
	BlockedSkillLinkError,
	type SkillAllowedSet,
	type SkillProvenance,
} from "./skill-access.ts";

/** Bytes read before falling back to the rest of SKILL.md when the closing --- is absent. */
export const SKILL_FRONTMATTER_PREFIX_BYTES = 8192;

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const SKIP_SKILL_WALK_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);
const FRONTMATTER_CLOSE_LF = Buffer.from("\n---");
const FRONTMATTER_CLOSE_CR = Buffer.from("\r---");

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiscoveryMode = "pi" | "agents";
export interface SkillWalkOptions {
	readonly provenance?: SkillProvenance;
	readonly allowedSet?: SkillAllowedSet;
	readonly ancestry?: ReadonlySet<string>;
	readonly onDirectory?: (path: string) => void;
	/** Receives the SKILL.md of each skill folder an ignore file hid from the walk. */
	readonly onIgnoredSkill?: (skillFile: string) => void;
	/** Optional cache owned by a single discovery pass, never retained on a Skill. */
	readonly realpath?: (path: string) => string;
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

export function shouldSkipSkillWalkDirectoryName(name: string): boolean {
	return name.startsWith(".") || SKIP_SKILL_WALK_DIRECTORY_NAMES.has(name);
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * Applies the ignore files present in `entries`, the listing of `dir` the walk already read, so no
 * directory pays a probe per ignore-file name (omo#11437). Names compare case-insensitively, as the
 * former existence probe did on case-insensitive volumes; a name that does not open is skipped.
 */
export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string, entries: readonly Dirent[]): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	const names = new Set(entries.map((entry) => entry.name.toLowerCase()));

	for (const filename of IGNORE_FILE_NAMES) {
		if (!names.has(filename)) continue;
		const ignorePath = join(dir, filename);
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function frontmatterPrefixEnd(buf: Buffer): number | undefined {
	let offset = 0;
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		offset = 3;
	}
	if (buf.length - offset < 3 || buf[offset] !== 0x2d || buf[offset + 1] !== 0x2d || buf[offset + 2] !== 0x2d) {
		return buf.length;
	}
	const lf = buf.indexOf(FRONTMATTER_CLOSE_LF, offset + 3);
	const cr = buf.indexOf(FRONTMATTER_CLOSE_CR, offset + 3);
	const closeAt = lf >= 0 && cr >= 0 ? Math.min(lf, cr) : lf >= 0 ? lf : cr;
	if (closeAt < 0) return undefined;
	return closeAt + FRONTMATTER_CLOSE_LF.length;
}

function decodeFrontmatterSource(buf: Buffer): string {
	const end = frontmatterPrefixEnd(buf);
	return (end === undefined ? buf : buf.subarray(0, end)).toString("utf8");
}

/**
 * Read enough of a skill markdown file to parse YAML frontmatter.
 * Stops at the first 8 KiB when that prefix already contains the closing --- (or has no frontmatter).
 * Falls back to the rest of the file when the delimiter is not in the prefix.
 */
export function readSkillMarkdownSource(filePath: string): string {
	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		// A Bun single-file executable serves embedded assets from a virtual filesystem that answers
		// existsSync, statSync and readFileSync but hands out no descriptors, so openSync fails on a path
		// the resource loader has already accepted. Read the asset whole instead; a file that is genuinely
		// missing or unreadable throws here too, which keeps the loader's diagnostics truthful.
		return decodeFrontmatterSource(readFileSync(filePath));
	}
	try {
		const prefix = Buffer.allocUnsafe(SKILL_FRONTMATTER_PREFIX_BYTES);
		const bytesRead = readSync(fd, prefix, 0, SKILL_FRONTMATTER_PREFIX_BYTES, 0);
		const prefixBuf = prefix.subarray(0, bytesRead);
		if (bytesRead < SKILL_FRONTMATTER_PREFIX_BYTES || frontmatterPrefixEnd(prefixBuf) !== undefined) {
			return decodeFrontmatterSource(prefixBuf);
		}
		const restSize = fstatSync(fd).size - bytesRead;
		if (restSize <= 0) {
			return decodeFrontmatterSource(prefixBuf);
		}
		const rest = Buffer.allocUnsafe(restSize);
		readSync(fd, rest, 0, restSize, bytesRead);
		return decodeFrontmatterSource(Buffer.concat([prefixBuf, rest]));
	} finally {
		closeSync(fd);
	}
}

export function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	options: SkillWalkOptions = {},
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;
	let canonical: string;
	try {
		authorizeSkillPath(dir, options.provenance, options.allowedSet, true);
		canonical = (options.realpath ?? realpathSync.native)(dir);
	} catch (error) {
		// Leave a blocked root as a candidate so the resource loader retains its
		// provenance and produces the visible diagnostic without descending here.
		if (error instanceof BlockedSkillLinkError) return [dir];
		canonical = resolve(dir); // Embedded/user assets retain descriptorless discovery.
	}
	if (options.ancestry?.has(canonical)) return entries;
	const ancestry = new Set(options.ancestry);
	ancestry.add(canonical);
	options.onDirectory?.(dir);

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		addIgnoreRules(ig, dir, root, dirEntries);

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (shouldSkipSkillWalkDirectoryName(entry.name)) continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();
			const isLink = entry.isSymbolicLink();

			if (isLink) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				(isLink || !ig.ignores(relPath)) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			// A linked directory belongs to another tree: the ignore files above it neither hide it nor
			// reach into it, while its own ignore files still apply inside it (senpi#5060).
			if (isLink) {
				entries.push(...collectSkillEntries(fullPath, mode, ignore(), root, { ...options, ancestry }));
				continue;
			}
			if (ig.ignores(`${relPath}/`)) {
				const skillFile = join(fullPath, "SKILL.md");
				if (options.onIgnoredSkill && existsSync(skillFile)) options.onIgnoredSkill(skillFile);
				continue;
			}

			entries.push(...collectSkillEntries(fullPath, mode, ig, root, { ...options, ancestry }));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

export function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode, options?: SkillWalkOptions): string[] {
	return collectSkillEntries(dir, mode, undefined, undefined, options);
}
