import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readlinkSync, type Stats, symlinkSync, unlinkSync } from "node:fs";
import { lstat, mkdir, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { logoutClaudeCli } from "./claude-cli-auth-status.ts";

/**
 * Entries of a CLI-store account dir that point at the shared Claude root, so every account reads one
 * transcript tree (`projects`) and the user's own settings, memory, agents, commands, skills and output
 * styles. The credential store and everything else stay per account.
 */
export const CLAUDE_CLI_SHARED_LINKS = [
	"projects",
	"settings.json",
	"CLAUDE.md",
	"agents",
	"commands",
	"skills",
	"output-styles",
] as const;

const SHARED_FILES: ReadonlySet<string> = new Set(["settings.json", "CLAUDE.md"]);
const DIR_ID_PATTERN = /^[0-9a-f]{32}$/;

export function newAccountDirId(): string {
	return randomBytes(16).toString("hex");
}

export function isValidAccountDirId(dirId: string): boolean {
	return DIR_ID_PATTERN.test(dirId);
}

/** `<agentDir>/anthropic-subscription-claude/<dirId>`; a stored id of any other shape is refused. */
export function accountDirFor(agentDir: string, dirId: string): string {
	if (!isValidAccountDirId(dirId)) throw new Error("Invalid Claude account dir id");
	return join(agentDir, "anthropic-subscription-claude", dirId);
}

/** The root the accounts share: an inherited `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeCliSharedRoot(env: NodeJS.ProcessEnv): string {
	const inherited = env.CLAUDE_CONFIG_DIR;
	return inherited ? resolve(inherited) : join(homedir(), ".claude");
}

function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function linkEntry(entry: string, target: string, path: string): void {
	if (!SHARED_FILES.has(entry)) {
		mkdirSync(target, { recursive: true });
		symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
		return;
	}
	if (!exists(target)) return;
	try {
		symlinkSync(target, path, "file");
	} catch (error) {
		// Windows refuses file symlinks without Developer Mode; the account then keeps its own copy.
		if (process.platform !== "win32") throw error;
	}
}

export type EnsureAccountDirOptions = {
	readonly agentDir: string;
	readonly dirId: string;
	readonly sharedRoot: string;
};

/**
 * Creates the account dir (0700) and creates or repairs its links to the shared root. A link pointing
 * elsewhere is replaced; a real file or dir in a link's place is account data and is left alone.
 */
export function ensureAccountDir(options: EnsureAccountDirOptions): string {
	const accountDir = accountDirFor(options.agentDir, options.dirId);
	mkdirSync(accountDir, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(accountDir, 0o700);
	for (const entry of CLAUDE_CLI_SHARED_LINKS) {
		const path = join(accountDir, entry);
		const target = join(options.sharedRoot, entry);
		if (isLink(path)) {
			if (resolve(accountDir, readlinkSync(path)) === resolve(target)) continue;
			unlinkSync(path);
		} else if (exists(path)) {
			continue;
		}
		linkEntry(entry, target, path);
	}
	return accountDir;
}

export type RemoveAccountDirOptions = {
	readonly agentDir: string;
	readonly dirId: string;
	/** The `claude` executable; undefined when it could not be resolved, and the sign-out is then skipped. */
	readonly executable: string | undefined;
	readonly parentEnv?: NodeJS.ProcessEnv;
	/** Aborting stops the sign-out and throws before anything is deleted; the dir and slot are kept. */
	readonly signal?: AbortSignal;
};

/**
 * `removed`: signed out and the dir is gone. `removed_without_sign_out`: `claude auth logout` could not run or
 * failed, and the dir is gone anyway. `not_an_account_dir`: the path is a link or a file, left untouched.
 */
export type RemoveAccountDirOutcome = "removed" | "removed_without_sign_out" | "not_an_account_dir";

/**
 * Signs the account out (`claude auth logout` with `CLAUDE_CONFIG_DIR=<accountDir>`, which deletes that dir's
 * credential store entry), then unlinks the shared links WITHOUT following them and removes the dir. Removal never
 * depends on the CLI: with no executable, or a sign-out that fails, the dir is still removed and the outcome says
 * the sign-out did not run, so the caller can tell the user. A missing dir is
 * still signed out, because the CLI keys its store entry on the path. A link or file in the dir's place is not
 * an account dir: it is never signed out against, followed or deleted.
 */
export async function removeAccountDir(options: RemoveAccountDirOptions): Promise<RemoveAccountDirOutcome> {
	const accountDir = accountDirFor(options.agentDir, options.dirId);
	options.signal?.throwIfAborted();
	// A missing dir is recreated empty: the CLI runs inside its config dir, and its store entry is keyed on the path.
	if ((await lstatOrUndefined(accountDir)) === undefined) await mkdir(accountDir, { recursive: true, mode: 0o700 });
	if (!(await lstatOrUndefined(accountDir))?.isDirectory()) return "not_an_account_dir";
	const signedOut =
		options.executable !== undefined &&
		(await logoutClaudeCli(
			{
				executable: options.executable,
				configDir: accountDir,
				...(options.parentEnv === undefined ? {} : { parentEnv: options.parentEnv }),
			},
			undefined,
			options.signal,
		).catch(() => false));
	options.signal?.throwIfAborted();
	for (const entry of CLAUDE_CLI_SHARED_LINKS) {
		const path = join(accountDir, entry);
		if ((await lstatOrUndefined(path))?.isSymbolicLink()) await unlink(path);
	}
	await rm(accountDir, { recursive: true, force: true });
	return signedOut ? "removed" : "removed_without_sign_out";
}
