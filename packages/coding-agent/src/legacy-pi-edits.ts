import { copyFileSync, existsSync, mkdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP_COMMAND, APP_NAME, CONFIG_DIR_NAME, getAgentDir } from "./config.ts";
import { pathsPointToSameLocation } from "./legacy-dir-copy.ts";
import { readLegacyPiAgentDirRecord, writeLegacyPiAgentDirRecord } from "./migrations-state.ts";

/**
 * After the one-time copy, `~/.pi/agent` belongs to upstream pi and is never written here. A user
 * who keeps editing its config files gets no effect in this product (omo#9173), so those edits are
 * detected and reported, and can be imported on request.
 */
export const LEGACY_PI_CONFIG_FILES = ["auth.json", "keybindings.json", "models.json", "settings.json"] as const;

export type LegacyPiConfigFile = (typeof LEGACY_PI_CONFIG_FILES)[number];

export interface LegacyPiEdit {
	readonly file: LegacyPiConfigFile;
	readonly piPath: string;
	readonly agentPath: string;
	readonly mtimeMs: number;
}

export interface LegacyPiDirOptions {
	readonly agentDir?: string;
	readonly homeDir?: string;
}

interface LegacyPiDirs {
	readonly agentDir: string;
	readonly piAgentDir: string;
}

export interface LegacyPiImported {
	readonly file: LegacyPiConfigFile;
	readonly from: string;
	readonly to: string;
	readonly backupPath?: string;
}

export interface LegacyPiImportFailure {
	readonly file: string;
	readonly reason: string;
}

export interface LegacyPiImportResult {
	readonly piAgentDir: string;
	readonly agentDir: string;
	readonly imported: readonly LegacyPiImported[];
	readonly failures: readonly LegacyPiImportFailure[];
}

export function isLegacyPiConfigFile(name: string): name is LegacyPiConfigFile {
	return LEGACY_PI_CONFIG_FILES.some((file) => file === name);
}

function dirsFor(options: LegacyPiDirOptions): LegacyPiDirs {
	return {
		agentDir: options.agentDir ?? getAgentDir(),
		piAgentDir: join(options.homeDir ?? homedir(), ".pi", "agent"),
	};
}

function hasSeparatePiAgentDir(dirs: LegacyPiDirs): boolean {
	if (CONFIG_DIR_NAME === ".pi" || !existsSync(dirs.piAgentDir)) return false;
	return !existsSync(dirs.agentDir) || !pathsPointToSameLocation(dirs.piAgentDir, dirs.agentDir);
}

function fileStat(path: string): Stats | undefined {
	try {
		const stat = statSync(path);
		return stat.isFile() ? stat : undefined;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			return undefined;
		}
		throw error;
	}
}

/**
 * A pi file counts as edited when it changed after the recorded copy and its content differs from
 * the agent dir's copy. Installs copied before the time was recorded fall back to the agent copy's
 * mtime, which the copy preserved from the pi file.
 */
function editOf(file: LegacyPiConfigFile, dirs: LegacyPiDirs, copiedAt: number | undefined): LegacyPiEdit | undefined {
	const piPath = join(dirs.piAgentDir, file);
	const agentPath = join(dirs.agentDir, file);
	const pi = fileStat(piPath);
	if (pi === undefined) return undefined;
	const agent = fileStat(agentPath);
	const baseline = copiedAt ?? agent?.mtimeMs ?? 0;
	if (pi.mtimeMs <= baseline) return undefined;
	if (agent !== undefined && readFileSync(piPath).equals(readFileSync(agentPath))) return undefined;
	return { file, piPath, agentPath, mtimeMs: pi.mtimeMs };
}

function editsIn(dirs: LegacyPiDirs, copiedAt: number | undefined): LegacyPiEdit[] {
	if (!hasSeparatePiAgentDir(dirs)) return [];
	return LEGACY_PI_CONFIG_FILES.flatMap((file) => editOf(file, dirs, copiedAt) ?? []);
}

export function findLegacyPiEdits(options: LegacyPiDirOptions = {}): readonly LegacyPiEdit[] {
	const dirs = dirsFor(options);
	return editsIn(dirs, readLegacyPiAgentDirRecord(dirs.agentDir).copiedAt);
}

/** The edits not reported yet, recorded as reported so each change is announced exactly once. */
export function takeLegacyPiEditNotice(options: LegacyPiDirOptions = {}): readonly LegacyPiEdit[] {
	const dirs = dirsFor(options);
	const record = readLegacyPiAgentDirRecord(dirs.agentDir);
	const unreported = editsIn(dirs, record.copiedAt).filter((edit) => record.noticedMtimes[edit.file] !== edit.mtimeMs);
	if (unreported.length > 0) {
		const noticed = Object.fromEntries(unreported.map((edit) => [edit.file, edit.mtimeMs]));
		writeLegacyPiAgentDirRecord({ ...record, noticedMtimes: { ...record.noticedMtimes, ...noticed } }, dirs.agentDir);
	}
	return unreported;
}

export function formatLegacyPiEditNotice(edits: readonly LegacyPiEdit[], agentDir: string): string {
	const files = edits.map((edit) => edit.file).join(" ");
	const command = `${APP_COMMAND} config import-pi ${files}`;
	const [only] = edits;
	if (edits.length === 1 && only !== undefined) {
		return `You edited ${only.piPath} after ${APP_NAME} moved to ${agentDir}; ${APP_NAME} reads ${only.agentPath}. Copy your change there (or run: ${command}).`;
	}
	const piPaths = edits.map((edit) => edit.piPath).join(", ");
	return `You edited ${piPaths} after ${APP_NAME} moved to ${agentDir}; ${APP_NAME} reads its config from ${agentDir}. Copy your changes there (or run: ${command}).`;
}

/** Startup must not fail over this check, so an unreadable pi file becomes the warning itself. */
export function legacyPiEditStartupNotice(options: LegacyPiDirOptions = {}): string | undefined {
	try {
		const edits = takeLegacyPiEditNotice(options);
		return edits.length > 0 ? formatLegacyPiEditNotice(edits, dirsFor(options).agentDir) : undefined;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return `Could not check ${dirsFor(options).piAgentDir} for config edits: ${reason}`;
	}
}

function backupSuffix(now: Date): string {
	return now.toISOString().replace(/[-:.]/g, "");
}

function importOne(file: string, dirs: LegacyPiDirs, now: Date): LegacyPiImported | LegacyPiImportFailure {
	if (!isLegacyPiConfigFile(file)) {
		return { file, reason: `not one of ${LEGACY_PI_CONFIG_FILES.join(", ")}` };
	}
	const from = join(dirs.piAgentDir, file);
	const to = join(dirs.agentDir, file);
	if (fileStat(from) === undefined) return { file, reason: `${from} does not exist` };
	mkdirSync(dirs.agentDir, { recursive: true });
	let backupPath: string | undefined;
	if (fileStat(to) !== undefined) {
		backupPath = `${to}.bak-${backupSuffix(now)}`;
		copyFileSync(to, backupPath);
	}
	copyFileSync(from, to);
	return backupPath === undefined ? { file, from, to } : { file, from, to, backupPath };
}

/**
 * Copies the named config files (all edited ones when none is named) from `~/.pi/agent` into the
 * agent dir, backing up each agent copy first. Only reads `~/.pi/agent`.
 */
export function importLegacyPiConfig(
	files: readonly string[],
	options: LegacyPiDirOptions & { readonly now?: Date } = {},
): LegacyPiImportResult {
	const dirs = dirsFor(options);
	if (!hasSeparatePiAgentDir(dirs)) {
		return {
			...dirs,
			imported: [],
			failures: [{ file: dirs.piAgentDir, reason: "no separate pi config to import" }],
		};
	}
	const requested = files.length > 0 ? files : findLegacyPiEdits(options).map((edit) => edit.file);
	const imported: LegacyPiImported[] = [];
	const failures: LegacyPiImportFailure[] = [];
	for (const file of requested) {
		const outcome = importOne(file, dirs, options.now ?? new Date());
		if ("reason" in outcome) failures.push(outcome);
		else imported.push(outcome);
	}
	return { ...dirs, imported, failures };
}
