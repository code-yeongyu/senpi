export interface WindowsProcessRow {
	readonly pid: number;
	readonly parentPid: number;
	readonly createdAt: bigint;
	readonly name: string;
}

export function parseWindowsRows(stdout: string): WindowsProcessRow[];
export function windowsTreeKillPids(rows: readonly WindowsProcessRow[], rootPid: number, selfPid: number): number[];
export function windowsTreeKillArgs(
	rootPid: number,
	rows: readonly WindowsProcessRow[] | undefined,
	selfPid?: number,
): string[];
export function listWindowsRows(): Promise<WindowsProcessRow[] | undefined>;
export function killWindowsTree(
	pid: number,
	listing?: Promise<readonly WindowsProcessRow[] | undefined>,
): Promise<void>;
