import { DEFAULT_LIMITS } from "./limits.ts";
import { createLocalInfoOps } from "./info/local-info.ts";
import { createLocalFileOps } from "./files/local-files.ts";
import type { FdResolver } from "./files/glob.ts";
import { gated } from "./policy/gate.ts";
import { defaultKillTree, runExec } from "./process/exec.ts";
import { HandleRegistry } from "./process/handles.ts";
import type { HolderLink } from "./process/holder-link.ts";
import { ScopeRegistry } from "./process/scopes.ts";
import type { FileOps, Limits, MachineOps, OpContext, ProcessOps } from "./types.ts";

export interface LocalMachineOpsOptions {
	/**
	 * Root of the host's machine state; setting it configures the scope registry. With it, every exec/spawn records a
	 * token file under `machine/scopes/` before the child starts, the child carries `SENPI_MACHINE_SCOPE`, and
	 * `info.message` appends to `machine/inbox/`. Without it nothing is written to disk, children get no scope
	 * variable, `process.sweep` is a no-op, and `process.spawn` / `info.message` reject with `invalid_argument`.
	 */
	readonly stateDir?: string;
	/** Owner of spawned PTYs. */
	readonly holder: HolderLink;
	/** Host defaults; every op reads its own limits from `OpContext.limits`. Default `DEFAULT_LIMITS`. */
	readonly limits?: Limits;
	/** Process-tree kill for exec abort/timeout. Default: SIGKILL the process group (POSIX). */
	readonly killProcessTree?: (pid: number) => void;
	/** fd lookup for `files.glob`. Default: fd on PATH, else a built-in walker. */
	readonly resolveFd?: FdResolver;
}

/** The local implementation of every op, one instance per host runtime. No concurrency cap anywhere. */
export function createLocalMachineOps(options: LocalMachineOpsOptions): MachineOps {
	const limits = options.limits ?? DEFAULT_LIMITS;
	const killTree = options.killProcessTree ?? defaultKillTree;
	const scopes = options.stateDir === undefined ? undefined : new ScopeRegistry(options.stateDir, killTree);
	const handles = new HandleRegistry(options.holder, scopes, limits);
	let lastOpAtMs: number | undefined;
	const touch = <A extends unknown[], R>(fn: (...args: A) => R) => {
		return (...args: A): R => {
			lastOpAtMs = Date.now();
			return fn(...args);
		};
	};

	const localFiles = createLocalFileOps({ resolveFd: options.resolveFd });
	const files: FileOps = {
		read: touch(localFiles.read),
		write: touch(localFiles.write),
		edit: touch(localFiles.edit),
		glob: touch(localFiles.glob),
		grep: touch(localFiles.grep),
		stat: touch(localFiles.stat),
		list: touch(localFiles.list),
	};
	const processOps: ProcessOps = {
		exec: touch((req, ctx: OpContext) =>
			gated("process.exec", req, ctx, () => runExec(req, ctx, { scopes, killTree })),
		),
		spawn: touch((req, ctx: OpContext) =>
			gated("process.spawn", req, ctx, () => handles.spawn(req, ctx.principal.id, ctx.limits)),
		),
		handle: (id) => handles.get(id),
		list: (principal) => handles.list(principal),
		sweep: touch(async (tokens) => {
			await scopes?.sweep(tokens);
		}),
	};
	const info = createLocalInfoOps({
		stateDir: options.stateDir,
		handle: (id) => handles.get(id),
		lastOpAtMs: () => lastOpAtMs,
	});
	return { files, process: processOps, info, limits };
}
