import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Environment variable every exec/spawn child carries; the sweep finds members by it. */
export const SCOPE_ENV = "OMO_MACHINE_SCOPE";
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

/**
 * Scope tokens: the token file is written under `<stateDir>/machine/scopes/` before the child spawns, so a crash
 * between spawn and bookkeeping still leaves a record; `sweep` ends every member of a token.
 */
export class ScopeRegistry {
	private readonly dir: string;
	private ready: Promise<void> | undefined;
	/** token -> process-group leaders started under it. */
	private readonly groups = new Map<string, Set<number>>();
	private readonly killTree: (pid: number) => void;

	constructor(stateDir: string, killTree: (pid: number) => void) {
		this.dir = join(stateDir, "machine", "scopes");
		this.killTree = killTree;
	}

	tokenPath(token: string): string {
		return join(this.dir, `${token}.json`);
	}

	async record(token: string, meta: { principal: string; command: string }): Promise<void> {
		this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
		await this.ready;
		await writeFile(this.tokenPath(token), `${JSON.stringify({ token, createdAtMs: Date.now(), ...meta })}\n`);
	}

	attach(token: string, pid: number): void {
		let leaders = this.groups.get(token);
		if (leaders === undefined) {
			leaders = new Set();
			this.groups.set(token, leaders);
		}
		leaders.add(pid);
	}

	/** Drop the token file once its exec settled; the group stays sweepable by token. */
	async release(token: string): Promise<void> {
		await rm(this.tokenPath(token), { force: true });
		const leaders = this.groups.get(token);
		if (leaders === undefined) return;
		for (const pid of leaders) if (!alive(process.platform === "win32" ? pid : -pid)) leaders.delete(pid);
		if (leaders.size === 0) this.groups.delete(token);
	}

	private async targets(tokens: ReadonlySet<string>): Promise<{ groups: number[]; pids: number[] }> {
		const groups: number[] = [];
		for (const token of tokens) {
			for (const pid of this.groups.get(token) ?? []) {
				if (alive(process.platform === "win32" ? pid : -pid)) groups.push(pid);
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
				const live = [...groups.map((pid) => (process.platform === "win32" ? pid : -pid)), ...pids].filter(alive);
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
