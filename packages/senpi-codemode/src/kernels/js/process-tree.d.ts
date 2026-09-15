export type ProcessTable = ReadonlyMap<number, readonly number[]>;

export interface TerminateProcessTreesOptions {
	/** How long the trees get to honour SIGTERM before SIGKILL. */
	readonly graceMs: number;
	/** How long to wait after SIGKILL; defaults to `graceMs`. */
	readonly killWaitMs?: number;
	/** Resolves once every owned handle has exited; shortens the wait when it settles early. */
	readonly settled?: Promise<unknown>;
	/** When set, only roots `ps` still lists as direct children of this pid are signalled (guards against pid reuse). */
	readonly ownerPid?: number;
}

export function isProcessAlive(pid: number): boolean;

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean;

export function readProcessTable(): Promise<ProcessTable>;

export function collectDescendants(table: ProcessTable, roots: readonly number[]): number[];

export function ownedRoots(table: ProcessTable, parentPid: number, roots: readonly number[]): number[];

export function terminateProcessTrees(roots: readonly number[], options: TerminateProcessTreesOptions): Promise<void>;
