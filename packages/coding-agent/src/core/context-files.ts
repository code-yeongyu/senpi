import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import chalk from "chalk";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { findGitPaths } from "./footer-data-provider.ts";

export interface ContextFile {
	path: string;
	content: string;
	/**
	 * "user" for the user's own standing instructions (the agent-dir file and the home-directory file);
	 * absent means a project file. The prompt ranks user instructions above its default working style.
	 */
	scope?: "user";
}

/** Preserve the public array API while returning diagnostics to the owning mode. */
export type ContextFiles = ContextFile[] & { readonly diagnostics: ResourceDiagnostic[] };

/** Size limits for AGENTS.md / CLAUDE.md context files, which ride along on every model request. */
export interface ContextFileLimits {
	maxBytesPerFile?: number;
	maxTotalBytes?: number;
	/**
	 * The global (user-scope) context file to load instead of the agent-dir probe (senpi#5567).
	 * Honored from the user's own settings only (`SettingsManager.getGlobalContextFilePath`); a
	 * project's settings never set it. A leading `~` is expanded; a relative path resolves against
	 * the agent dir, like other paths in global settings; a directory runs the same candidate probe
	 * as the agent dir. Unset or blank keeps the agent-dir file. A path that is set but missing,
	 * unreadable, a special file, or a directory with no candidate falls back to the agent-dir probe
	 * and reports one warning diagnostic instead of erroring.
	 */
	globalPath?: string;
}

export const DEFAULT_CONTEXT_FILE_MAX_BYTES = 64 * 1024;
export const DEFAULT_CONTEXT_FILES_MAX_TOTAL_BYTES = 128 * 1024;
const MIN_USEFUL_BYTES = 1024;

function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

interface GlobalContextFileResult {
	file: ContextFile | null;
	/** Set when a configured `globalPath` could not be used, so a typo is visible instead of silent. */
	diagnostic?: ResourceDiagnostic;
}

/**
 * The global user-scope context file (senpi#5567). `contextFiles.globalPath` names a file (or a
 * directory to probe for the usual candidates) to load in place of the agent-dir file. Precedence
 * is defined and never errors: a blank or unset path keeps the agent-dir probe silently; a
 * configured target that is missing, unreadable, a special file, or a directory with no candidates
 * falls back to the agent-dir probe and returns one warning naming the configured path.
 */
function loadGlobalContextFile(agentDir: string, globalPath: string | undefined): GlobalContextFileResult {
	const explicit = typeof globalPath === "string" ? globalPath.trim() : "";
	if (explicit === "") return { file: loadContextFileFromDir(agentDir) };
	const resolved = resolvePath(explicit, agentDir);
	const fallBack = (problem: string): GlobalContextFileResult => ({
		file: loadContextFileFromDir(agentDir),
		diagnostic: {
			type: "warning",
			path: resolved,
			message: `contextFiles.globalPath ${problem}; using the global context file from ${agentDir} instead.`,
		},
	});
	let stats: Stats;
	try {
		stats = statSync(resolved);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return fallBack(
			code === "ENOENT" || code === "ENOTDIR" ? "does not exist" : `could not be read (${String(error)})`,
		);
	}
	if (stats.isDirectory()) {
		const file = loadContextFileFromDir(resolved);
		return file ? { file } : fallBack("is a directory with no AGENTS.md or CLAUDE.md");
	}
	if (!stats.isFile()) return fallBack("is not a regular file or directory");
	try {
		return { file: { path: resolved, content: stripBom(readFileSync(resolved, "utf-8")) } };
	} catch (error) {
		return fallBack(`could not be read (${String(error)})`);
	}
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

function kib(bytes: number): string {
	const value = bytes / 1024;
	return Number.isInteger(value) ? `${value} KiB` : `${value.toFixed(1)} KiB`;
}

function utf8Prefix(content: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(content, "utf8");
	let end = Math.min(maxBytes, bytes.length);
	while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	const newline = bytes.lastIndexOf(10, end - 1);
	if (newline >= maxBytes * 0.75) end = newline + 1;
	return bytes.subarray(0, end).toString("utf8");
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Bound what the context files add to every request. Files are given budget nearest-first
 * (the cwd's file before its ancestors, the global file last), so the most specific
 * instructions survive; every cut or skipped file is named in a warning.
 */
function applyContextFileLimits(files: ContextFile[], limits: ContextFileLimits): ContextFiles {
	const perFile = positiveLimit(limits.maxBytesPerFile, DEFAULT_CONTEXT_FILE_MAX_BYTES);
	const total = positiveLimit(limits.maxTotalBytes, DEFAULT_CONTEXT_FILES_MAX_TOTAL_BYTES);
	const limitText = `limit ${kib(perFile)} per file, ${kib(total)} total; raise contextFiles.maxBytesPerFile / contextFiles.maxTotalBytes in settings to load more`;
	const kept: ContextFile[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	let remaining = total;
	for (const file of [...files].reverse()) {
		const size = Buffer.byteLength(file.content, "utf8");
		const allowed = Math.min(perFile, remaining);
		if (size <= allowed) {
			kept.unshift(file);
			remaining -= size;
			continue;
		}
		if (allowed < MIN_USEFUL_BYTES) {
			const reason =
				perFile < MIN_USEFUL_BYTES ? "the per-file limit is too small" : "nearer context files used the budget";
			diagnostics.push({
				type: "warning",
				category: "size-limit",
				path: file.path,
				message: `Context file (${kib(size)}) was not loaded: ${reason} (${limitText}).`,
			});
			continue;
		}
		const note = `\n\n[This file was truncated from ${kib(size)}.]`;
		const contentBudget = allowed - Buffer.byteLength(note);
		let prefix = utf8Prefix(file.content, contentBudget);
		let content: string;
		while (true) {
			let openFence: string | undefined;
			for (const match of prefix.matchAll(/^[ \t]*(`{3,}|~{3,})([^\n]*)$/gm)) {
				const marker = match[1];
				if (!marker) continue;
				if (openFence === undefined) openFence = marker;
				else if (marker[0] === openFence[0] && marker.length >= openFence.length && match[2]?.trim() === "") {
					openFence = undefined;
				}
			}
			const closingFence = openFence ? `${prefix.endsWith("\n") ? "" : "\n"}${openFence}\n` : "";
			content = `${prefix}${closingFence}${note}`;
			if (Buffer.byteLength(content) <= allowed) break;
			// A longer closing marker can expose another opener when the prefix shrinks.
			prefix = utf8Prefix(prefix, Math.max(0, contentBudget - Buffer.byteLength(closingFence)));
		}
		const loaded = Buffer.byteLength(prefix, "utf8");
		diagnostics.push({
			type: "warning",
			category: "size-limit",
			path: file.path,
			message: `Context file is ${kib(size)}; only the first ${kib(loaded)} was loaded (${limitText}).`,
		});
		kept.unshift({ ...file, content });
		remaining -= Buffer.byteLength(content);
	}
	return Object.assign(kept, { diagnostics });
}

/** Compares files and directories by their real path, ignoring case where the filesystem does (Windows). */
function pathKey(path: string): string {
	const real = canonicalizePath(resolvePath(path));
	return process.platform === "win32" ? real.toLowerCase() : real;
}

export function loadProjectContextFiles(
	options: { cwd: string; agentDir: string; homeDir?: string } & ContextFileLimits,
): ContextFiles {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const homeKey = pathKey(options.homeDir ?? homedir());

	const contextFiles: ContextFile[] = [];
	// Real-path keys: a symlinked ancestor file that points at an already loaded file is the same file.
	const seenPaths = new Set<string>();

	const globalContext = loadGlobalContextFile(resolvedAgentDir, options.globalPath);
	if (globalContext.file) {
		contextFiles.push({ ...globalContext.file, scope: "user" });
		seenPaths.add(pathKey(globalContext.file.path));
	}

	const ancestorContextFiles: ContextFile[] = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		const isShadowed =
			shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? "") === shadowedContextFile;
		const contextFileKey = contextFile ? pathKey(contextFile.path) : undefined;
		if (contextFile && contextFileKey !== undefined && !isShadowed && !seenPaths.has(contextFileKey)) {
			ancestorContextFiles.unshift(
				pathKey(currentDir) === homeKey ? { ...contextFile, scope: "user" } : contextFile,
			);
			seenPaths.add(contextFileKey);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	const limited = applyContextFileLimits(contextFiles, options);
	if (globalContext.diagnostic) limited.diagnostics.unshift(globalContext.diagnostic);
	return limited;
}
