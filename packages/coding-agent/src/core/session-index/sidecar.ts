import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { IndexedEntry, IndexedUsage } from "./index-record.ts";

const SIDECAR_VERSION = 1;
const SIDECAR_DIR = ".session-index";

/** The file a saved index belongs to: same device and inode, and the bytes up to `committedBytes` it covers. */
export interface SidecarIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly committedBytes: number;
}

export interface SavedIndex extends SidecarIdentity {
	readonly records: readonly IndexedEntry[];
}

type Extras = Omit<IndexedEntry, "offset" | "length" | "type" | "id" | "parentId">;
type RecordTuple =
	| [number, number, string, string, string | null]
	| [number, number, string, string, string | null, Extras];

export function sidecarPath(sessionFile: string): string {
	return join(dirname(sessionFile), SIDECAR_DIR, `${basename(sessionFile, ".jsonl")}.v${SIDECAR_VERSION}.json`);
}

function encode(record: IndexedEntry): RecordTuple {
	const { offset, length, type, id, parentId, ...extras } = record;
	return Object.keys(extras).length === 0
		? [offset, length, type, id, parentId]
		: [offset, length, type, id, parentId, extras];
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isOptionalText = (value: unknown): boolean => value === undefined || typeof value === "string";

function isUsage(value: unknown): value is IndexedUsage {
	if (typeof value !== "object" || value === null) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "cost"].every(
		(key) => typeof Reflect.get(value, key) === "number",
	);
}

function decodeExtras(value: unknown): Extras | undefined {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null) return undefined;
	const extras: Record<string, unknown> = { ...value };
	for (const key of ["role", "customType", "firstKeptEntryId", "targetId", "label", "timestamp", "name"]) {
		if (!isOptionalText(extras[key])) return undefined;
	}
	if (extras.usage !== undefined && !isUsage(extras.usage)) return undefined;
	if (extras.activationMarker !== undefined && extras.activationMarker !== true) return undefined;
	return extras;
}

function decode(value: unknown): IndexedEntry | undefined {
	if (!Array.isArray(value) || value.length < 5 || value.length > 6) return undefined;
	const [offset, length, type, id, parentId, rawExtras] = value;
	if (!isCount(offset) || !isCount(length) || typeof type !== "string" || typeof id !== "string") return undefined;
	if (parentId !== null && typeof parentId !== "string") return undefined;
	const extras = decodeExtras(rawExtras);
	if (extras === undefined) return undefined;
	return { offset, length, type, id, parentId, ...extras };
}

export function readSidecar(sessionFile: string): SavedIndex | undefined {
	const path = sidecarPath(sessionFile);
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const { v, dev, ino, committedBytes, records } = parsed as Record<string, unknown>;
	if (v !== SIDECAR_VERSION || !isCount(dev) || !isCount(ino) || !isCount(committedBytes) || !Array.isArray(records)) {
		return undefined;
	}
	const decoded: IndexedEntry[] = [];
	for (const value of records) {
		const record = decode(value);
		if (record === undefined || record.offset + record.length >= committedBytes) return undefined;
		decoded.push(record);
	}
	return { dev, ino, committedBytes, records: decoded };
}

/**
 * Publishes the index atomically (a temporary file renamed over the old one), so a reader sees the old index or the
 * new one, never a torn one. Only records of complete lines are saved. Returns the error when it could not be saved:
 * the index is derived acceleration, so a session whose folder is not writable still opens.
 */
export function writeSidecar(sessionFile: string, saved: SavedIndex): Error | undefined {
	const path = sidecarPath(sessionFile);
	const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const body = { v: SIDECAR_VERSION, dev: saved.dev, ino: saved.ino, committedBytes: saved.committedBytes };
		writeFileSync(temporary, JSON.stringify({ ...body, records: saved.records.map(encode) }));
		renameSync(temporary, path);
		return undefined;
	} catch (error) {
		if (existsSync(temporary)) rmSync(temporary, { force: true });
		return error instanceof Error ? error : new Error(String(error));
	}
}
