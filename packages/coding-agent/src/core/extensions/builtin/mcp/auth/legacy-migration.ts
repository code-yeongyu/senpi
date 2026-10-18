import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { acquireLegacyLock } from "./legacy-lock.ts";

export interface LegacyMigration<TRecord> {
	readonly rootDir: string;
	readonly lockPath: string;
	readonly legacyTokens: string;
	readonly tokensPath: string;
	readonly stale: number;
	readonly disableLock: boolean;
	readonly read: (path: string) => TRecord | undefined;
	readonly write: (record: TRecord) => void;
	readonly lockError: (cause: unknown) => Error;
}

export function adoptLegacyRecord<TRecord>(options: LegacyMigration<TRecord>): TRecord | undefined {
	const release = acquireSync(options);
	try {
		return claim(options);
	} finally {
		release();
	}
}

export async function readRecordAsync<TRecord>(options: LegacyMigration<TRecord>): Promise<TRecord | undefined> {
	const record = options.read(options.tokensPath);
	if (record !== undefined) return record;
	mkdirSync(options.rootDir, { mode: 0o700, recursive: true });
	let release: () => Promise<void>;
	try {
		release = options.disableLock ? async () => undefined : await acquireLegacyLock(options.lockPath, options.stale);
	} catch (cause) {
		throw options.lockError(cause);
	}
	try {
		return claim(options);
	} finally {
		await release();
	}
}

function claim<TRecord>(options: LegacyMigration<TRecord>): TRecord | undefined {
	const legacy = options.read(options.legacyTokens);
	if (legacy === undefined) return undefined;
	const existing = options.read(options.tokensPath);
	if (existing !== undefined) {
		rmSync(options.legacyTokens, { force: true });
		return existing;
	}
	options.write(legacy);
	rmSync(options.legacyTokens, { force: true });
	return legacy;
}

function acquireSync<TRecord>(options: LegacyMigration<TRecord>): () => void {
	if (options.disableLock) return () => undefined;
	mkdirSync(options.rootDir, { mode: 0o700, recursive: true });
	const deadline = Date.now() + options.stale;
	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(options.lockPath, "wx", 0o600);
			const file = fd;
			return () => {
				try {
					closeSync(file);
				} catch {
					// A caller may already have closed its descriptor.
				}
				rmSync(options.lockPath, { force: true });
			};
		} catch (cause) {
			if (fd !== undefined) closeSync(fd);
			if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
			let age: number;
			try {
				age = Date.now() - statSync(options.lockPath).mtimeMs;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			if (age >= options.stale) {
				rmSync(options.lockPath, { force: true });
				continue;
			}
			if (Date.now() >= deadline) throw options.lockError(new Error(`legacy migration lock held for ${age}ms`));
			const until = Date.now() + 20;
			while (Date.now() < until) {
				// Preserve the synchronous API; background preparation uses readRecordAsync.
			}
		}
	}
}
