/**
 * The host-level `machine_op` handler (senpi#6752): one per RPC host, created with it and disposed at its shutdown. It
 * owns the machine-ops instance (the engine's state dir: `<agentDir>/machine`, which holds the mesh inbox and scope
 * tokens), the engine-owned terminals, the op_id answer cache, and each running op's abort (its deadline,
 * `machine_op_cancel`, host shutdown). Only `delegated-connection.ts` decides who may reach it.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	createLocalMachineOps,
	DEFAULT_LIMITS,
	type HolderLink,
	MachineOpError,
	type MachineOps,
} from "@code-yeongyu/senpi-machine-ops";
import { VERSION } from "../../../config.ts";
import type { DelegationResponse } from "../delegation-wire.ts";
import { MachineOpAnswerCache } from "./answer-cache.ts";
import { runMachineOp } from "./executor.ts";
import type { After } from "./live-handle.ts";
import { MachineTerminals } from "./machine-terminals.ts";
import { createTerminalOps } from "./terminal-ops.ts";
import {
	type Args,
	isArgs,
	type MachineOpCommand,
	machineOpAnswer,
	machineOpConflict,
	machineOpMalformed,
	type MachineOpRequest,
	machineOpUnavailable,
	nonEmptyText,
	parseOwnedOpLookup,
	type OpOutcome,
	parseMachineOp,
} from "./wire.ts";

/**
 * The relay host's read cap (its RELAYD_READ_MAX_BYTES): the session blob cap minus a stored result's own cost around
 * the bytes, so a read the relay host can carry is one the engine answers.
 */
const RELAY_HOST_READ_MAX_BYTES = 16_772_963;

// machine-ops' own PTY spawn is not offered: terminals run on the engine's terminal manager (`machine-terminals.ts`).
const NO_PTY_HOLDER: HolderLink = {
	spawn: () => Promise.reject(new MachineOpError("invalid_argument", "terminal spawn is not offered by this host")),
	close: async () => {},
};
const after: After = (ms, fn) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};

export class MachineOpHandler {
	private readonly stateDir: string;
	private readonly terminals = new MachineTerminals(after);
	private readonly terminalOps = createTerminalOps(this.terminals, after);
	private readonly cache = new MachineOpAnswerCache<OpOutcome>();
	private readonly stopping = new AbortController();
	private readonly running = new Map<string, Readonly<{ abort: AbortController; sender: string }>>();
	private ops: Promise<MachineOps> | undefined;
	private held = false;

	constructor(options: { readonly agentDir: string }) {
		this.stateDir = options.agentDir;
	}

	async answer(command: MachineOpCommand, record: unknown, id: string | undefined): Promise<DelegationResponse> {
		const fields: Args = isArgs(record) ? record : {};
		switch (command) {
			case "machine_op": {
				const request = parseMachineOp(fields);
				if (typeof request === "string") return machineOpMalformed(id, command, request);
				if (this.held) return machineOpUnavailable(id, "the engine is handing over or shutting down; retry the op");
				const owner = this.cache.ownerOf(request.opId);
				if (owner !== undefined && owner !== request.sender) return machineOpConflict(id, command);
				try {
					const outcome = await this.cache.answer(request.opId, request.sender, () => this.run(request));
					return machineOpAnswer(id, command, outcome);
				} catch (cause) {
					// Review L3: the op never started (the machine state dir could not be made); nothing is cached.
					const detail = cause instanceof Error ? cause.message : String(cause);
					return machineOpUnavailable(id, `the engine's machine state could not be prepared: ${detail}`);
				}
			}
			case "machine_op_cancel": {
				const lookup = parseOwnedOpLookup(fields);
				if (typeof lookup === "string") return machineOpMalformed(id, command, lookup);
				const running = this.running.get(lookup.opId);
				if (running !== undefined && running.sender !== lookup.sender && !lookup.crossOwner)
					return machineOpConflict(id, command);
				const cancelled = running !== undefined && !running.abort.signal.aborted;
				running?.abort.abort();
				return machineOpAnswer(id, command, { cancelled });
			}
			case "machine_op_result": {
				const lookup = parseOwnedOpLookup(fields);
				if (typeof lookup === "string") return machineOpMalformed(id, command, lookup);
				const owner = this.cache.ownerOf(lookup.opId);
				if (owner !== undefined && owner !== lookup.sender && !lookup.crossOwner)
					return machineOpConflict(id, command);
				const outcome = this.cache.settled(lookup.opId);
				return machineOpAnswer(id, command, outcome === undefined ? { known: false } : { known: true, outcome });
			}
			case "machine_op_owner": {
				const handleId = nonEmptyText(fields, "handle_id");
				if (handleId === undefined) return machineOpMalformed(id, command, "handle_id must be a non-empty string");
				const sender = this.terminals.ownerOf(handleId);
				return machineOpAnswer(id, command, sender === undefined ? {} : { sender });
			}
			case "machine_op_health":
				return machineOpAnswer(id, command, {
					ok: true,
					terminals: this.terminals.running,
					cache: this.cache.size,
					version: VERSION,
				});
		}
	}

	/** Review M3: an op in flight or a live terminal keeps the host from being idle (no idle handover, no empty exit). */
	busy(): boolean {
		return this.running.size > 0 || this.terminals.running > 0;
	}

	/**
	 * The host is ending (a handover switching, an empty exit): from now on a new `machine_op` is refused
	 * `machine_op_unavailable` and runs nothing. Called in the same step as the idle decision, so nothing starts between.
	 */
	hold(): void {
		this.held = true;
	}

	/** A blocked handover: this host keeps serving machine ops. */
	release(): void {
		this.held = false;
	}

	async dispose(): Promise<void> {
		this.stopping.abort();
		await this.terminals.dispose();
	}

	// Registered before the first await, so a cancel read right behind the op on the same connection finds it.
	private async run(request: MachineOpRequest): Promise<OpOutcome> {
		const cancel = new AbortController();
		this.running.set(request.opId, { abort: cancel, sender: request.sender });
		const deadline =
			request.deadlineMs === undefined ? [] : [AbortSignal.timeout(Math.max(0, request.deadlineMs - Date.now()))];
		try {
			return await runMachineOp(request, AbortSignal.any([this.stopping.signal, cancel.signal, ...deadline]), {
				ops: await this.machineOps(),
				terminal: this.terminalOps,
				pidOf: (handleId) => this.terminals.pidOf(handleId),
				ownerOf: (handleId) => this.terminals.ownerOf(handleId),
			});
		} finally {
			this.running.delete(request.opId);
		}
	}

	private machineOps(): Promise<MachineOps> {
		// A failed preparation is never kept: the next op tries again (review L3).
		this.ops ??= mkdir(join(this.stateDir, "machine"), { recursive: true, mode: 0o700 }).then(
			() =>
				createLocalMachineOps({
					stateDir: this.stateDir,
					holder: NO_PTY_HOLDER,
					limits: { ...DEFAULT_LIMITS, readMaxBytes: RELAY_HOST_READ_MAX_BYTES },
				}),
			(cause: unknown) => {
				this.ops = undefined;
				throw cause;
			},
		);
		return this.ops;
	}
}
