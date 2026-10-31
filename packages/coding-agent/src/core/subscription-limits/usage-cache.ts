/**
 * The machine-wide record of usage polls (senpi#3684). A quota belongs to an account, not to a process,
 * so every senpi process on the machine reads the same file: a fresh reading is adopted instead of
 * re-fetched, a backoff one process earned holds for all of them, and a short fetch claim stops two
 * processes that wake together from asking the same question. Account names only, never key material.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LimitWindow } from "./limit-windows.ts";

export interface CachedReading {
	readonly windows: readonly LimitWindow[];
	readonly plan?: string;
	readonly error?: string;
	/** When the provider answered (or refused). */
	readonly updatedAt: number;
	/** Not asked again before this: the freshness window on success, the backoff on failure. */
	readonly nextAt: number;
}

interface FetchClaim {
	readonly claimedAt: number;
	readonly token: string;
}

export interface UsageCacheFile {
	readonly accounts: Readonly<Record<string, CachedReading>>;
	readonly fetching: Readonly<Record<string, FetchClaim>>;
}

export const CLAIM_MS = 30_000;

export function usageKey(provider: string, account: string): string {
	return `${provider}/${account}`;
}

export function isDue(cache: UsageCacheFile, key: string, now: number): boolean {
	const reading = cache.accounts[key];
	if (reading !== undefined && now < reading.nextAt) return false;
	const claim = cache.fetching[key];
	return claim === undefined || now - claim.claimedAt >= CLAIM_MS;
}

export function withClaims(cache: UsageCacheFile, keys: readonly string[], now: number, token: string): UsageCacheFile {
	const fetching = { ...cache.fetching };
	for (const key of keys) fetching[key] = { claimedAt: now, token };
	return { accounts: cache.accounts, fetching };
}

export function claimedBy(cache: UsageCacheFile, keys: readonly string[], token: string): string[] {
	return keys.filter((key) => cache.fetching[key]?.token === token);
}

/** Folds this process's results in and releases its claims; a failure keeps the last windows beside it. */
export function withResults(
	cache: UsageCacheFile,
	results: ReadonlyMap<string, CachedReading>,
	token: string,
): UsageCacheFile {
	const accounts = { ...cache.accounts };
	const fetching = { ...cache.fetching };
	for (const [key, reading] of results) {
		if (fetching[key]?.token !== token) continue;
		delete fetching[key];
		const previous = accounts[key];
		accounts[key] =
			reading.error !== undefined && previous !== undefined
				? { ...reading, windows: previous.windows, plan: reading.plan ?? previous.plan }
				: reading;
	}
	return { accounts, fetching };
}

export function readUsageCache(path: string): UsageCacheFile {
	try {
		return sanitize(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// No file yet, or one a sibling is mid-way through replacing: everything is simply due.
		return { accounts: {}, fetching: {} };
	}
}

/** Atomic replace, last writer wins: right for a cache, and lock-free. */
export function writeUsageCache(path: string, cache: UsageCacheFile): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		process.stderr.write(`senpi subscription limits: usage cache not written: ${String(error)}\n`);
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function sanitizeWindow(value: unknown): LimitWindow[] {
	const window = object(value);
	const id = text(window?.id);
	const label = text(window?.label);
	const usedPercent = finite(window?.usedPercent);
	if (id === undefined || label === undefined || usedPercent === undefined) return [];
	const windowMinutes = finite(window?.windowMinutes);
	const resetsAt = text(window?.resetsAt);
	return [
		{
			id,
			label,
			usedPercent,
			...(windowMinutes === undefined ? {} : { windowMinutes }),
			...(resetsAt === undefined ? {} : { resetsAt }),
		},
	];
}

/** Shared with other processes and other versions, so what comes off disk is checked, field by field. */
function sanitize(value: unknown): UsageCacheFile {
	const file = object(value);
	const accounts: Record<string, CachedReading> = {};
	for (const [key, raw] of Object.entries(object(file?.accounts) ?? {})) {
		const reading = object(raw);
		const updatedAt = finite(reading?.updatedAt);
		const nextAt = finite(reading?.nextAt);
		if (updatedAt === undefined || nextAt === undefined) continue;
		const plan = text(reading?.plan);
		const error = text(reading?.error);
		accounts[key] = {
			windows: (Array.isArray(reading?.windows) ? reading.windows : []).flatMap(sanitizeWindow),
			updatedAt,
			nextAt,
			...(plan === undefined ? {} : { plan }),
			...(error === undefined ? {} : { error }),
		};
	}
	const fetching: Record<string, FetchClaim> = {};
	for (const [key, raw] of Object.entries(object(file?.fetching) ?? {})) {
		const claimedAt = finite(object(raw)?.claimedAt);
		const token = text(object(raw)?.token);
		if (claimedAt !== undefined && token !== undefined) fetching[key] = { claimedAt, token };
	}
	return { accounts, fetching };
}
