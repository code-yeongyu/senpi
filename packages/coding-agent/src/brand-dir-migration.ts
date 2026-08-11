import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, CONFIG_FLAT_LAYOUT, FLAT_LAYOUT_SENTINEL } from "./config.ts";

/**
 * First-run copy-forward for a rebranded install.
 *
 * A machine that already ran the engine keeps its state in the engine's own directory. A
 * branded install reads a different location, so the existing state is COPIED once - never
 * moved - because the same machine may keep running the engine standalone, and a move would
 * silently empty that install.
 */

/** Written last, so an interrupted copy simply runs again next start. */
export const MIGRATION_MARKER = ".migrated-from-senpi";

/** Regenerable state: caches, logs and build worktrees are rebuilt on demand. */
const SKIPPED_ENTRIES = new Set(["cache", "logs", "omo-local-update"]);

function isSkipped(entry: string): boolean {
	return SKIPPED_ENTRIES.has(entry) || entry.endsWith(".log");
}

export interface BrandDirMigrationResult {
	readonly migrated: boolean;
	readonly copied: readonly string[];
	readonly from: string;
	readonly to: string;
}

/**
 * Copies engine state into the branded directory. Idempotent: entries that already exist in
 * the destination are left untouched, so a re-run after a partial copy completes it instead of
 * overwriting newer state.
 */
export function migrateEngineStateToBrandDir(legacyAgentDir: string, brandDir: string): BrandDirMigrationResult {
	const result = { migrated: false, copied: [] as string[], from: legacyAgentDir, to: brandDir };
	if (!existsSync(legacyAgentDir)) return result;
	if (existsSync(join(brandDir, MIGRATION_MARKER))) return result;
	if (existsSync(join(brandDir, FLAT_LAYOUT_SENTINEL))) return result;

	let entries: string[];
	try {
		entries = readdirSync(legacyAgentDir);
	} catch {
		return result;
	}

	mkdirSync(brandDir, { recursive: true });
	const copied: string[] = [];
	for (const entry of entries) {
		if (isSkipped(entry)) continue;
		const target = join(brandDir, entry);
		if (existsSync(target)) continue;
		try {
			cpSync(join(legacyAgentDir, entry), target, { recursive: true, errorOnExist: false });
			copied.push(entry);
		} catch {}
	}

	try {
		writeFileSync(join(brandDir, MIGRATION_MARKER), `${legacyAgentDir}\n`);
	} catch {
		return { ...result, copied };
	}

	return { migrated: true, copied, from: legacyAgentDir, to: brandDir };
}

/**
 * Runs the copy-forward for the active brand, announcing it once so the user knows the two
 * installs now hold independent state.
 */
export function migrateEngineStateForBrand(homeDir: string = homedir()): BrandDirMigrationResult | undefined {
	if (!CONFIG_FLAT_LAYOUT) return undefined;

	const result = migrateEngineStateToBrandDir(join(homeDir, ".senpi", "agent"), join(homeDir, CONFIG_DIR_NAME));
	if (result.migrated && result.copied.length > 0) {
		console.log(chalk.green(`Copied existing settings from ${result.from} to ${result.to}`));
		console.log(chalk.dim("The original directory is untouched; the two installs keep separate state from now on."));
	}
	return result;
}
