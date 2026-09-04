import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import type { HookTrustStorageScope } from "./trust.ts";
import { emptyHookTrustState, parseHookTrustStateJson, readHookTrustStateJson } from "./trust-state-json.ts";
import type { HookTrustEntry, HookTrustState } from "./types.ts";

export interface HookStateStorage {
	read(scope: HookTrustStorageScope): HookTrustState;
	update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState;
}

export type FileHookStateStorageOptions = {
	readonly agentDir?: string;
	readonly cwd: string;
};

/**
 * Internal same-account application state at `<agentDir>/hooks-state.json` and
 * `<cwd>/.senpi/hooks-state.json`. POSIX files retain their numeric mode and new
 * files use 0600; reassigned ownership, named ACLs, and custom DACLs are outside
 * this storage contract.
 */
export class FileHookStateStorage implements HookStateStorage {
	private readonly globalStatePath: string;
	private readonly projectStatePath: string;

	constructor(options: FileHookStateStorageOptions) {
		const agentDir = options.agentDir ?? getAgentDir();
		this.globalStatePath = join(agentDir, "hooks-state.json");
		this.projectStatePath = join(options.cwd, CONFIG_DIR_NAME, "hooks-state.json");
	}

	read(scope: HookTrustStorageScope): HookTrustState {
		const path = statePathForScope(scope, this.globalStatePath, this.projectStatePath);
		const snapshot = parseHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined);
		if (snapshot !== undefined) {
			return snapshot;
		}

		let release: () => void;
		try {
			release = acquireHookStateLockSync(path);
		} catch (error) {
			const code = errorCode(error);
			// Sandboxed/read-only children cannot mkdir the lock dir; fail open on read.
			if (code === "ELOCKED" || code === "EPERM" || code === "EACCES" || code === "EROFS") {
				return emptyHookTrustState();
			}
			throw error;
		}
		return runWithHookStateLockRelease(release, () =>
			readHookTrustStateJson(existsSync(path) ? readFileSync(path, "utf-8") : undefined),
		);
	}

	update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState {
		return withHookStateFileLock(statePathForScope(scope, this.globalStatePath, this.projectStatePath), (path) => {
			const stateExists = existsSync(path);
			const current = readHookTrustStateJson(stateExists ? readFileSync(path, "utf-8") : undefined);
			const mode = stateExists ? statSync(path).mode & 0o777 : 0o600;
			const next = updater(current);
			const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
			try {
				writeFileSync(tempPath, serializeHookTrustState(next), { encoding: "utf-8", mode });
				chmodSync(tempPath, mode);
				renameSync(tempPath, path);
			} catch (publicationError) {
				try {
					rmSync(tempPath, { force: true });
				} catch (cleanupError) {
					throw new AggregateError(
						[publicationError, cleanupError],
						"Failed to publish and clean up hook trust state snapshot",
					);
				}
				throw publicationError;
			}
			return next;
		});
	}
}

export class InMemoryHookStateStorage implements HookStateStorage {
	private globalState: HookTrustState = emptyHookTrustState();
	private projectState: HookTrustState = emptyHookTrustState();

	read(scope: HookTrustStorageScope): HookTrustState {
		return scope === "global" ? this.globalState : this.projectState;
	}

	update(scope: HookTrustStorageScope, updater: (current: HookTrustState) => HookTrustState): HookTrustState {
		const next = updater(this.read(scope));
		if (scope === "global") {
			this.globalState = next;
		} else {
			this.projectState = next;
		}
		return next;
	}
}

function statePathForScope(scope: HookTrustStorageScope, globalStatePath: string, projectStatePath: string): string {
	return scope === "global" ? globalStatePath : projectStatePath;
}

function serializeHookTrustState(state: HookTrustState): string {
	const sortedHooks: Record<string, HookTrustEntry> = {};
	for (const key of Object.keys(state.hooks).sort()) {
		const entry = state.hooks[key];
		if (entry !== undefined) {
			sortedHooks[key] = entry;
		}
	}
	return `${JSON.stringify({ version: 1, hooks: sortedHooks }, null, 2)}\n`;
}

function acquireHookStateLockSync(path: string): () => void {
	const stateDir = dirname(path);
	mkdirSync(stateDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return lockfile.lockSync(stateDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code = errorCode(error);
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				Date.now();
			}
		}
	}

	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire hook state lock");
}

function errorCode(error: unknown): string | undefined {
	if (!isRecord(error)) {
		return undefined;
	}
	const code = error.code;
	return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withHookStateFileLock<T>(path: string, fn: (path: string) => T): T {
	const release = acquireHookStateLockSync(path);
	return runWithHookStateLockRelease(release, () => fn(path));
}

function runWithHookStateLockRelease<T>(release: () => void, operation: () => T): T {
	let result: T;
	try {
		result = operation();
	} catch (operationError) {
		try {
			release();
		} catch (releaseError) {
			throw new AggregateError(
				operationError instanceof AggregateError
					? [...operationError.errors, releaseError]
					: [operationError, releaseError],
				"Hook state operation and lock release both failed",
			);
		}
		throw operationError;
	}
	release();
	return result;
}
