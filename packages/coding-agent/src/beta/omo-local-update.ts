// BETA(omo-local-update): removable beta module - delete this file, all test/omo-local-update*
// files to drop the feature.
//
// Beta: on bare `senpi update`, compare a locally-installed OMO plugin (omo-senpi +
// senpi-task) against origin/dev of its source checkout and replace the LOCAL PLUGIN
// INSTALL only when different. The user's checkout receives ZERO git mutations: this module
// never runs checkout/branch/commit/merge/reset/clean/stash/push against the user's repo.
// Its only git writes are `git fetch origin dev` (remote-tracking ref update) plus
// worktree add/remove/prune registering the FEATURE-OWNED persistent build worktree under
// <agentDir>/omo-local-update/. `checkout --detach --force` is used exactly once and only
// inside that feature-owned worktree, which this module creates and owns exclusively.
// Builds run there; the install target (pluginPath) is swapped atomically by rename.
//
// Export policy: `runOmoLocalUpdateBeta` is the ONLY production API and the only symbol the
// CLI may import. Every other export in this module is /** exported for tests only */ so the
// single test file (test/omo-local-update.test.ts) can exercise helpers directly - no
// CLI-side helper imports, no logic duplication.

import { randomUUID } from "node:crypto";
import {
	cpSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import type { PackageSource } from "../core/settings-manager.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { killProcessTree } from "../utils/shell.ts";

/** Result of one spawned command, with output captured and timeout enforced. */
export interface OmoLocalRunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface OmoLocalRunOptions {
	cwd?: string;
	timeoutMs?: number;
	/** Merged over process.env (callers inject the isolated git env from the fixture contract). */
	env?: Record<string, string | undefined>;
}

/** exported for tests only */
export type OmoLocalRun = (command: string, args: string[], options: OmoLocalRunOptions) => Promise<OmoLocalRunResult>;

/**
 * exported for tests only
 *
 * Shared process seam for the whole module. spawnProcess/waitForChildProcess neither capture
 * output nor enforce timeouts; this adds both. The child is spawned detached on POSIX so it
 * owns a process group, and the timeout kill goes through killProcessTree (SIGKILL to the
 * whole group) - without that, bun/git descendants would keep mutating the build worktree
 * after the direct child died.
 */
export async function defaultRun(
	command: string,
	args: string[],
	options: OmoLocalRunOptions,
): Promise<OmoLocalRunResult> {
	const child = spawnProcess(command, args, {
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...options.env },
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const abort = new AbortController();
	let timedOut = false;
	const pid = child.pid;
	const timer =
		options.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					if (pid !== undefined) {
						killProcessTree(pid);
					}
					abort.abort();
				}, options.timeoutMs);
	try {
		const code = await waitForChildProcess(child, { signal: abort.signal });
		return { code, stdout, stderr, timedOut };
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** exported for tests only */
export function isKillSwitched(env: Record<string, string | undefined>): boolean {
	return env.SENPI_OMO_LOCAL_UPDATE === "0";
}

/** A detected locally-installed OMO plugin and its enclosing omo monorepo checkout. */
export interface OmoLocalInstall {
	pluginPath: string;
	repoRoot: string;
}

/** exported for tests only */
export interface DetectOmoLocalInstallOptions {
	packages: PackageSource[] | undefined;
	agentDir: string;
	run: OmoLocalRun;
	readJson?: (path: string) => unknown;
	exists?: (path: string) => boolean;
}

function defaultReadJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

function packageNameOf(json: unknown): string | undefined {
	if (typeof json !== "object" || json === null) {
		return undefined;
	}
	const name = (json as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

/** Same semantics as package-manager.ts's private getHomeDir (HOME env wins over os.homedir). */
function homeDir(): string {
	return process.env.HOME || homedir();
}

/**
 * exported for tests only
 *
 * Three-part detection gate (ALL must hold, else silent no-op):
 * 1. A global settings `packages` entry (string or object form) is a local path whose resolved
 *    dir's package.json name is `@code-yeongyu/omo-senpi`.
 * 2. The derived repo root (pluginPath/../../..) contains both workspace packages
 *    `@oh-my-opencode/omo-senpi` and `@oh-my-opencode/senpi-task`.
 * 3. `git -C <repoRoot> rev-parse --show-toplevel` succeeds AND its canonicalized output equals
 *    the canonicalized repo root - a mismatched toplevel would mean the derived root is not
 *    the checkout it claims to be.
 */
export async function detectOmoLocalInstall(
	options: DetectOmoLocalInstallOptions,
): Promise<OmoLocalInstall | undefined> {
	const readJson = options.readJson ?? defaultReadJson;
	const exists = options.exists ?? existsSync;
	if (!options.packages) {
		return undefined;
	}
	for (const entry of options.packages) {
		const source = typeof entry === "string" ? entry : entry.source;
		if (!isLocalPath(source)) {
			continue;
		}
		const pluginPath = resolvePath(source, options.agentDir, { homeDir: homeDir(), trim: true });
		if (packageNameOf(readJson(join(pluginPath, "package.json"))) !== "@code-yeongyu/omo-senpi") {
			continue;
		}
		const repoRoot = resolve(pluginPath, "..", "..", "..");
		const omoSenpiPkgPath = join(repoRoot, "packages", "omo-senpi", "package.json");
		const senpiTaskPkgPath = join(repoRoot, "packages", "senpi-task", "package.json");
		if (!exists(omoSenpiPkgPath) || packageNameOf(readJson(omoSenpiPkgPath)) !== "@oh-my-opencode/omo-senpi") {
			continue;
		}
		if (!exists(senpiTaskPkgPath) || packageNameOf(readJson(senpiTaskPkgPath)) !== "@oh-my-opencode/senpi-task") {
			continue;
		}
		let topLevel: string;
		try {
			const result = await options.run("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {});
			if (result.code !== 0) {
				continue;
			}
			topLevel = result.stdout.trim();
		} catch {
			continue;
		}
		if (topLevel === "" || canonicalizePath(topLevel) !== canonicalizePath(repoRoot)) {
			continue;
		}
		return { pluginPath, repoRoot };
	}
	return undefined;
}

/** State stamp written after a successful install: `<agentDir>/omo-local-update-state.json`. */
export interface OmoLocalUpdateStamp {
	repoRoot: string;
	/** Frozen origin/dev sha the installed plugin was built from. */
	sha: string;
	/** `git rev-parse origin/dev:packages/omo-senpi` at install time. */
	omoSenpiTree: string;
	/** `git rev-parse origin/dev:packages/senpi-task` at install time. */
	senpiTaskTree: string;
	installedAt: string;
	/** Post-install inventory: relative paths of every installed artifact present at stamp time. */
	artifacts: string[];
}

/** exported for tests only */
export function omoLocalUpdateStampPath(agentDir: string): string {
	return join(agentDir, "omo-local-update-state.json");
}

/** exported for tests only */
export function readStamp(agentDir: string): OmoLocalUpdateStamp | undefined {
	const json = defaultReadJson(omoLocalUpdateStampPath(agentDir));
	if (typeof json !== "object" || json === null) {
		return undefined;
	}
	const candidate = json as {
		repoRoot?: unknown;
		sha?: unknown;
		omoSenpiTree?: unknown;
		senpiTaskTree?: unknown;
		installedAt?: unknown;
		artifacts?: unknown;
	};
	if (
		typeof candidate.repoRoot !== "string" ||
		typeof candidate.sha !== "string" ||
		typeof candidate.omoSenpiTree !== "string" ||
		typeof candidate.senpiTaskTree !== "string" ||
		typeof candidate.installedAt !== "string" ||
		!Array.isArray(candidate.artifacts)
	) {
		return undefined;
	}
	const artifacts: string[] = [];
	for (const artifact of candidate.artifacts as unknown[]) {
		if (typeof artifact !== "string") {
			return undefined;
		}
		artifacts.push(artifact);
	}
	return {
		repoRoot: candidate.repoRoot,
		sha: candidate.sha,
		omoSenpiTree: candidate.omoSenpiTree,
		senpiTaskTree: candidate.senpiTaskTree,
		installedAt: candidate.installedAt,
		artifacts,
	};
}

/** exported for tests only */
export function writeStamp(agentDir: string, stamp: OmoLocalUpdateStamp): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(omoLocalUpdateStampPath(agentDir), `${JSON.stringify(stamp, null, 2)}\n`, "utf-8");
}

/** exported for tests only */
export interface ShouldSkipUpdateOptions {
	stamp: OmoLocalUpdateStamp | undefined;
	repoRoot: string;
	remoteSha: string;
	/** True only when every path recorded in stamp.artifacts still exists on disk. */
	stampArtifactsExist: boolean;
	force: boolean;
}

/**
 * exported for tests only
 *
 * Skip decision (taken BEFORE any worktree op, install, or write): skip only when the stamp
 * belongs to this repo root, was installed at the frozen remote sha, recorded a non-empty
 * artifact inventory, and every inventoried path still exists. A repoRoot mismatch always
 * updates; an empty/absent inventory never skips; force always updates.
 */
export function shouldSkipUpdate(options: ShouldSkipUpdateOptions): boolean {
	if (options.force) {
		return false;
	}
	const stamp = options.stamp;
	if (!stamp) {
		return false;
	}
	if (stamp.repoRoot !== options.repoRoot) {
		return false;
	}
	if (stamp.sha !== options.remoteSha) {
		return false;
	}
	if (stamp.artifacts.length === 0) {
		return false;
	}
	return options.stampArtifactsExist;
}

/**
 * exported for tests only
 *
 * Failure of one orchestrator-owned step (fetch/worktree/install/build/artifacts/swap/stamp).
 * The stage feeds `OMO local plugin update failed (<stage>): ...`; `output` (combined
 * stdout+stderr of the failed step) is echoed dim, last 40 lines.
 */
export class OmoLocalStepError extends Error {
	readonly stage: string;
	readonly output: string | undefined;
	constructor(stage: string, message: string, output?: string) {
		super(message);
		this.name = "OmoLocalStepError";
		this.stage = stage;
		this.output = output;
	}
}

function firstErrorLine(result: OmoLocalRunResult): string {
	for (const text of [result.stderr, result.stdout]) {
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed !== "") {
				return trimmed;
			}
		}
	}
	return "unknown error";
}

/** The frozen state of origin/dev: commit sha, subject, and both package tree hashes. */
export interface OmoRemoteState {
	sha: string;
	subject: string;
	omoSenpiTree: string;
	senpiTaskTree: string;
}

/** exported for tests only */
export interface ComputeRemoteStateOptions {
	repoRoot: string;
	run: OmoLocalRun;
}

/**
 * exported for tests only
 *
 * Inspect the two packages' state ON ORIGIN/DEV: ONE `git fetch origin dev` (120s, read-only
 * - the ONLY network/ref operation in the module), then rev-parse/log reads against the
 * frozen `origin/dev` ref. A fetch failure throws an OmoLocalStepError with stage "fetch"
 * before anything else is touched.
 */
export async function computeRemoteState(options: ComputeRemoteStateOptions): Promise<OmoRemoteState> {
	const { repoRoot, run } = options;
	const git = (args: string[], timeoutMs?: number) => run("git", args, { cwd: repoRoot, timeoutMs });
	const requireOk = async (args: string[], timeoutMs?: number): Promise<string> => {
		const result = await git(args, timeoutMs);
		if (result.timedOut) {
			throw new OmoLocalStepError("fetch", `git ${args.join(" ")} timed out`);
		}
		if (result.code !== 0) {
			throw new OmoLocalStepError(
				"fetch",
				`git ${args.join(" ")}: ${firstErrorLine(result)}`,
				`${result.stdout}${result.stderr}`,
			);
		}
		return result.stdout.trim();
	};
	await requireOk(["fetch", "origin", "dev"], 120_000);
	const sha = await requireOk(["rev-parse", "origin/dev"]);
	if (sha === "") {
		throw new OmoLocalStepError("fetch", "git rev-parse origin/dev: empty output");
	}
	const subject = await requireOk(["log", "-1", "--format=%s", "origin/dev"]);
	const omoSenpiTree = await requireOk(["rev-parse", "origin/dev:packages/omo-senpi"]);
	const senpiTaskTree = await requireOk(["rev-parse", "origin/dev:packages/senpi-task"]);
	return { sha, subject, omoSenpiTree, senpiTaskTree };
}

/** exported for tests only */
export function omoLocalUpdateLockPath(agentDir: string): string {
	return join(agentDir, "omo-local-update.lock");
}

/** exported for tests only */
export function omoLocalUpdateBuildWorktreePath(agentDir: string): string {
	return join(agentDir, "omo-local-update", "build-worktree");
}

interface OmoLocalLock {
	path: string;
	pid: number;
	nonce: string;
}

function readLockFile(path: string): { pid: number; nonce: string } | undefined {
	try {
		const json = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown; nonce?: unknown };
		if (typeof json.pid !== "number" || typeof json.nonce !== "string") {
			return undefined;
		}
		return { pid: json.pid, nonce: json.nonce };
	} catch {
		return undefined;
	}
}

function pidIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Atomic lock acquisition (concurrency guard): `wx` create writing {pid, nonce, startedAt}.
 * On EEXIST: a LIVE pid wins unconditionally - dim line, NEVER take over regardless of age.
 * A dead pid (or an unreadable lock) is unlinked and the `wx` create retried ONCE; a
 * concurrent winner's fresh lock then loses us the retry, which is correct. Synchronous
 * throughout, so in-process contenders cannot interleave mid-check.
 */
function acquireOmoLocalLock(agentDir: string, log: (message: string) => void): OmoLocalLock | undefined {
	mkdirSync(agentDir, { recursive: true });
	const path = omoLocalUpdateLockPath(agentDir);
	const lock: OmoLocalLock = { path, pid: process.pid, nonce: randomUUID() };
	const payload = JSON.stringify({ pid: lock.pid, nonce: lock.nonce, startedAt: new Date().toISOString() });
	const tryCreate = (): boolean => {
		try {
			writeFileSync(path, payload, { flag: "wx" });
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return false;
			}
			throw error;
		}
	};
	const reportBusy = (): undefined => {
		const existing = readLockFile(path);
		log(chalk.dim(`OMO local plugin update already running (pid ${existing?.pid ?? "unknown"}); skipping.`));
		return undefined;
	};
	if (tryCreate()) {
		return lock;
	}
	const existing = readLockFile(path);
	if (existing !== undefined && pidIsAlive(existing.pid)) {
		return reportBusy();
	}
	try {
		rmSync(path);
	} catch {
		// Another process reclaimed first; the single retry below loses correctly.
	}
	if (tryCreate()) {
		return lock;
	}
	return reportBusy();
}

/** Owner-checked unlink: re-read and match our own pid+nonce before deleting. */
function releaseOmoLocalLock(lock: OmoLocalLock): void {
	try {
		const existing = readLockFile(lock.path);
		if (existing !== undefined && existing.pid === lock.pid && existing.nonce === lock.nonce) {
			rmSync(lock.path);
		}
	} catch {
		// Lock release must never throw.
	}
}

/** Post-build completeness set: five files plus a non-empty skills glob. */
const REQUIRED_BUILD_ARTIFACTS = [
	"extensions/omo.js",
	"runtime/lsp-daemon/dist/cli.js",
	"runtime/lsp-daemon/dist/index.js",
	"runtime/lsp-daemon/dist/.omo-runtime-manifest.json",
	"scripts/install.mjs",
] as const;

function walkFiles(rootDir: string): string[] {
	const files: string[] = [];
	const pending = [rootDir];
	while (pending.length > 0) {
		const dir = pending.pop();
		if (dir === undefined) {
			continue;
		}
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				pending.push(full);
			} else if (entry.isFile()) {
				files.push(full);
			}
		}
	}
	return files;
}

/**
 * Post-install inventory for the stamp: every file under plugin/extensions/ and
 * plugin/runtime/lsp-daemon/dist/, every SKILL.md under plugin/skills/, plus
 * plugin/scripts/install.mjs - paths relative to the plugin dir, posix-separated, sorted.
 */
function collectArtifactInventory(pluginPath: string): string[] {
	const inventory: string[] = [];
	const collectUnder = (relativeDir: string, filter?: (posixPath: string) => boolean): void => {
		for (const filePath of walkFiles(join(pluginPath, relativeDir))) {
			const posixPath = relative(pluginPath, filePath).split(sep).join("/");
			if (filter === undefined || filter(posixPath)) {
				inventory.push(posixPath);
			}
		}
	};
	collectUnder("extensions");
	collectUnder(join("runtime", "lsp-daemon", "dist"));
	collectUnder("skills", (posixPath) => posixPath.endsWith("/SKILL.md"));
	if (existsSync(join(pluginPath, "scripts", "install.mjs"))) {
		inventory.push("scripts/install.mjs");
	}
	inventory.sort();
	return inventory;
}

/** Post-build completeness check: the five required files + >=1 skills/<name>/SKILL.md. */
function findMissingBuildArtifacts(pluginPath: string): string[] {
	const missing: string[] = [];
	for (const required of REQUIRED_BUILD_ARTIFACTS) {
		if (!existsSync(join(pluginPath, required))) {
			missing.push(required);
		}
	}
	let skillCount = 0;
	try {
		for (const entry of readdirSync(join(pluginPath, "skills"), { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(pluginPath, "skills", entry.name, "SKILL.md"))) {
				skillCount++;
			}
		}
	} catch {
		// A missing skills dir counts as zero skills.
	}
	if (skillCount === 0) {
		missing.push("skills/*/SKILL.md");
	}
	return missing;
}

/** Marker error: the bun binary is missing from PATH (spawn ENOENT). */
class OmoLocalBunMissingError extends Error {
	constructor() {
		super("bun not found on PATH");
		this.name = "OmoLocalBunMissingError";
	}
}

/**
 * One bun step through the shared run seam, run INSIDE the build worktree (never the user's
 * checkout). A missing binary (spawn ENOENT) gets the dedicated marker so the orchestrator
 * can render the single yellow bun warning; any other failed start, non-zero exit, or
 * timeout becomes an OmoLocalStepError carrying the combined output for the dim dump.
 */
async function runBunStep(
	stage: "install" | "build",
	args: string[],
	worktree: string,
	run: OmoLocalRun,
	timeoutMs: number,
): Promise<void> {
	let result: OmoLocalRunResult;
	try {
		result = await run("bun", args, { cwd: worktree, timeoutMs });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new OmoLocalBunMissingError();
		}
		throw new OmoLocalStepError(
			stage,
			`bun ${args.join(" ")} failed to start: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const output = `${result.stdout}${result.stderr}`;
	if (result.timedOut) {
		throw new OmoLocalStepError(
			stage,
			`bun ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`,
			output,
		);
	}
	if (result.code !== 0) {
		throw new OmoLocalStepError(stage, `bun ${args.join(" ")} exited with code ${result.code ?? "unknown"}`, output);
	}
}

/** exported for tests only */
export interface EnsureBuildWorktreeOptions {
	/** Feature-owned persistent worktree path (inside agentDir). */
	worktree: string;
	repoRoot: string;
	/** Frozen origin/dev sha to check out detached. */
	sha: string;
	run: OmoLocalRun;
}

/**
 * exported for tests only
 *
 * Validate/reuse the FEATURE-OWNED persistent build worktree:
 * - present AND owned by this repo (`git -C <wt> rev-parse --git-common-dir` realpath-equals
 *   realpath(repoRoot/.git)) -> reuse: `git -C <wt> checkout --detach --force <sha>`. The
 *   --force is SAFE here: this worktree is exclusively feature-owned, so it only discards
 *   our own previous build outputs, and untracked node_modules survives for incremental
 *   installs.
 * - present but foreign/invalid -> `git -C repoRoot worktree remove --force <wt>` (fs rm
 *   fallback), then re-add.
 * - absent -> `git -C repoRoot worktree add --detach <wt> <sha>`.
 * These are the ONLY git mutations in the module besides `git fetch`, and they touch only
 * the feature-owned worktree registration - never the user's checkout state.
 */
export async function ensureBuildWorktree(options: EnsureBuildWorktreeOptions): Promise<void> {
	const { worktree, repoRoot, sha, run } = options;
	if (existsSync(worktree)) {
		const commonDir = await run("git", ["-C", worktree, "rev-parse", "--git-common-dir"], {});
		const owned =
			commonDir.code === 0 &&
			commonDir.stdout.trim() !== "" &&
			canonicalizePath(resolve(worktree, commonDir.stdout.trim())) === canonicalizePath(join(repoRoot, ".git"));
		if (owned) {
			const checkout = await run("git", ["-C", worktree, "checkout", "--detach", "--force", sha], {});
			if (checkout.code !== 0) {
				throw new OmoLocalStepError(
					"worktree",
					`git checkout --detach --force: ${firstErrorLine(checkout)}`,
					`${checkout.stdout}${checkout.stderr}`,
				);
			}
			return;
		}
		// Foreign or invalid directory at the feature-owned path: remove it (registered
		// worktree or not) and fall through to a fresh add.
		const remove = await run("git", ["-C", repoRoot, "worktree", "remove", "--force", worktree], {});
		if (remove.code !== 0 || existsSync(worktree)) {
			rmSync(worktree, { recursive: true, force: true });
		}
	}
	mkdirSync(dirname(worktree), { recursive: true });
	const add = await run("git", ["-C", repoRoot, "worktree", "add", "--detach", worktree, sha], {});
	if (add.code === 0) {
		return;
	}
	// A stale registration whose directory vanished blocks the add; prune metadata and retry once.
	await run("git", ["-C", repoRoot, "worktree", "prune"], {});
	const retry = await run("git", ["-C", repoRoot, "worktree", "add", "--detach", worktree, sha], {});
	if (retry.code !== 0) {
		throw new OmoLocalStepError(
			"worktree",
			`git worktree add: ${firstErrorLine(retry)}`,
			`${add.stdout}${add.stderr}${retry.stdout}${retry.stderr}`,
		);
	}
}

/** exported for tests only: injectable fs seam for the atomic swap. */
export interface OmoLocalFsSeam {
	cpSync: (source: string, destination: string) => void;
	renameSync: (oldPath: string, newPath: string) => void;
	rmSync: (path: string) => void;
}

const defaultFsSeam: OmoLocalFsSeam = {
	cpSync: (source, destination) => {
		cpSync(source, destination, { recursive: true });
	},
	renameSync: (oldPath, newPath) => {
		renameSync(oldPath, newPath);
	},
	rmSync: (path) => {
		rmSync(path, { recursive: true, force: true });
	},
};

/** exported for tests only */
export interface SwapPluginDirOptions {
	pluginPath: string;
	/** The freshly built plugin dir inside the build worktree. */
	sourceDir: string;
	fs?: OmoLocalFsSeam;
}

let swapCounter = 0;

/**
 * exported for tests only
 *
 * ATOMIC SWAP of the install target. staging/prev are siblings of pluginPath (same parent
 * => same filesystem => atomic renames): copy the built tree to staging, move pluginPath
 * aside to prev, move staging into place. If the staging rename fails, prev is restored
 * and staging removed before the error propagates - the local install is never left
 * half-swapped. On success prev is removed.
 */
export function swapPluginDir(options: SwapPluginDirOptions): void {
	const seam = options.fs ?? defaultFsSeam;
	swapCounter += 1;
	const tag = `${Date.now()}-${process.pid}-${swapCounter}`;
	const staging = `${options.pluginPath}.staging-${tag}`;
	const prev = `${options.pluginPath}.prev-${tag}`;
	seam.cpSync(options.sourceDir, staging);
	seam.renameSync(options.pluginPath, prev);
	try {
		seam.renameSync(staging, options.pluginPath);
	} catch (error) {
		seam.renameSync(prev, options.pluginPath);
		seam.rmSync(staging);
		throw error;
	}
	seam.rmSync(prev);
}

function firstLine(text: string): string {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed !== "") {
			return trimmed;
		}
	}
	return "unknown error";
}

function lastNonEmptyLines(text: string, count: number): string[] {
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() !== "") {
			lines.push(line);
		}
	}
	return lines.slice(-count);
}

export interface RunOmoLocalUpdateBetaOptions {
	env: Record<string, string | undefined>;
	agentDir: string;
	settings?: { packages?: PackageSource[] };
	force?: boolean;
	log?: (message: string) => void;
	run?: OmoLocalRun;
}

/**
 * Beta hook entry point, called from bare `senpi update` before the self-update.
 *
 * SINGLE owner of the ORDERED state machine: gate chain (kill-switch -> detection) ->
 * atomic lock acquisition (held through fetch, worktree, build, swap, stamp AND notify;
 * owner-checked unlink in `finally`) -> computeRemoteState (ONE read-only fetch + frozen
 * rev-parse reads of origin/dev) -> skip decision BEFORE any worktree op, install, or
 * write -> ensureBuildWorktree (feature-owned persistent worktree, reuse-or-recreate) ->
 * `bun install` (600s, cwd = build worktree) -> `bun run build:senpi-plugin` (900s, cwd =
 * build worktree) -> completeness check in the WORKTREE plugin dir -> atomic swap of the
 * install target -> writeStamp (inventory from the NEW plugin dir) -> notify (green line
 * + dim per-package tree comparison when an old stamp existed).
 *
 * HARD GUARANTEES: the user's checkout receives ZERO git mutations (no
 * checkout/branch/commit/merge/reset/clean/stash/push anywhere; only `git fetch` and
 * feature-owned worktree add/remove). Only pluginPath content is replaced. This hook NEVER
 * throws and NEVER sets process.exitCode: every failure downgrades to a yellow warning +
 * dim manual hint so the senpi self-update continues untouched.
 */
export async function runOmoLocalUpdateBeta(options: RunOmoLocalUpdateBetaOptions): Promise<void> {
	const log =
		options.log ??
		((message: string) => {
			console.log(message);
		});
	const run = options.run ?? defaultRun;
	let repoRoot: string | undefined;
	try {
		if (isKillSwitched(options.env)) {
			return;
		}
		const install = await detectOmoLocalInstall({
			packages: options.settings?.packages,
			agentDir: options.agentDir,
			run,
		});
		if (!install) {
			return;
		}
		repoRoot = install.repoRoot;
		const { pluginPath } = install;

		const lock = acquireOmoLocalLock(options.agentDir, log);
		if (lock === undefined) {
			return;
		}
		try {
			log(chalk.dim("Updating OMO local plugins: fetching origin/dev..."));
			const remoteState = await computeRemoteState({ repoRoot, run });

			// Skip decision FIRST: a skip touches NOTHING (no worktree ops, no install, no writes).
			const stamp = readStamp(options.agentDir);
			const stampArtifactsExist =
				stamp?.artifacts.every((artifact) => existsSync(join(pluginPath, artifact))) ?? false;
			if (
				shouldSkipUpdate({
					stamp,
					repoRoot,
					remoteSha: remoteState.sha,
					stampArtifactsExist,
					force: options.force ?? false,
				})
			) {
				log(
					chalk.dim(`OMO local plugins already at origin/dev @${remoteState.sha.slice(0, 7)}; skipping rebuild.`),
				);
				return;
			}

			// Build in the feature-owned persistent worktree - never in the user's checkout.
			const worktree = omoLocalUpdateBuildWorktreePath(options.agentDir);
			await ensureBuildWorktree({ worktree, repoRoot, sha: remoteState.sha, run });
			try {
				log(chalk.dim("Updating OMO local plugins: installing deps..."));
				await runBunStep("install", ["install"], worktree, run, 600_000);
				log(chalk.dim("Updating OMO local plugins: building plugin..."));
				await runBunStep("build", ["run", "build:senpi-plugin"], worktree, run, 900_000);
			} catch (stepError) {
				if (stepError instanceof OmoLocalBunMissingError) {
					log(
						chalk.yellow(
							"OMO local plugin update skipped: bun is required to install and build the plugin but was not found on PATH. Install bun and re-run `senpi update`.",
						),
					);
					return;
				}
				throw stepError;
			}
			const worktreePluginDir = join(worktree, relative(repoRoot, pluginPath));
			const missing = findMissingBuildArtifacts(worktreePluginDir);
			if (missing.length > 0) {
				throw new OmoLocalStepError("artifacts", `build incomplete - missing: ${missing.join(", ")}`);
			}

			// Atomic swap of the install target, then stamp from the NEW plugin dir inventory.
			try {
				swapPluginDir({ pluginPath, sourceDir: worktreePluginDir });
			} catch (swapError) {
				throw new OmoLocalStepError(
					"swap",
					`atomic swap failed: ${swapError instanceof Error ? swapError.message : String(swapError)}`,
				);
			}
			writeStamp(options.agentDir, {
				repoRoot,
				sha: remoteState.sha,
				omoSenpiTree: remoteState.omoSenpiTree,
				senpiTaskTree: remoteState.senpiTaskTree,
				installedAt: new Date().toISOString(),
				artifacts: collectArtifactInventory(pluginPath),
			});

			const short = remoteState.sha.slice(0, 7);
			log(
				chalk.green(
					`Updated OMO local plugins (omo-senpi + senpi-task) to origin/dev @${short} - ${remoteState.subject}`,
				),
			);
			if (stamp !== undefined) {
				const omoLine = stamp.omoSenpiTree === remoteState.omoSenpiTree ? "unchanged" : "updated";
				const taskLine = stamp.senpiTaskTree === remoteState.senpiTaskTree ? "unchanged" : "updated";
				log(chalk.dim(`omo-senpi: ${omoLine}, senpi-task: ${taskLine}`));
			}
		} finally {
			releaseOmoLocalLock(lock);
		}
	} catch (error) {
		// The hook NEVER throws and NEVER sets process.exitCode: render the yellow failure
		// line (+ dim failed-step output tail + dim manual hint) and let the senpi
		// self-update continue.
		const stage = error instanceof OmoLocalStepError ? error.stage : "unknown";
		const message = error instanceof Error ? error.message : String(error);
		log(chalk.yellow(`OMO local plugin update failed (${stage}): ${firstLine(message)}`));
		if (error instanceof OmoLocalStepError && error.output !== undefined) {
			for (const line of lastNonEmptyLines(error.output, 40)) {
				log(chalk.dim(line));
			}
		}
		if (repoRoot !== undefined) {
			log(
				chalk.dim(
					`To update manually: git -C ${repoRoot} pull origin dev && bun install && bun run build:senpi-plugin`,
				),
			);
		}
	}
}
