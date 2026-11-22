/**
 * The engine's ONE terminal manager for `machine_op` (senpi#6752): the `TerminalManager` the `bash` tools use, created
 * on the first `exec_command` and torn down with the host, so terminals outlive any client connection (a relay host
 * restart included). Handle ids are the manager's own (scoped by a per-process token, so an id never names a later
 * process's terminal), and each handle records the sender that created it. The newest FINISHED_KEPT ended handles keep
 * their output; older ones answer from a bounded summary row, as the relay host answers from its handle table.
 */
import { randomBytes } from "node:crypto";
import { curatedEnv } from "@code-yeongyu/senpi-machine-ops";
import { TerminalManager } from "../../../core/extensions/builtin/terminal/manager.ts";
import { type After, createLiveHandle, ended, type LiveHandle, type MachineLifecycle } from "./live-handle.ts";

/** Live terminals at once; a further `exec_command` fails until one ends. */
const MACHINE_TERMINALS_MAX = 256;
/** How long a kill waits for the process to end after the manager's stop (review L4); it then answers what it reached. */
export const MACHINE_TERMINAL_KILL_WAIT_MS = 5_000;
const FINISHED_KEPT = 64;
const RETIRED_KEPT = 4_096;
const PTY_COLS = 80;
const PTY_ROWS = 24;

export type HandleRecord = Readonly<{
	sender: string;
	state: MachineLifecycle;
	exitCode: number | null;
	startedMs: number;
}>;
export type SpawnAsk = Readonly<{
	sender: string;
	command: string;
	cwd: string;
	env: Readonly<Record<string, string>>;
	cols?: number;
	rows?: number;
}>;

const shell = (): readonly [string, ...string[]] =>
	process.platform === "win32"
		? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c"]
		: [process.env.SHELL || "/bin/sh", "-c"];

export class MachineTerminals {
	private manager: TerminalManager | undefined;
	private readonly live = new Map<string, LiveHandle>();
	private readonly finished: string[] = [];
	private readonly retired = new Map<string, HandleRecord>();
	private readonly after: After;

	constructor(after: After) {
		this.after = after;
	}

	async spawn(ask: SpawnAsk): Promise<LiveHandle> {
		this.manager ??= new TerminalManager({
			maxSessions: MACHINE_TERMINALS_MAX,
			idScope: randomBytes(6).toString("hex"),
		});
		const [path, ...args] = shell();
		const { id, runtime } = await this.manager.create(path, {
			command: path,
			args: [...args, ask.command],
			cwd: ask.cwd,
			env: { ...curatedEnv(process.env), TERM: "xterm-256color", ...ask.env },
			cols: ask.cols ?? PTY_COLS,
			rows: ask.rows ?? PTY_ROWS,
		});
		const handle = createLiveHandle({ id, sender: ask.sender, runtime, after: this.after });
		this.live.set(id, handle);
		void handle.ended.then(() => this.retire(handle));
		return handle;
	}

	get(id: string): LiveHandle | undefined {
		return this.live.get(id);
	}

	record(id: string): HandleRecord | undefined {
		return this.retired.get(id);
	}

	ownerOf(id: string): string | undefined {
		return this.live.get(id)?.sender ?? this.retired.get(id)?.sender;
	}

	pidOf(id: string): number | undefined {
		const h = this.live.get(id);
		return h === undefined || ended(h.state()) ? undefined : h.pid;
	}

	get running(): number {
		return [...this.live.values()].filter((h) => !ended(h.state())).length;
	}

	async kill(h: LiveHandle): Promise<void> {
		if (h.exit() !== null) return;
		h.markKilled();
		await this.manager?.stop(h.id);
		await new Promise<void>((resolve) => {
			const cancel = this.after(MACHINE_TERMINAL_KILL_WAIT_MS, resolve);
			void h.ended.then(() => {
				cancel();
				resolve();
			});
		});
	}

	async dispose(): Promise<void> {
		const manager = this.manager;
		this.manager = undefined;
		for (const h of this.live.values()) if (h.exit() === null) h.markKilled();
		await manager?.teardown();
		for (const h of this.live.values()) h.dispose();
		this.live.clear();
	}

	private retire(h: LiveHandle): void {
		this.finished.push(h.id);
		while (this.finished.length > FINISHED_KEPT) {
			const id = this.finished.shift();
			const old = id === undefined ? undefined : this.live.get(id);
			if (old === undefined) continue;
			old.dispose();
			this.live.delete(old.id);
			this.retired.set(old.id, {
				sender: old.sender,
				state: old.state(),
				exitCode: old.exit()?.exitCode ?? null,
				startedMs: old.startedMs,
			});
			for (const key of this.retired.keys()) {
				if (this.retired.size <= RETIRED_KEPT) break;
				this.retired.delete(key);
			}
		}
	}
}
