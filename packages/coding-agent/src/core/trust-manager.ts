import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, canonicalizePathStrict, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { bundledBuiltinExtensions } from "./bundled-resources.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;

const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

const LEGACY_PROJECT_CONFIG_DIR_NAME = ".pi";

/**
 * A project codemode file that sets any setting naming an executable (the codemode package's
 * `executable-settings.json` list, today `languages.pyInterpreter`) makes the session run that executable at start,
 * so it asks for a trust decision. A file the check cannot read is treated like a project `mcp.json`, whose mere
 * presence asks; so is any file when the list itself cannot be read.
 */
function projectCodemodeNamesExecutable(configDir: string): boolean {
	const path = join(configDir, "codemode.json");
	if (!existsSync(path)) return false;
	const executableSettings = codemodeExecutableSettings();
	if (executableSettings === undefined) return true;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf8")));
	} catch {
		return true;
	}
	return executableSettings.some((settingPath) => valueAtPath(parsed, settingPath) !== undefined);
}

function codemodeExecutableSettings(): readonly string[] | undefined {
	const codemode = bundledBuiltinExtensions.find((extension) => extension.id === "codemode");
	try {
		const packageJson = codemode?.resolvePackage();
		if (packageJson === undefined) return undefined;
		const list: unknown = JSON.parse(
			readFileSync(join(dirname(packageJson), "src", "config", "executable-settings.json"), "utf8"),
		);
		if (typeof list !== "object" || list === null) return undefined;
		const paths: unknown = Reflect.get(list, "projectExecutableSettings");
		return Array.isArray(paths) && paths.every((entry) => typeof entry === "string") ? paths : undefined;
	} catch {
		return undefined;
	}
}

function valueAtPath(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = Reflect.get(current, key);
	}
	return current;
}

function normalizeCwd(cwd: string): string {
	const resolved = resolvePath(cwd);
	try {
		return canonicalizePathStrict(resolved);
	} catch {
		// A workspace path the filesystem will not confirm must not be keyed by its raw
		// spelling: that is how a decision recorded for one directory leaks to another
		// that merely writes the same way. Returning the resolved-but-unconfirmed path
		// keeps the lookup total, and because no stored key can match a location the
		// kernel does not agree on, the effect is "ask again" rather than "inherit".
		return resolved;
	}
}

function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) {
			return { path: currentDir, decision: value };
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

function readTrustFile(path: string): TrustFile {
	if (!existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// Sleep synchronously to avoid changing trust store callers to async.
			}
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire trust store lock");
}

function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/** True when `dir` is the user's home or a folder above it: never a project (#2465). */
function isHomeOrAboveDir(dir: string, homeDir: string): boolean {
	return dir === homeDir || homeDir.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The nearest folder at or above `dir` that holds `.git`, as spelled; undefined outside a repository. */
function findGitRepoRoot(dir: string): string | undefined {
	let currentDir = dir;
	while (!existsSync(join(currentDir, ".git"))) {
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return undefined;
		currentDir = parentDir;
	}
	return currentDir;
}

/**
 * The project `.agents/skills` directories for `cwd`, nearest first: one per folder from cwd up to
 * the git root (or the filesystem root), stopping below the user's home. Home and every folder
 * above it are never a project; `~/.agents/skills` is the user's own global skills. The ONE walk
 * both the trust check and the loader use, over the same spelling and the same git root (#3420
 * review): paths stay as spelled (resources are compared as strings), and each folder's real path
 * decides whether it is home or above, so a symlink can't carry the walk past home either way.
 */
export function projectAgentsSkillDirs(cwd: string): string[] {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const startDir = resolvePath(cwd);
	const gitRepoRoot = findGitRepoRoot(startDir);
	const dirs: string[] = [];
	let currentDir = startDir;
	while (!isHomeOrAboveDir(canonicalizePath(currentDir), homeDir)) {
		dirs.push(join(currentDir, ".agents", "skills"));
		if (currentDir === gitRepoRoot) break;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}
	return dirs;
}

/**
 * Returns true when cwd has project-local resources that must be gated by
 * project trust: trust-requiring entries under the project config dir or the
 * legacy cwd/.pi dir (whose resources are also discovered), or a project
 * `.agents/skills` (`projectAgentsSkillDirs`, the same walk the loader uses).
 * The user's home and every folder above it are never a project: their config
 * dirs and .agents/skills are the user's own global resources (#2465).
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const currentDir = canonicalizePath(resolvePath(cwd));

	if (!isHomeOrAboveDir(currentDir, homeDir)) {
		const configDirs = [join(currentDir, CONFIG_DIR_NAME), join(currentDir, LEGACY_PROJECT_CONFIG_DIR_NAME)];
		if (
			configDirs.some((configDir) =>
				TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry))),
			)
		) {
			return true;
		}
		if (projectCodemodeNamesExecutable(join(currentDir, CONFIG_DIR_NAME))) return true;
	}

	return projectAgentsSkillDirs(cwd).some((dir) => existsSync(dir));
}

export class ProjectTrustStore {
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			return findNearestTrustEntry(data, cwd);
		});
	}

	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				if (decision === null) {
					delete data[key];
				} else {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}

const GITDIR_POINTER = /^gitdir:\s*(.+)$/;

async function readFirstLine(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf-8")).split(/\r?\n/, 1)[0]?.trim() || undefined;
	} catch {
		return undefined;
	}
}

async function realPathOf(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

async function entryKind(path: string): Promise<"directory" | "file" | undefined> {
	try {
		const stats = await stat(path);
		if (stats.isDirectory()) return "directory";
		return stats.isFile() ? "file" : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The folder of the repository's main checkout that matches `cwd` inside a linked git worktree, or
 * undefined when `cwd` is not inside one. A linked worktree is the same repository as its main
 * checkout, but tools that run one agent per worktree (Orca's `~/orca/workspaces/<repo>/<name>`)
 * put it outside the main checkout, where no saved decision covers it. Reads the files
 * `git worktree add` writes, asynchronously, and never spawns git. Accepted only when the admin dir
 * points back at this `.git` file and the common dir is the main checkout's own `.git` directory;
 * bare repositories, `--separate-git-dir` clones and submodules have no main checkout to inherit from.
 * As in git, a worktree folder deleted without `git worktree prune` keeps its admin record, so a folder
 * recreated at that path with a `.git` file the record points back at is that worktree again.
 */
export async function linkedWorktreeMainCheckoutDir(cwd: string): Promise<string | undefined> {
	const dir = (await realPathOf(resolvePath(cwd))) ?? resolvePath(cwd);
	let checkoutRoot = dir;
	let markerKind = await entryKind(join(checkoutRoot, ".git"));
	while (markerKind === undefined) {
		const parentDir = dirname(checkoutRoot);
		if (parentDir === checkoutRoot) return undefined;
		checkoutRoot = parentDir;
		markerKind = await entryKind(join(checkoutRoot, ".git"));
	}
	if (markerKind !== "file") return undefined;
	const marker = join(checkoutRoot, ".git");
	const adminTarget = GITDIR_POINTER.exec((await readFirstLine(marker)) ?? "")?.[1]?.trim();
	if (!adminTarget) return undefined;
	// Every pointer is resolved against the admin dir's real path, so relative pointers (`git worktree add
	// --relative-paths`) and the location check below all speak about the same directory.
	const adminDir = await realPathOf(resolve(checkoutRoot, adminTarget));
	if (adminDir === undefined) return undefined;
	const commonDirPointer = await readFirstLine(join(adminDir, "commondir"));
	const backPointer = await readFirstLine(join(adminDir, "gitdir"));
	if (commonDirPointer === undefined || backPointer === undefined) return undefined;
	const markerRealPath = await realPathOf(marker);
	if (markerRealPath === undefined || (await realPathOf(resolve(adminDir, backPointer))) !== markerRealPath) {
		return undefined;
	}
	const commonDir = await realPathOf(resolve(adminDir, commonDirPointer));
	if (commonDir === undefined || basename(commonDir) !== ".git") return undefined;
	// The pointers above only agree with each other; a folder that is not this repository's worktree can carry its own
	// consistent set. Git keeps a linked worktree's admin dir in `<common dir>/worktrees/`, inside the repository.
	if (dirname(adminDir) !== join(commonDir, "worktrees")) return undefined;
	const mainCheckout = dirname(commonDir);
	const mainMarker = join(mainCheckout, ".git");
	if ((await entryKind(mainMarker)) !== "directory" || (await realPathOf(mainMarker)) !== commonDir) return undefined;
	return join(mainCheckout, relative(checkoutRoot, dir));
}

/**
 * The saved trust decision for `cwd`: the store's own (the folder or the nearest folder above it),
 * and only when it has none and `cwd` is inside a linked git worktree, the main checkout's decision
 * for the matching folder. A decision saved for the worktree or above it always wins.
 */
export async function getSavedProjectTrust(store: ProjectTrustStore, cwd: string): Promise<ProjectTrustDecision> {
	const own = store.get(cwd);
	if (own !== null) return own;
	const mainCheckoutDir = await linkedWorktreeMainCheckoutDir(cwd);
	return mainCheckoutDir === undefined ? null : store.get(mainCheckoutDir);
}
