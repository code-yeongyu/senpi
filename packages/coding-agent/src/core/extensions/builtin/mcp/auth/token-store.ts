import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../../../config.ts";

// URL-bound OAuth credential record persisted at
// <agentDir>/mcp-auth/<sha256(serverUrl)>/tokens.json (dir 0700, file 0600).
export interface McpStoredAuth {
	accessToken?: string;
	refreshToken?: string;
	clientInfo?: OAuthClientInformationFull;
	codeVerifier?: string;
	resource?: string;
	// Absolute expiry (epoch ms) derived from tokens.expires_in at save time.
	expiresAt?: number;
}

export interface TokenStoreLockOptions {
	retries?: number;
	stale?: number;
}

export interface TokenStoreOptions {
	serverName: string;
	serverUrl: string;
	agentDir?: string;
	lock?: TokenStoreLockOptions;
	// Test-only escape hatch: skip the cross-process lock so the refresh-race
	// control case can demonstrate the token-family invalidation it prevents.
	disableLock?: boolean;
}

const AUTH_ROOT = "mcp-auth";
const TOKENS_FILE = "tokens.json";
const INDEX_FILE = "index.json";
const DEFAULT_LOCK: Required<TokenStoreLockOptions> = { retries: 50, stale: 30_000 };

export class LockAcquireError extends Error {
	readonly lockPath: string;
	constructor(lockPath: string, cause: unknown) {
		super(
			`Could not acquire MCP auth lock at ${lockPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "LockAcquireError";
		this.lockPath = lockPath;
	}
}

export function hashServerUrl(serverUrl: string): string {
	return createHash("sha256").update(serverUrl).digest("hex");
}

export class McpTokenStore<TRecord extends McpStoredAuth = McpStoredAuth> {
	readonly serverName: string;
	readonly serverUrl: string;
	readonly #agentDir: string;
	readonly #hash: string;
	readonly #lock: Required<TokenStoreLockOptions>;
	readonly #disableLock: boolean;

	constructor(options: TokenStoreOptions) {
		this.serverName = options.serverName;
		this.serverUrl = options.serverUrl;
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#hash = hashServerUrl(options.serverUrl);
		this.#lock = { ...DEFAULT_LOCK, ...options.lock };
		this.#disableLock = options.disableLock ?? false;
	}

	get rootDir(): string {
		return join(this.#agentDir, AUTH_ROOT);
	}
	get dir(): string {
		return join(this.rootDir, this.#hash);
	}
	get tokensPath(): string {
		return join(this.dir, TOKENS_FILE);
	}
	get lockPath(): string {
		return join(this.dir, `${TOKENS_FILE}.lock`);
	}

	read(): TRecord | undefined {
		return readJsonFile<TRecord>(this.tokensPath);
	}

	async update(mutate: (current: TRecord | undefined) => TRecord | undefined): Promise<TRecord | undefined> {
		const release = await this.#acquire();
		try {
			const next = mutate(this.read());
			if (next === undefined) {
				this.#removeTokens();
			} else {
				this.#writeAtomic(next);
				this.#writeIndex();
			}
			return next;
		} finally {
			await release();
		}
	}

	async write(record: TRecord): Promise<void> {
		await this.update(() => record);
	}

	// Run an async critical section under the cross-process lock. The callback
	// must use readUnlocked/writeUnlocked (never update/write) to avoid
	// re-entrant lock acquisition, which proper-lockfile rejects immediately.
	async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
		const release = await this.#acquire();
		try {
			return await fn();
		} finally {
			await release();
		}
	}

	readUnlocked(): TRecord | undefined {
		return this.read();
	}

	writeUnlocked(record: TRecord | undefined): void {
		if (record === undefined) {
			this.#removeTokens();
			return;
		}
		this.#writeAtomic(record);
		this.#writeIndex();
	}

	async clear(): Promise<void> {
		const release = await this.#acquire();
		try {
			rmSync(this.dir, { force: true, recursive: true });
		} finally {
			await release().catch(() => undefined);
		}
		removeIndexEntry(this.rootDir, this.serverName, this.#hash);
	}

	#ensureDir(): void {
		mkdirSync(this.dir, { mode: 0o700, recursive: true });
		chmodSync(this.dir, 0o700);
	}

	async #acquire(): Promise<() => Promise<void>> {
		this.#ensureDir();
		if (this.#disableLock) return () => Promise.resolve();
		try {
			return await lockfile.lock(this.dir, {
				lockfilePath: this.lockPath,
				realpath: false,
				retries: { retries: this.#lock.retries, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
				stale: this.#lock.stale,
			});
		} catch (cause) {
			throw new LockAcquireError(this.lockPath, cause);
		}
	}

	#writeAtomic(record: TRecord): void {
		this.#ensureDir();
		const tmp = join(this.dir, `${TOKENS_FILE}.${randomBytes(6).toString("hex")}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.tokensPath);
		chmodSync(this.tokensPath, 0o600);
	}

	#removeTokens(): void {
		rmSync(this.tokensPath, { force: true });
	}

	#writeIndex(): void {
		writeIndexEntry(this.rootDir, this.serverName, this.#hash);
	}
}

function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) return undefined;
	const raw = readFileSync(path, "utf-8").trim();
	if (raw.length === 0) return undefined;
	return JSON.parse(raw) as T;
}

function indexPath(rootDir: string): string {
	return join(rootDir, INDEX_FILE);
}

function readIndex(rootDir: string): Record<string, string> {
	return readJsonFile<Record<string, string>>(indexPath(rootDir)) ?? {};
}

function writeIndexEntry(rootDir: string, name: string, hash: string): void {
	mkdirSync(rootDir, { mode: 0o700, recursive: true });
	const index = readIndex(rootDir);
	if (index[name] === hash) return;
	index[name] = hash;
	writeIndexAtomic(rootDir, index);
}

function removeIndexEntry(rootDir: string, name: string, hash: string): void {
	if (!existsSync(indexPath(rootDir))) return;
	const index = readIndex(rootDir);
	if (index[name] !== hash && index[name] !== undefined) return;
	delete index[name];
	writeIndexAtomic(rootDir, index);
}

function writeIndexAtomic(rootDir: string, index: Record<string, string>): void {
	const tmp = join(rootDir, `${INDEX_FILE}.${randomBytes(6).toString("hex")}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, indexPath(rootDir));
	chmodSync(indexPath(rootDir), 0o600);
}
