import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizePathStrict, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { linkedWorktreeMainCheckoutDir } from "./linked-worktree-checkout.ts";

export { hasTrustRequiringProjectResources, projectAgentsSkillDirs } from "./trust-requiring-resources.ts";

export type ProjectTrustDecision = boolean | null;

export interface ProjectTrustStoreEntry {
	path: string;
	decision: boolean;
}

/** The nearest entry at or above a folder; `decision: null` is an explicit "no decision, none inherited" entry. */
export interface ProjectTrustNearestEntry {
	path: string;
	decision: ProjectTrustDecision;
}

export interface ProjectTrustUpdate {
	path: string;
	/** `null` removes the folder's entry; `"no_inherit"` saves an explicit `null` for it (see `findNearestTrustEntry`). */
	decision: ProjectTrustDecision | "no_inherit";
}

export interface ProjectTrustOption {
	label: string;
	trusted: boolean;
	updates: ProjectTrustUpdate[];
	savedPath?: string;
}

type TrustFile = Record<string, boolean | null | undefined>;

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

/**
 * The nearest entry at or above `cwd`. An explicit `null` saved for a folder (`set_project_trust`'s `no_inherit`) is an
 * entry as well: it holds no decision, and the walk stops there, so neither a folder above it nor, for a linked
 * worktree, the main checkout decides for it. Readers older than that skip a `null` and keep walking: they inherit as
 * before, and never fail on it.
 */
function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustNearestEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false || value === null) {
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

/**
 * `set_project_trust`'s `no_inherit`: no decision for the folder, and none inherited from a folder above it or, for a
 * linked worktree, from its main checkout, so the folder is decided as if nothing were saved (Full access trusts it,
 * a session that may ask asks). `/trust` never offers it.
 */
export function getProjectTrustNoInheritOption(cwd: string): ProjectTrustOption {
	const trustPath = normalizeCwd(cwd);
	return {
		label: "No decision, and none inherited",
		trusted: false,
		updates: [{ path: trustPath, decision: "no_inherit" }],
		savedPath: trustPath,
	};
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

export class ProjectTrustStore {
	private trustPath: string;
	/** Counts the writes made through `setMany`, by any process; bumped under the store lock. */
	private generationPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
		this.generationPath = `${this.trustPath}.generation`;
	}

	/**
	 * Changes on every write made through `setMany`, in any process or engine copy, because each one bumps the
	 * generation file under the store lock: a value read before such a write never equals one read after it. A
	 * write that bypasses `setMany` (another program editing `trust.json`) changes it only when it changes the
	 * file's modification time or size.
	 */
	revision(): string {
		const stat = statSync(this.trustPath, { bigint: true, throwIfNoEntry: false });
		return `${this.readGeneration()}:${stat === undefined ? "absent" : `${stat.mtimeNs}:${stat.size}`}`;
	}

	private readGeneration(): number {
		if (!existsSync(this.generationPath)) return 0;
		const generation = Number.parseInt(readFileSync(this.generationPath, "utf-8"), 10);
		return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
	}

	get(cwd: string): ProjectTrustDecision {
		return this.getNearestEntry(cwd)?.decision ?? null;
	}

	/** The nearest saved decision at or above `cwd`; `null` also when the nearest entry holds no decision. */
	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		const entry = this.getNearestEntry(cwd);
		return entry === null || entry.decision === null ? null : { path: entry.path, decision: entry.decision };
	}

	getNearestEntry(cwd: string): ProjectTrustNearestEntry | null {
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
					data[key] = decision === "no_inherit" ? null : decision;
				}
			}
			writeTrustFile(this.trustPath, data);
			writeFileSync(this.generationPath, `${this.readGeneration() + 1}\n`, "utf-8");
		});
	}
}

/**
 * What is saved for a folder: a decision, `"no_inherit"` for the explicit no-decision entry
 * (`set_project_trust`'s `no_inherit`), or `null` when nothing is saved. The two undecided values stay
 * apart because only `null` may be filled in by an answer the process kept without saving it.
 */
export type SavedProjectTrust = boolean | "no_inherit" | null;

/**
 * What is saved for `cwd`: the store's own entry (the folder or the nearest folder above it), and only
 * when it has none and `cwd` is inside a linked git worktree, the main checkout's entry for the
 * matching folder. An entry saved for the worktree or above it always wins, including the explicit
 * no-decision entry, which leaves the folder undecided.
 */
export async function getSavedProjectTrustState(store: ProjectTrustStore, cwd: string): Promise<SavedProjectTrust> {
	const own = store.getNearestEntry(cwd);
	if (own !== null) return own.decision ?? "no_inherit";
	const mainCheckoutDir = await linkedWorktreeMainCheckoutDir(cwd);
	if (mainCheckoutDir === undefined) return null;
	const main = store.getNearestEntry(mainCheckoutDir);
	return main === null ? null : (main.decision ?? "no_inherit");
}

/** The saved decision for `cwd` (`getSavedProjectTrustState`), with both undecided values as `null`. */
export async function getSavedProjectTrust(store: ProjectTrustStore, cwd: string): Promise<ProjectTrustDecision> {
	const saved = await getSavedProjectTrustState(store, cwd);
	return saved === "no_inherit" ? null : saved;
}
