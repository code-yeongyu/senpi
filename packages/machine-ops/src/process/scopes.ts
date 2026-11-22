import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Environment variable every exec/spawn child of an instance with a scope registry (a `stateDir`) carries; the sweep
 * finds members by it. An instance without a registry (senpi's own tool path) adds no variable.
 */
export const SCOPE_ENV = "SENPI_MACHINE_SCOPE";
/** Set on the runtime's own processes, which a sweep never signals. */
export const RUNTIME_ENV = "OMO_MACHINE_RUNTIME";

/** HUP, then TERM, then KILL, each followed by its wait (herdr sweep ladder). */
export const SWEEP_LADDER: readonly { readonly signal: NodeJS.Signals; readonly waitMs: number }[] = [
	{ signal: "SIGHUP", waitMs: 500 },
	{ signal: "SIGTERM", waitMs: 500 },
	{ signal: "SIGKILL", waitMs: 2000 },
];
const SWEEP_POLL_MS = 25;

export function newScopeToken(): string {
	return randomBytes(16).toString("base64url");
}

function alive(target: number): boolean {
	try {
		process.kill(target, 0);
		return true;
	} catch (error) {
		// EPERM means the target exists but is not ours to signal; only ESRCH proves it is gone.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * The start time the OS reports for `pid`, as an opaque string, or undefined when it cannot be read. Linux: field 22
 * of `/proc/<pid>/stat` (clock ticks since boot), read synchronously so a just-spawned child cannot be reaped first;
 * macOS/BSD: `ps -o lstart=`; Windows: undefined (recorded groups are never swept there).
 */
function readStartTime(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			// Field 2 (comm) may contain spaces and parentheses; the fields after its closing ")" start at field 3.
			return Promise.resolve(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[22 - 3]);
		} catch {
			return Promise.resolve(undefined);
		}
	}
	if (process.platform === "win32") return Promise.resolve(undefined);
	return new Promise((resolve) => {
		execFile("ps", ["-o", "lstart=", "-p", String(pid)], (error, stdout) => {
			const value = stdout.trim();
			resolve(error || value === "" ? undefined : value);
		});
	});
}

function signal(target: number, sig: NodeJS.Signals): void {
	try {
		process.kill(target, sig);
	} catch {
		// Already gone.
	}
}

/** Linux: every process whose environment carries `<SCOPE_ENV>=<token>` and not `<RUNTIME_ENV>=1`. */
async function scanEnvironments(tokens: ReadonlySet<string>): Promise<number[]> {
	if (process.platform !== "linux") return [];
	let names: string[];
	try {
		names = await readdir("/proc");
	} catch {
		return [];
	}
	const members: number[] = [];
	await Promise.all(
		names.map(async (name) => {
			const pid = Number(name);
			if (!Number.isInteger(pid) || pid === process.pid) return;
			let environ: string;
			try {
				environ = await readFile(`/proc/${pid}/environ`, "utf8");
			} catch {
				return;
			}
			const vars = environ.split("\0");
			if (vars.includes(`${RUNTIME_ENV}=1`)) return;
			for (const entry of vars) {
				if (entry.startsWith(`${SCOPE_ENV}=`) && tokens.has(entry.slice(SCOPE_ENV.length + 1))) {
					members.push(pid);
					return;
				}
			}
		}),
	);
	return members;
}

function groupTarget(pid: number): number {
	return process.platform === "win32" ? pid : -pid;
}

/**
 * Scope tokens: the token file is written under `<stateDir>/machine/scopes/` before the child spawns, so a crash
 * between spawn and bookkeeping still leaves a record; `sweep` ends every member of a token.
 */
export class ScopeRegistry {
	private readonly dir: string;
	/** token -> process-group leader -> the leader's start time read when it was attached. */
	private readonly groups = new Map<string, Map<number, Promise<string | undefined>>>();
	private readonly killTree: (pid: number) => void;
	private readonly startTimeOf: (pid: number) => Promise<string | undefined>;

	constructor(
		stateDir: string,
		killTree: (pid: number) => void,
		options?: { readonly startTimeOf?: (pid: number) => Promise<string | undefined> },
	) {
		this.dir = join(stateDir, "machine", "scopes");
		this.killTree = killTree;
		this.startTimeOf = options?.startTimeOf ?? readStartTime;
	}

	tokenPath(token: string): string {
		return join(this.dir, `${token}.json`);
	}

	async record(token: string, meta: { principal: string; command: string }): Promise<void> {
		// Created on every record, never cached: a scopes dir removed mid-process is recreated, not fatal forever.
		await mkdir(this.dir, { recursive: true });
		await writeFile(this.tokenPath(token), `${JSON.stringify({ token, createdAtMs: Date.now(), ...meta })}\n`);
	}

	attach(token: string, pid: number): void {
		let leaders = this.groups.get(token);
		if (leaders === undefined) {
			leaders = new Map();
			this.groups.set(token, leaders);
		}
		leaders.set(pid, this.startTimeOf(pid));
	}

	/** Drop the token file once its exec settled; the group stays sweepable by token. */
	async release(token: string): Promise<void> {
		await rm(this.tokenPath(token), { force: true });
		const leaders = this.groups.get(token);
		if (leaders === undefined) return;
		for (const pid of leaders.keys()) if (!alive(groupTarget(pid))) leaders.delete(pid);
		if (leaders.size === 0) this.groups.delete(token);
	}

	/**
	 * Whether the live group `pid` is still the one this registry started. A live process with the leader's pid must
	 * have the start time recorded at attach. A gone leader with a live group is ours: POSIX does not reuse a process
	 * group ID while the group exists, so the pid cannot have been handed to a new group leader meanwhile.
	 */
	private async sameGroup(pid: number, recorded: Promise<string | undefined>): Promise<boolean> {
		if (!alive(pid)) return true;
		const then = await recorded;
		return then !== undefined && (await this.startTimeOf(pid)) === then;
	}

	private async targets(tokens: ReadonlySet<string>): Promise<{ groups: number[]; pids: number[] }> {
		const groups: number[] = [];
		for (const token of tokens) {
			const leaders = this.groups.get(token);
			if (leaders === undefined) continue;
			for (const [pid, recorded] of leaders) {
				if (!alive(groupTarget(pid))) continue;
				// A reused pid leads a group this registry did not create: drop the record without signalling.
				if (await this.sameGroup(pid, recorded)) groups.push(pid);
				else leaders.delete(pid);
			}
		}
		const pids = (await scanEnvironments(tokens)).filter(alive);
		return { groups, pids };
	}

	async sweep(tokenList: readonly string[]): Promise<void> {
		const tokens = new Set(tokenList);
		for (const step of SWEEP_LADDER) {
			const { groups, pids } = await this.targets(tokens);
			if (groups.length === 0 && pids.length === 0) break;
			if (process.platform === "win32") {
				if (step.signal === "SIGKILL") for (const pid of [...groups, ...pids]) this.killTree(pid);
			} else {
				for (const pgid of groups) signal(-pgid, step.signal);
				for (const pid of pids) signal(pid, step.signal);
			}
			const deadline = Date.now() + step.waitMs;
			for (;;) {
				const live = [...groups.map(groupTarget), ...pids].filter(alive);
				if (live.length === 0 || Date.now() >= deadline) break;
				// OS boundary: process death has no event to await, so the wait is a bounded poll.
				await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_MS));
			}
		}
		for (const token of tokens) {
			this.groups.delete(token);
			await rm(this.tokenPath(token), { force: true });
		}
	}
}
