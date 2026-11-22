import type { execFile, spawnSync } from "node:child_process";

export function windowsProcessCreatedAtAsync(pid: number, run?: typeof execFile): Promise<bigint | undefined>;
export function windowsTreeKillArgs(
	rootPid: number,
	run?: typeof spawnSync,
	selfPid?: number,
	rootCreatedAt?: bigint,
): string[];
export function windowsTreeKillArgsAsync(
	rootPid: number,
	run?: typeof execFile,
	selfPid?: number,
	rootCreatedAt?: bigint,
): Promise<string[]>;
