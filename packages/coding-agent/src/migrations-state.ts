/**
 * Persistent skip-list for one-time directory-scan migrations.
 *
 * Missing, unreadable, or malformed state is fail-open: every scan runs again.
 * Bump MIGRATIONS_STATE_SCHEMA_VERSION when a listed migration's semantics change.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./config.ts";

export const MIGRATIONS_STATE_SCHEMA_VERSION = 1;
export const MIGRATIONS_STATE_FILENAME = "migrations-state.json";

export const SCAN_MIGRATIONS = [
	"migrateLegacySenpiDirs",
	"migrateSessionsFromAgentRoot",
	"restoreDrainedPiDirs",
] as const;

export type ScanMigrationName = (typeof SCAN_MIGRATIONS)[number];

const SCAN_MIGRATION_NAMES: ReadonlySet<string> = new Set(SCAN_MIGRATIONS);

function isScanMigrationName(value: string): value is ScanMigrationName {
	return SCAN_MIGRATION_NAMES.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * What the state records about the one-time copy of upstream pi's `~/.pi/agent`: when it happened,
 * and the pi file mtimes the startup notice already reported (omo#9173).
 */
export interface LegacyPiAgentDirRecord {
	readonly copiedAt?: number;
	readonly noticedMtimes: Readonly<Record<string, number>>;
}

function readState(agentDir: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(join(agentDir, MIGRATIONS_STATE_FILENAME), "utf-8"));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || parsed.schemaVersion !== MIGRATIONS_STATE_SCHEMA_VERSION) return undefined;
	return parsed;
}

function completedOf(state: Record<string, unknown> | undefined): ScanMigrationName[] {
	const completed = state?.completed;
	if (!isStringArray(completed)) return [];
	return completed.filter((name): name is ScanMigrationName => isScanMigrationName(name));
}

export function readCompletedScanMigrations(agentDir: string = getAgentDir()): ReadonlySet<ScanMigrationName> {
	return new Set(completedOf(readState(agentDir)));
}

export function writeCompletedScanMigrations(
	completed: readonly ScanMigrationName[],
	agentDir: string = getAgentDir(),
): void {
	writeState(agentDir, { ...readState(agentDir), completed: [...completed] });
}

function isMtimeEntry(entry: [string, unknown]): entry is [string, number] {
	return typeof entry[1] === "number" && Number.isFinite(entry[1]);
}

export function readLegacyPiAgentDirRecord(agentDir: string = getAgentDir()): LegacyPiAgentDirRecord {
	const raw = readState(agentDir)?.legacyPiAgentDir;
	if (!isRecord(raw)) return { noticedMtimes: {} };
	const noticedMtimes = isRecord(raw.noticedMtimes)
		? Object.fromEntries(Object.entries(raw.noticedMtimes).filter(isMtimeEntry))
		: {};
	const copiedAt = raw.copiedAt;
	return typeof copiedAt === "number" && Number.isFinite(copiedAt) ? { copiedAt, noticedMtimes } : { noticedMtimes };
}

export function writeLegacyPiAgentDirRecord(record: LegacyPiAgentDirRecord, agentDir: string = getAgentDir()): void {
	const state = readState(agentDir);
	writeState(agentDir, { ...state, completed: completedOf(state), legacyPiAgentDir: record });
}

/** A fresh copy restarts the notice history: every later pi edit is new to this agent dir. */
export function recordLegacyPiAgentDirCopy(agentDir: string = getAgentDir(), copiedAt: number = Date.now()): void {
	writeLegacyPiAgentDirRecord({ copiedAt, noticedMtimes: {} }, agentDir);
}

/** Keeps every field it does not own, so the scan list and the pi-copy record never erase each other. */
function writeState(agentDir: string, fields: Record<string, unknown>): void {
	mkdirSync(agentDir, { recursive: true });
	const target = join(agentDir, MIGRATIONS_STATE_FILENAME);
	const temporary = `${target}.${process.pid}.tmp`;
	const payload = { schemaVersion: MIGRATIONS_STATE_SCHEMA_VERSION, ...fields };
	try {
		writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
		renameSync(temporary, target);
	} catch {
		try {
			rmSync(temporary, { force: true });
		} catch {
			// Next boot fail-opens and rescans.
		}
	}
}
