import type { execFile, spawnSync } from "node:child_process";

export function windowsTreeKillArgs(rootPid: number, run?: typeof spawnSync, selfPid?: number): string[];
export function windowsTreeKillArgsAsync(rootPid: number, run?: typeof execFile, selfPid?: number): Promise<string[]>;
