import os from "node:os";
import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, renameSync } from "fs";
import { dirname, join } from "path";
import { APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import {
	copyMissingEntries,
	isRegenerableEntry,
	isWithinOrSamePath,
	pathsPointToSameLocation,
} from "./legacy-dir-copy.ts";
import { recordLegacyPiAgentDirCopy } from "./migrations-state.ts";

/**
 * Official `.pi` directories belong to an upstream pi install that keeps running on this machine,
 * so they are only ever copied. Only `.pi` leftovers nested in our own config dir are moved.
 */
type LegacyDirTransfer = "copy" | "move";

interface LegacyDir {
	readonly from: string;
	readonly to: string;
	readonly label: string;
	readonly transfer: LegacyDirTransfer;
	/** The global agent copy is where config lives from now on: its time is recorded and its line says so. */
	readonly isAgentConfig?: boolean;
}

function copyLegacyDir({ from, to, label, isAgentConfig }: LegacyDir): void {
	const copied = copyMissingEntries(from, to, (entry) => !isRegenerableEntry(entry));
	if (copied.length === 0) return;
	console.log(chalk.green(`Copied ${label} ${from} → ${to}`));
	if (isAgentConfig) {
		recordLegacyPiAgentDirCopy(to);
		console.log(
			chalk.dim(`${APP_NAME} reads its config from ${to} now; edits to ${from} no longer reach ${APP_NAME}.`),
		);
	} else {
		console.log(chalk.dim("The original directory is untouched; the two installs keep separate state from now on."));
	}
}

function moveLegacyDir({ from, to, label }: LegacyDir): void {
	if (!existsSync(to)) {
		mkdirSync(dirname(to), { recursive: true });
		renameSync(from, to);
		console.log(chalk.green(`Migrated ${label} ${from} → ${to}`));
		return;
	}

	let movedAny = false;
	for (const entry of readdirSync(from)) {
		const target = join(to, entry);
		if (existsSync(target)) continue;
		renameSync(join(from, entry), target);
		movedAny = true;
	}
	if (movedAny) {
		console.log(chalk.green(`Migrated missing ${label} entries ${from} → ${to}`));
	}
}

function transferLegacyDir(dir: LegacyDir): void {
	if (!existsSync(dir.from)) return;
	if (existsSync(dir.to) && pathsPointToSameLocation(dir.from, dir.to)) return;
	try {
		switch (dir.transfer) {
			case "copy":
				copyLegacyDir(dir);
				return;
			case "move":
				moveLegacyDir(dir);
				return;
		}
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(chalk.yellow(`Skipped the ${dir.label} ${dir.from}: ${reason}`));
	}
}

export function migrateLegacySenpiDirs(cwd: string): void {
	if (CONFIG_DIR_NAME === ".pi") return;

	const homeDir = os.homedir();
	const globalNewAgentDir = getAgentDir();
	const globalNewMomDir = join(homeDir, CONFIG_DIR_NAME, "mom");
	const projectNewDir = join(cwd, CONFIG_DIR_NAME);
	const shouldMigrateHomeConfig = isWithinOrSamePath(globalNewAgentDir, join(homeDir, CONFIG_DIR_NAME));

	const dirs: LegacyDir[] = [
		{ from: join(cwd, ".pi"), to: projectNewDir, label: "project config directory", transfer: "copy" },
		{
			from: join(cwd, CONFIG_DIR_NAME, ".pi"),
			to: projectNewDir,
			label: "nested project config directory",
			transfer: "move",
		},
	];

	if (shouldMigrateHomeConfig) {
		dirs.unshift(
			{
				from: join(homeDir, ".pi", "agent"),
				to: globalNewAgentDir,
				label: "global agent directory",
				transfer: "copy",
				isAgentConfig: true,
			},
			{
				from: join(homeDir, CONFIG_DIR_NAME, ".pi", "agent"),
				to: globalNewAgentDir,
				label: "nested global agent directory",
				transfer: "move",
			},
			{ from: join(homeDir, ".pi", "mom"), to: globalNewMomDir, label: "global mom directory", transfer: "copy" },
			{
				from: join(homeDir, CONFIG_DIR_NAME, ".pi", "mom"),
				to: globalNewMomDir,
				label: "nested global mom directory",
				transfer: "move",
			},
		);
	}

	for (const dir of dirs) {
		transferLegacyDir(dir);
	}
}
