import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import {
	copyMissingEntries,
	isRegenerableEntry,
	isWithinOrSamePath,
	pathsPointToSameLocation,
} from "./legacy-dir-copy.ts";
import { MIGRATIONS_STATE_FILENAME, recordLegacyPiAgentDirCopy, type ScanMigrationName } from "./migrations-state.ts";

/** Upstream pi's agent-dir entries; anything else in our agent dir is our own state and never goes to pi. */
const UPSTREAM_PI_AGENT_ENTRIES: ReadonlySet<string> = new Set([
	"auth.json",
	"settings.json",
	"models.json",
	"models-store.json",
	"keybindings.json",
	"sessions",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"npm",
	"git",
	"experimental",
	"AGENTS.md",
	"CLAUDE.md",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
]);

function isDirectory(path: string): boolean {
	return existsSync(path) && statSync(path).isDirectory();
}

/**
 * Before this release, the first start moved `~/.pi/agent` and `~/.pi/mom` into this product's
 * directories. A recorded run of that migration, or engine state written by a build older than the
 * migrations state file, is the evidence that it may have happened on this agent dir.
 */
function movingMigrationMayHaveRun(agentDir: string, completed: ReadonlySet<ScanMigrationName>): boolean {
	if (completed.has("migrateLegacySenpiDirs")) return true;
	if (existsSync(join(agentDir, MIGRATIONS_STATE_FILENAME))) return false;
	return isDirectory(agentDir) && readdirSync(agentDir).some((entry) => UPSTREAM_PI_AGENT_ENTRIES.has(entry));
}

/** pi writes `{}` into `auth.json` and `models-store.json` when it starts with an empty directory. */
function isEmptyJsonStub(path: string): boolean {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.size > 16) return false;
	const text = readFileSync(path, "utf-8").trim();
	return text === "{}" || text === "[]";
}

function holdsNoUserState(dir: string): boolean {
	if (!existsSync(dir)) return true;
	return readdirSync(dir).every((entry) => isRegenerableEntry(entry) || isEmptyJsonStub(join(dir, entry)));
}

function restoreDir(from: string, to: string, include: (entry: string) => boolean): boolean {
	if (!isDirectory(from) || !holdsNoUserState(to)) return false;
	if (existsSync(to) && pathsPointToSameLocation(from, to)) return false;
	for (const entry of existsSync(to) ? readdirSync(to) : []) {
		if (include(entry) && existsSync(join(from, entry)) && isEmptyJsonStub(join(to, entry))) {
			rmSync(join(to, entry));
		}
	}
	const restored = copyMissingEntries(from, to, include);
	if (restored.length > 0) {
		console.log(chalk.green(`Restored ${to} from ${from}: an earlier start had moved it there.`));
		console.log(chalk.dim("Both directories now hold independent copies."));
	}
	return restored.length > 0;
}

/** Copies back what an earlier start moved out of `~/.pi`, only into an agent/mom dir holding no user state. */
export function restoreDrainedPiDirs(completed: ReadonlySet<ScanMigrationName>, homeDir: string = homedir()): void {
	if (CONFIG_DIR_NAME === ".pi") return;
	const agentDir = getAgentDir();
	const brandDir = join(homeDir, CONFIG_DIR_NAME);
	const piDir = join(homeDir, ".pi");
	if (!isWithinOrSamePath(agentDir, brandDir) || !isDirectory(piDir)) return;
	if (!movingMigrationMayHaveRun(agentDir, completed)) return;

	try {
		if (restoreDir(agentDir, join(piDir, "agent"), (entry) => UPSTREAM_PI_AGENT_ENTRIES.has(entry))) {
			recordLegacyPiAgentDirCopy(agentDir);
		}
		restoreDir(join(brandDir, "mom"), join(piDir, "mom"), (entry) => !isRegenerableEntry(entry));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(chalk.yellow(`Could not restore ${piDir}: ${reason}`));
	}
}
