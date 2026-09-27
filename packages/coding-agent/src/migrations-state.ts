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

function parseCompleted(raw: string): ScanMigrationName[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	if (parsed.schemaVersion !== MIGRATIONS_STATE_SCHEMA_VERSION) return undefined;
	const completed = parsed.completed;
	if (!isStringArray(completed)) return undefined;
	return completed.filter((name): name is ScanMigrationName => isScanMigrationName(name));
}

export function readCompletedScanMigrations(agentDir: string = getAgentDir()): ReadonlySet<ScanMigrationName> {
	try {
		const raw = readFileSync(join(agentDir, MIGRATIONS_STATE_FILENAME), "utf-8");
		const completed = parseCompleted(raw);
		if (!completed) return new Set();
		return new Set(completed);
	} catch {
		return new Set();
	}
}

export function writeCompletedScanMigrations(
	completed: readonly ScanMigrationName[],
	agentDir: string = getAgentDir(),
): void {
	mkdirSync(agentDir, { recursive: true });
	const target = join(agentDir, MIGRATIONS_STATE_FILENAME);
	const temporary = `${target}.${process.pid}.tmp`;
	const payload = {
		schemaVersion: MIGRATIONS_STATE_SCHEMA_VERSION,
		completed: [...completed],
	} satisfies { schemaVersion: number; completed: string[] };
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
