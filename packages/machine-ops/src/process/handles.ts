import { randomBytes } from "node:crypto";
import { MachineOpError } from "../errors.ts";
import type {
	HandleInfo,
	HandleLifecycle,
	HandleStatus,
	Limits,
	OutputChunk,
	ProcessHandle,
	SpawnRequest,
	StdinEffect,
	WaitResult,
	WaitSpec,
} from "../types.ts";
import type { HeldExit, HeldTerminal, HolderLink } from "./holder-link.ts";
import { curatedEnv } from "./exec.ts";
import { newScopeToken, RUNTIME_ENV, SCOPE_ENV, type ScopeRegistry } from "./scopes.ts";

/** Output after a wait started that is kept for matching, as herdr's wait does. */
const SEEN_MAX_CHARS = 64 * 1024;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** CSI, OSC and two-byte escape sequences, for the text fallback of `screen()` when the holder has no emulator. */
const ANSI = new RegExp(
	`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
	"g",
);

class LocalProcessHandle implements ProcessHandle {
	readonly id: string;
	readonly pid: number;
	readonly scopeToken: string;
	readonly principal: string;
	readonly command: string;
	private readonly held: HeldTerminal;
	private readonly scopes: ScopeRegistry;
	private readonly retainLimit: number;
	private readonly startedAtMs = Date.now();
	private readonly chunks: OutputChunk[] = [];
	private retained = 0;
	private omitted = 0;
	private seq = 0;
	private exit: HeldExit | undefined;
	private killRequested = false;
	private readonly dataListeners = new Set<(chunk: OutputChunk) => void>();
	private readonly exitListeners = new Set<() => void>();
	private writes: Promise<unknown> = Promise.resolve();

	constructor(
		init: { id: string; scopeToken: string; principal: string; command: string; held: HeldTerminal },
		scopes: ScopeRegistry,
		limits: Limits,
	) {
		this.id = init.id;
		this.pid = init.held.pid;
		this.scopeToken = init.scopeToken;
		this.principal = init.principal;
		this.command = init.command;
		this.held = init.held;
		this.scopes = scopes;
		this.retainLimit = limits.retainedOutputBytes;
		init.held.onData((bytes) => this.append(bytes));
		init.held.onExit((exit) => {
			this.exit = exit;
			for (const listener of this.exitListeners) listener();
			this.exitListeners.clear();
		});
	}

	private append(bytes: Uint8Array): void {
		this.seq += 1;
		const chunk = { seq: this.seq, bytes };
		this.chunks.push(chunk);
		this.retained += bytes.byteLength;
		while (this.retained > this.retainLimit && this.chunks.length > 1) {
			const dropped = this.chunks.shift() as OutputChunk;
			this.retained -= dropped.bytes.byteLength;
			this.omitted += dropped.bytes.byteLength;
		}
		for (const listener of this.dataListeners) listener(chunk);
	}

	private subscribe(onData: (chunk: OutputChunk) => void, onExit: () => void): () => void {
		this.dataListeners.add(onData);
		this.exitListeners.add(onExit);
		return () => {
			this.dataListeners.delete(onData);
			this.exitListeners.delete(onExit);
		};
	}

	get state(): HandleLifecycle {
		if (this.exit === undefined) return "running";
		return this.killRequested ? "killed" : "exited";
	}

	status(): HandleStatus {
		return {
			id: this.id,
			pid: this.pid,
			state: this.state,
			exitCode: this.exit?.exitCode ?? null,
			signal: this.exit?.signal ?? null,
			lastSeq: this.seq,
			retainedBytes: this.retained,
			omittedBytes: this.omitted,
			startedAtMs: this.startedAtMs,
		};
	}

	async *output(fromSeq: number): AsyncIterable<OutputChunk> {
		const queue: OutputChunk[] = this.chunks.filter((chunk) => chunk.seq >= fromSeq);
		let wake: (() => void) | undefined;
		let ended = this.exit !== undefined;
		const unsubscribe = this.subscribe(
			(chunk) => {
				queue.push(chunk);
				wake?.();
			},
			() => {
				ended = true;
				wake?.();
			},
		);
		try {
			for (;;) {
				const next = queue.shift();
				if (next !== undefined) {
					yield next;
					continue;
				}
				if (ended) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
			}
		} finally {
			unsubscribe();
		}
	}

	async screen(opts?: { history?: number }): Promise<string> {
		if (this.held.screen !== undefined) return this.held.screen(opts?.history);
		return Buffer.concat(this.chunks.map((chunk) => chunk.bytes))
			.toString("utf8")
			.replace(ANSI, "");
	}

	write(bytes: Uint8Array, opts?: { expectActivityMs?: number }): Promise<StdinEffect> {
		// One input queue per handle, so concurrent writes never interleave.
		const run = this.writes.then(async (): Promise<StdinEffect> => {
			if (this.exit !== undefined) throw new MachineOpError("invalid_argument", `handle ${this.id} has exited`);
			const expectMs = opts?.expectActivityMs;
			if (expectMs === undefined) {
				this.held.write(bytes);
				return { acceptedBytes: bytes.byteLength };
			}
			let unsubscribe = () => {};
			const observed = new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), expectMs);
				unsubscribe = this.subscribe(
					() => {
						clearTimeout(timer);
						resolve(true);
					},
					() => {
						clearTimeout(timer);
						resolve(false);
					},
				);
			});
			this.held.write(bytes);
			try {
				return { acceptedBytes: bytes.byteLength, observed: await observed };
			} finally {
				unsubscribe();
			}
		});
		this.writes = run.catch(() => undefined);
		return run;
	}

	wait(spec: WaitSpec): Promise<WaitResult> {
		if (this.exit !== undefined) return Promise.resolve({ status: this.status(), reason: "exited" });
		return new Promise<WaitResult>((resolve) => {
			let seen = "";
			const decoder = new TextDecoder();
			const finish = (reason: WaitResult["reason"]) => {
				clearTimeout(timer);
				unsubscribe();
				resolve({ status: this.status(), reason });
			};
			const timer = setTimeout(() => finish("timeout"), spec.timeoutMs);
			const unsubscribe = this.subscribe(
				(chunk) => {
					if (spec.output === undefined) return;
					seen = (seen + decoder.decode(chunk.bytes, { stream: true })).slice(-SEEN_MAX_CHARS);
					if (seen.includes(spec.output)) finish("matched");
				},
				() => finish("exited"),
			);
		});
	}

	resize(cols: number, rows: number): void {
		this.held.resize(cols, rows);
	}

	async kill(signal?: NodeJS.Signals): Promise<void> {
		if (this.exit !== undefined) return;
		this.killRequested = true;
		if (signal !== undefined) {
			this.held.signal(signal);
			return;
		}
		const exited = new Promise<void>((resolve) => {
			const unsubscribe = this.subscribe(
				() => {},
				() => {
					unsubscribe();
					resolve();
				},
			);
		});
		await this.scopes.sweep([this.scopeToken]);
		// The pty leader may not carry the scope env on every backend; end it directly if the sweep missed it.
		if (this.exit === undefined) this.held.signal("SIGKILL");
		await exited;
	}

	info(): HandleInfo {
		return {
			id: this.id,
			pid: this.pid,
			principal: this.principal,
			scopeToken: this.scopeToken,
			command: this.command,
			state: this.state,
		};
	}
}

/** Live and finished handles of one MachineOps instance. */
export class HandleRegistry {
	private readonly handles = new Map<string, LocalProcessHandle>();
	private readonly holder: HolderLink;
	private readonly scopes: ScopeRegistry | undefined;
	private readonly limits: Limits;

	constructor(holder: HolderLink, scopes: ScopeRegistry | undefined, limits: Limits) {
		this.holder = holder;
		this.scopes = scopes;
		this.limits = limits;
	}

	async spawn(req: SpawnRequest, principal: string, limits: Limits): Promise<ProcessHandle> {
		const scopes = this.scopes;
		// A handle's kill sweeps its scope, so spawning needs the registry a `stateDir` configures.
		if (scopes === undefined) throw new MachineOpError("invalid_argument", "process.spawn needs a stateDir");
		const cap = limits.maxPtySessions ?? this.limits.maxPtySessions;
		if (cap !== undefined) {
			const live = [...this.handles.values()].filter((handle) => handle.state === "running").length;
			if (live >= cap)
				throw new MachineOpError("limit_exceeded", `${live} PTY sessions are live; the cap is ${cap}`);
		}
		const id = `h_${randomBytes(9).toString("base64url")}`;
		const scopeToken = newScopeToken();
		await scopes.record(scopeToken, { principal, command: req.command.slice(0, 64) });
		const env: Record<string, string | undefined> = { ...curatedEnv(), ...req.env, [SCOPE_ENV]: scopeToken };
		delete env[RUNTIME_ENV];
		let held: HeldTerminal;
		try {
			held = await this.holder.spawn({
				id,
				command: req.command,
				args: req.args ?? [],
				cwd: req.cwd,
				env,
				cols: req.cols ?? 80,
				rows: req.rows ?? 24,
			});
		} catch (error) {
			await scopes.release(scopeToken);
			throw error;
		}
		scopes.attach(scopeToken, held.pid);
		const handle = new LocalProcessHandle(
			{ id, scopeToken, principal, command: [req.command, ...(req.args ?? [])].join(" "), held },
			scopes,
			{ ...this.limits, ...limits },
		);
		this.handles.set(id, handle);
		return handle;
	}

	get(id: string): ProcessHandle | undefined {
		return this.handles.get(id);
	}

	list(principal?: string): readonly HandleInfo[] {
		return [...this.handles.values()]
			.filter((handle) => principal === undefined || handle.principal === principal)
			.map((handle) => handle.info());
	}
}
