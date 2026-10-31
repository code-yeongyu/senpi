/**
 * The child half of the execution barrier (senpi#3566, plan todo 4). Every launch path asks the gate for a slot, which
 * sends `launch` with the containment handle; the server records it and acknowledges. The launch path then stores its
 * invoke tick immediately before the real call and calls `invoking`, and the gate publishes `launch_proof` from the
 * shared clock without waiting for the call to return. `done` reports completion separately, with no deadline.
 */
import { BarrierClock, type SlotState } from "./barrier-clock.ts";

const FINISHED_SLOT_STATES = 256;

import type { ToolChildChannel } from "./channel.ts";
import type { LaunchApi, LaunchContainment, LaunchLifetime, LaunchOrigin, ToolChildMessage } from "./protocol.ts";
import { readTestControls, type TestControls } from "./test-controls.ts";
import { currentProcessInJob } from "./windows-job.ts";
import type { WorkerLaunchMessage } from "./worker-launch.ts";

export interface LaunchRequest {
	readonly jobId: string;
	readonly origin: LaunchOrigin;
	readonly api: LaunchApi;
	readonly containment: LaunchContainment;
	readonly lifetime: LaunchLifetime;
	readonly pid?: number;
	readonly pgid?: number;
}

export interface GatedLaunch {
	readonly launchId: string;
	readonly slot: number;
	/** Resolves when the server's `launch_ack` has been recorded on the shared clock. */
	readonly acked: Promise<void>;
}

export class LaunchGateError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "LaunchGateError";
		this.code = code;
	}
}

export class LaunchGate {
	readonly clock: BarrierClock;
	readonly #channel: ToolChildChannel;
	readonly #slots = new Map<
		string,
		{ slot: number; ack: () => void; lifetime: LaunchLifetime; request: LaunchRequest }
	>();
	/** Final slot state of recent finished launches, so a test query after `launch_done` still reads the counts. */
	readonly #finished = new Map<string, SlotState>();
	readonly #controls: TestControls;
	#next = 0;

	constructor(
		channel: ToolChildChannel,
		clock: BarrierClock = BarrierClock.create(),
		env: NodeJS.ProcessEnv = process.env,
		creatorInJob: () => boolean = currentProcessInJob,
	) {
		this.#channel = channel;
		this.clock = clock;
		this.#controls = readTestControls(env);
		this.#creatorInJob = creatorInJob;
	}

	readonly #creatorInJob: () => boolean;

	/** Windows: the command a launch started, with whether its creator (this child) was inside a job when it did. */
	started(launchId: string, pid: number, breakaway = false): void {
		if (!this.#slots.has(launchId)) return;
		this.#channel.send({
			type: "command_started",
			launchId,
			pid,
			startedAtMs: Date.now(),
			creatorInJob: this.#creatorInJob(),
			breakaway,
		});
	}

	/** Test-only `SKIP_ACK_WAIT` mutation: launch paths invoke without awaiting the ack. */
	get skipsAckWait(): boolean {
		return this.#controls.enabled("SKIP_ACK_WAIT");
	}

	request(request: LaunchRequest): GatedLaunch {
		const slot = this.clock.claimSlot();
		if (slot === undefined)
			throw new LaunchGateError("tool_child_launch_capacity", `${this.clock.slots} launches in flight`);
		const launchId = `L${process.pid}-${++this.#next}`;
		let ack!: () => void;
		const acked = new Promise<void>((resolve) => {
			ack = resolve;
		});
		this.#slots.set(launchId, { slot, ack, lifetime: request.lifetime, request });
		this.#channel.send({ type: "launch", launchId, ...request });
		if (this.#controls.enabled("STOP_AFTER_SPAWN")) process.kill(process.pid, "SIGSTOP");
		return { launchId, slot, acked };
	}

	/** Protocol loop: a launch a worker announced on a slot it claimed itself on the shared clock. */
	adopt(launchId: string, slot: number, request: LaunchRequest): void {
		this.#slots.set(launchId, { slot, ack: () => undefined, lifetime: request.lifetime, request });
		this.#channel.send({ type: "launch", launchId, ...request });
	}

	handleWorker(message: WorkerLaunchMessage): void {
		if (message.kind === "launch") this.adopt(message.launchId, message.slot, message.request);
		else if (message.kind === "invoking") this.invoking(message.launchId);
		else if (message.kind === "started") this.started(message.launchId, message.pid, message.breakaway);
		else
			this.done(message.launchId, {
				...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
				...(message.signal === undefined ? {} : { signal: message.signal }),
			});
	}

	/** Protocol loop: a frame the gate owns. Returns false for frames it does not handle. */
	handle(message: ToolChildMessage): boolean {
		if (message.type === "launch_ack") {
			const entry = this.#slots.get(message.launchId);
			if (entry !== undefined) {
				this.clock.recordAck(entry.slot);
				entry.ack();
			}
			return true;
		}
		if (message.type === "slot_query") {
			const entry = this.#slots.get(message.launchId);
			const state =
				entry === undefined
					? (this.#finished.get(message.launchId) ?? { ackTick: null, invokeTick: null, invocations: 0 })
					: this.clock.read(entry.slot);
			this.#channel.send({ type: "slot_state", launchId: message.launchId, ...state });
			return true;
		}
		return false;
	}

	/** Main-thread launch path: records the invoke tick and publishes the proof. Call immediately before the real call. */
	invokeNow(launchId: string): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) throw new LaunchGateError("tool_child_launch_unknown", launchId);
		this.clock.recordInvoke(entry.slot);
		this.invoking(launchId);
	}

	/** Protocol loop: a launch path (any thread) has stored its invoke tick; publish the proof from the clock. */
	invoking(launchId: string): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) return;
		const state = this.clock.read(entry.slot);
		const invokeTick = state.invokeTick;
		if (invokeTick === null) return;
		const send = () => this.#channel.send({ type: "launch_proof", launchId, ackTick: state.ackTick, invokeTick });
		const hold = this.#controls.value("HOLD_LAUNCH_PROOF");
		if (hold !== undefined && (hold !== "detached" || entry.lifetime === "detached")) {
			void this.#controls.released(`release-proof-${launchId}`).then(send);
			return;
		}
		send();
	}

	/**
	 * Ends the owned own-group commands a cancelled job started that are still running (no `launch_done` yet). Their
	 * leaders are this process's unreaped children, so each pgid is still the group this job created - never a reused
	 * one. Detached launches outlive their job by contract and are left alone. Returns the groups signalled.
	 */
	endJobGroups(jobId: string): number[] {
		const ended: Array<{ readonly launchId: string; readonly pgid: number }> = [];
		for (const [launchId, { request }] of this.#slots) {
			if (request.jobId !== jobId || request.lifetime !== "owned" || request.containment !== "own-group") continue;
			if (request.pgid === undefined || request.pgid <= 1) continue;
			try {
				process.kill(-request.pgid, "SIGKILL");
				ended.push({ launchId, pgid: request.pgid });
			} catch {
				// The group ended between its last member and our signal.
			}
		}
		// The worker that would have reported these launches' completion is gone with its job: report it here, so the
		// slots return to the clock and the server's log is complete.
		for (const { launchId } of ended) this.done(launchId, { signal: "SIGKILL" });
		return ended.map(({ pgid }) => pgid);
	}

	done(launchId: string, outcome: { readonly exitCode?: number; readonly signal?: string }): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) return;
		this.#slots.delete(launchId);
		this.#finished.set(launchId, this.clock.read(entry.slot));
		if (this.#finished.size > FINISHED_SLOT_STATES) this.#finished.delete(this.#finished.keys().next().value ?? "");
		this.clock.releaseSlot(entry.slot);
		this.#channel.send({
			type: "launch_done",
			launchId,
			...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
		});
	}
}
