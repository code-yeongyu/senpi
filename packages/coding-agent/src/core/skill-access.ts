import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { type FileHandle, lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { collectSkillEntries } from "./skill-discovery.ts";

export interface SkillProvenance {
	readonly kind: "user" | "project-auto" | "project-selected";
	/** Kept as selected, before dereferencing a root link. */
	readonly selectedRoot: string;
	readonly projectRoot?: string;
}
export interface SkillAllowedSet {
	readonly roots: readonly string[];
	readonly files: readonly string[];
	readonly digest: string;
}
export const EMPTY_SKILL_ALLOWED_SET: SkillAllowedSet = { roots: [], files: [], digest: "" };

export function skillProjectRoot(cwd: string): string {
	let current = resolve(cwd);
	for (;;) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}
export function insideSkillRoot(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
export function buildSkillAllowedSet(sources: readonly string[]): SkillAllowedSet {
	const roots = new Set<string>();
	const files = new Set<string>();
	// Package resolution retains the selected root on every discovered skill.
	// Walk each spelling once, without collapsing differently ignored aliases.
	const realpaths = new Map<string, string>();
	const realpath = (path: string): string => {
		let canonical = realpaths.get(path);
		if (canonical === undefined) {
			canonical = realpathSync.native(path);
			realpaths.set(path, canonical);
		}
		return canonical;
	};
	for (const source of new Set(sources)) {
		try {
			const canonical = realpath(source);
			if (statSync(canonical).isFile()) {
				files.add(canonical);
				continue;
			}
			collectSkillEntries(source, "pi", undefined, undefined, {
				realpath,
				onDirectory: (path) => roots.add(realpath(path)),
			});
		} catch {
			/* An unavailable user root confers no project authority. */
		}
	}
	const allowedRoots = [...roots].sort();
	const allowedFiles = [...files].sort();
	return {
		roots: allowedRoots,
		files: allowedFiles,
		digest: createHash("sha256")
			.update(JSON.stringify([allowedRoots, allowedFiles]))
			.digest("hex"),
	};
}
export class BlockedSkillLinkError extends Error {
	readonly diagnostic: ResourceDiagnostic;
	constructor(path: string, target: string) {
		const display = (value: string) => {
			const home = homedir();
			return insideSkillRoot(value, home) ? `~${value.slice(home.length)}` : value;
		};
		super(
			`Blocked skill link outside the project: ${display(path)} -> ${display(target)}. Add the target folder to your user skills settings to allow it.`,
		);
		this.name = "BlockedSkillLinkError";
		this.diagnostic = { type: "warning", category: "skill-link-blocked", path, message: this.message };
	}
}
/** The project-owned roots a project skill path must stay inside, before the user-granted ones. */
function projectRoots(provenance: SkillProvenance): string[] {
	return [
		...(provenance.projectRoot === undefined ? [] : [provenance.projectRoot]),
		...(provenance.kind === "project-selected" ? [provenance.selectedRoot] : []),
	];
}
function contained(canonical: string, roots: readonly string[], allowed: SkillAllowedSet, directory: boolean): boolean {
	return (
		[...roots, ...allowed.roots].some((root) => insideSkillRoot(canonical, root)) ||
		allowed.files.includes(canonical) ||
		(directory && allowed.files.some((file) => insideSkillRoot(file, canonical)))
	);
}
export function authorizeSkillPath(
	path: string,
	provenance: SkillProvenance | undefined,
	allowed: SkillAllowedSet = EMPTY_SKILL_ALLOWED_SET,
	directory = false,
): string {
	if (provenance === undefined || provenance.kind === "user") return path;
	let canonical: string;
	try {
		canonical = realpathSync.native(path);
		const roots = projectRoots(provenance).map((root) => realpathSync.native(root));
		if (contained(canonical, roots, allowed, directory)) return canonical;
	} catch {
		throw new BlockedSkillLinkError(path, "unresolvable target");
	}
	throw new BlockedSkillLinkError(path, canonical);
}
/** `authorizeSkillPath` without blocking the loop; `fs.promises.realpath` has `realpathSync.native` semantics. */
async function authorizeSkillPathAsync(
	path: string,
	provenance: SkillProvenance,
	allowed: SkillAllowedSet,
): Promise<string> {
	let canonical: string;
	try {
		canonical = await realpath(path);
		const roots = await Promise.all(projectRoots(provenance).map((root) => realpath(root)));
		if (contained(canonical, roots, allowed, false)) return canonical;
	} catch {
		throw new BlockedSkillLinkError(path, "unresolvable target");
	}
	throw new BlockedSkillLinkError(path, canonical);
}
/**
 * All project skill bytes use this descriptor read. Inode rechecking catches
 * some concurrent swaps, not ancestor replacement after canonicalization.
 * The guarantee is for the design's unchanged-filesystem threat model.
 */
export function readSkillFileCheckedSync(
	path: string,
	provenance?: SkillProvenance,
	allowed?: SkillAllowedSet,
): string {
	if (provenance === undefined || provenance.kind === "user") return readFileSync(path, "utf8");
	const canonical = authorizeSkillPath(path, provenance, allowed);
	// Pin the authorized file's identity without following links, then require the opened descriptor to be
	// that same file. Windows has no O_NOFOLLOW, and a post-open stat follows a swapped-in link to the same
	// target as the descriptor, so only a pre-open identity catches a swap there (senpi#3796).
	let expected: ReturnType<typeof lstatSync>;
	let descriptor: number;
	try {
		expected = lstatSync(canonical);
		if (!expected.isFile()) throw new BlockedSkillLinkError(path, canonical);
		descriptor = openSync(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch {
		throw new BlockedSkillLinkError(path, canonical);
	}
	try {
		const opened = fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.dev !== expected.dev ||
			opened.ino !== expected.ino ||
			lstatSync(canonical).isSymbolicLink()
		) {
			throw new BlockedSkillLinkError(path, canonical);
		}
		return readFileSync(descriptor, "utf8");
	} finally {
		closeSync(descriptor);
	}
}
/**
 * The session-path read: the same descriptor read as `readSkillFileCheckedSync`, without blocking the loop.
 * The awaits between the identity pin and the open widen the swap window, so nothing after the pin trusts
 * the path again: O_NOFOLLOW refuses a swapped-in link, the opened handle must match the pinned dev/ino,
 * and the bytes are read from that handle (senpi#3796).
 * As in the sync read, ancestor-directory replacement after canonicalization is out of scope:
 * the guarantee assumes the design's unchanged-filesystem threat model.
 */
export async function readSkillFileChecked(
	path: string,
	provenance?: SkillProvenance,
	allowed: SkillAllowedSet = EMPTY_SKILL_ALLOWED_SET,
): Promise<string> {
	if (provenance === undefined || provenance.kind === "user") return await readFile(path, "utf8");
	const canonical = await authorizeSkillPathAsync(path, provenance, allowed);
	let expected: Awaited<ReturnType<typeof lstat>>;
	let handle: FileHandle;
	try {
		expected = await lstat(canonical);
		if (!expected.isFile()) throw new BlockedSkillLinkError(path, canonical);
		handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch {
		throw new BlockedSkillLinkError(path, canonical);
	}
	try {
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.dev !== expected.dev ||
			opened.ino !== expected.ino ||
			(await lstat(canonical)).isSymbolicLink()
		) {
			throw new BlockedSkillLinkError(path, canonical);
		}
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}
