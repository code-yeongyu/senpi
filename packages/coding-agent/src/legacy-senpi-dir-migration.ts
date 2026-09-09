import os from "node:os";
import chalk from "chalk";
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";

/**
 * Written into a branded directory after the official `.pi` layout was copied into it, so the
 * copy happens once. The official directories are never moved: the same machine may keep running
 * upstream pi standalone, and a move would silently empty that install on every start.
 */
export const OFFICIAL_PI_MIGRATION_MARKER = ".migrated-from-pi";

function pathsPointToSameLocation(leftPath: string, rightPath: string): boolean {
	try {
		return realpathSync(leftPath) === realpathSync(rightPath);
	} catch {
		return false;
	}
}

function isWithinOrSamePath(childPath: string, parentPath: string): boolean {
	const relativePath = relative(resolve(parentPath), resolve(childPath));
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function migratePathPreservingExisting(oldPath: string, newPath: string, label: string): void {
	if (!existsSync(oldPath)) return;
	if (existsSync(newPath) && pathsPointToSameLocation(oldPath, newPath)) return;

	if (!existsSync(newPath)) {
		try {
			mkdirSync(dirname(newPath), { recursive: true });
			renameSync(oldPath, newPath);
			console.log(chalk.green(`Migrated ${label} ${oldPath} → ${newPath}`));
		} catch {
			return;
		}
		return;
	}

	let entries: string[];
	try {
		entries = readdirSync(oldPath);
	} catch {
		return;
	}

	let movedAny = false;
	for (const entry of entries) {
		const source = join(oldPath, entry);
		const target = join(newPath, entry);
		if (existsSync(target)) continue;
		try {
			renameSync(source, target);
			movedAny = true;
		} catch {}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated missing ${label} entries ${oldPath} → ${newPath}`));
	}
}

/**
 * One-time copy-forward of an official `.pi` directory. Entries already present in the
 * destination are left untouched, and the marker makes later starts skip the directory
 * entirely, so state the user keeps adding to upstream pi is never pulled in again.
 */
function copyPathPreservingExisting(oldPath: string, newPath: string, label: string): void {
	if (!existsSync(oldPath)) return;
	if (existsSync(newPath) && pathsPointToSameLocation(oldPath, newPath)) return;
	if (existsSync(join(newPath, OFFICIAL_PI_MIGRATION_MARKER))) return;

	let entries: string[];
	try {
		entries = readdirSync(oldPath);
	} catch {
		return;
	}

	try {
		mkdirSync(newPath, { recursive: true });
	} catch {
		return;
	}

	let copiedAny = false;
	for (const entry of entries) {
		const source = join(oldPath, entry);
		const target = join(newPath, entry);
		if (existsSync(target)) continue;
		try {
			cpSync(source, target, { recursive: true, errorOnExist: false });
			copiedAny = true;
		} catch {}
	}

	try {
		writeFileSync(join(newPath, OFFICIAL_PI_MIGRATION_MARKER), `${oldPath}\n`);
	} catch {}

	if (copiedAny) {
		console.log(chalk.green(`Copied ${label} ${oldPath} → ${newPath}`));
		console.log(chalk.dim("The original directory is untouched; the two installs keep separate state from now on."));
	}
}

export function migrateLegacySenpiDirs(cwd: string): void {
	if (CONFIG_DIR_NAME === ".pi") return;

	const homeDir = os.homedir();
	const globalNewAgentDir = getAgentDir();
	const globalNewMomDir = join(homeDir, CONFIG_DIR_NAME, "mom");
	const projectNewDir = join(cwd, CONFIG_DIR_NAME);
	const shouldMigrateHomeConfig = isWithinOrSamePath(globalNewAgentDir, join(homeDir, CONFIG_DIR_NAME));

	// Official upstream pi directories: copied once, never moved.
	const copies: Array<readonly [string, string, string]> = [
		[join(cwd, ".pi"), projectNewDir, "project config directory"],
	];
	// Pre-rename leftovers nested inside this fork's own config directory: nobody else reads them.
	const moves: Array<readonly [string, string, string]> = [
		[join(cwd, CONFIG_DIR_NAME, ".pi"), projectNewDir, "nested project config directory"],
	];

	if (shouldMigrateHomeConfig) {
		copies.unshift(
			[join(homeDir, ".pi", "agent"), globalNewAgentDir, "global agent directory"],
			[join(homeDir, ".pi", "mom"), globalNewMomDir, "global mom directory"],
		);
		moves.unshift(
			[join(homeDir, CONFIG_DIR_NAME, ".pi", "agent"), globalNewAgentDir, "nested global agent directory"],
			[join(homeDir, CONFIG_DIR_NAME, ".pi", "mom"), globalNewMomDir, "nested global mom directory"],
		);
	}

	for (const [oldPath, newPath, label] of copies) {
		copyPathPreservingExisting(oldPath, newPath, label);
	}
	for (const [oldPath, newPath, label] of moves) {
		migratePathPreservingExisting(oldPath, newPath, label);
	}
}
