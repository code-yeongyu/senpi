/**
 * The server's handle on one session's tool child (senpi#3566, plan todo 4).
 *
 * Every spawn is a new generation with its own channel, so a frame from an older generation can never settle a job of
 * a newer one. Each job settles exactly once: by its result, its error, or the child's exit, whichever comes first.
 * When the child dies every pending job of that generation fails with `tool_child_exited`; nothing is re-run here.
 */
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { openChannelListener, type ToolChildChannel } from "./channel.ts";
import {
	type ChildContainment,
	ChildContainmentError,
	type ContainmentHost,
	containChild,
} from "./child-containment.ts";
import { createGenerationBarrier, type GenerationBarrier } from "./client-barrier.ts";
import { generationLedgerPath } from "./descendants.ts";
import { TOOL_CHILD_PROTOCOL_VERSION } from "./entry.ts";
import { type HostCallHandler, type HostCallRefs, ServerHostCalls } from "./host-calls-server.ts";
import { policyFor } from "./job-policy.ts";
import { JobSupervisor, type SupervisorTimers } from "./job-supervisor.ts";
import { spawnToolChild, type ToolChildCommand, toolChildCommand } from "./launch.ts";
import { recordGenerationChild, sweepStaleGenerations } from "./orphan-sweep.ts";
import { PayloadRefReader, PayloadRefWriter } from "./payload-ref.ts";
import { unpackPayload } from "./payload-wire.ts";
import { TOOL_CHILD_LIMITS, type ToolChildMessage, type ToolChildMessageOf } from "./protocol.ts";

export type ToolChildState = "none" | "spawning" | "live" | "retiring" | "dead";

export interface ToolChildStatus {
	readonly state: "spawned" | "exited";
	readonly generation: number;
	readonly pid: number;
}

/** A child's `wake`: something happened on it outside any job's lifetime, for the job kind named by `source`. */
export interface ToolChildWake {
	readonly source: string;
	readonly value: unknown;
	readonly generation: number;
}

export class ToolChildError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
		this.name = "ToolChildError";
	}
}

export interface ToolChildClientOptions {
	readonly dir: string;
	readonly cwd: string;
	/** A function is read at every spawn, so each generation sees the current value. */
	readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
	readonly command?: ToolChildCommand;
	readonly readyMs?: number;
	readonly shutdownMs?: number;
	readonly onStatus?: (status: ToolChildStatus) => void;
	/** Tests inject a fake clock for the job supervisor. */
	readonly timers?: SupervisorTimers;
	/** Serves the child's reverse-bridge calls (tool, completion, reserved, list_tools); unset = every call fails. */
	readonly onHostCall?: HostCallHandler;
	/** Receives the child's wakes, in order; each is acknowledged once delivered. */
	readonly onWake?: (wake: ToolChildWake) => void;
	/** Observes the child's cancel acknowledgements (tests and status). */
	readonly onCancelAck?: (jobId: string) => void;
	/** Read for `SENPI_TOOL_CHILD_DEADLINE_<KIND>_MS` fixture overrides. */
	readonly policyEnv?: NodeJS.ProcessEnv;
	/** Tests inject the platform and kernel; production uses this host's. */
	readonly containmentHost?: ContainmentHost;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	/** Receives the job's streamed updates in order; absent when the caller does not stream. */
	readonly onUpdate?: (value: unknown) => void;
	/** Every update received so far, delivered and acknowledged in order; a result settles after it. */
	delivered: Promise<void>;
}

interface Live {
	readonly generation: number;
	readonly child: ChildProcess;
	readonly channel: ToolChildChannel;
	readonly exited: Promise<void>;
	readonly pending: Map<string, Pending>;
	readonly pongs: Map<number, () => void>;
	readonly barrier: GenerationBarrier;
	readonly supervisor: JobSupervisor;
	readonly hostCalls: ServerHostCalls;
	readonly refs: HostCallRefs;
	/** The child's manifest from its `hello`: the job kinds it runs. */
	readonly jobKinds: ReadonlySet<string>;
	readonly containment: ChildContainment;
	ended?: Promise<void>;
}

/**
 * Sends a job: inline at or below the reference threshold, otherwise by a server-written reference the child acks and
 * then owns. A job settled (cancelled) while its reference was written never reaches the child, and its reference is
 * released at once.
 */
function sendJob(live: Live, jobId: string, kind: string, args: unknown, failed: (error: unknown) => void): void {
	const json = args === undefined ? undefined : JSON.stringify(args);
	if (json === undefined || Buffer.byteLength(json, "utf8") <= TOOL_CHILD_LIMITS.REF_THRESHOLD) {
		live.channel.send({ type: "job", jobId, kind, args });
		return;
	}
	live.refs.writer.create(Buffer.from(json, "utf8")).then((ref) => {
		if (live.pending.has(jobId)) live.channel.send({ type: "job", jobId, kind, argsRef: ref });
		else void live.refs.writer.handle({ type: "ref_nack", refId: ref.refId, reason: "cancelled" });
	}, failed);
}

export class ToolChildClient {
	#state: ToolChildState = "none";
	#generation = 0;
	#nextJob = 0;
	readonly #hostContexts = new Map<string, unknown>();
	get #refsRoot(): string {
		return join(this.#options.dir, "refs");
	}
	#nextPing = 0;
	#live: Live | undefined;
	#lastEnded: Promise<void> = Promise.resolve();

	readonly #options: ToolChildClientOptions;

	constructor(options: ToolChildClientOptions) {
		this.#options = options;
	}

	get state(): ToolChildState {
		return this.#state;
	}

	get dir(): string {
		return this.#options.dir;
	}

	/** The live child's manifest (its `hello`'s job kinds); empty when no child is live. */
	get jobKinds(): readonly string[] {
		return [...(this.#live?.jobKinds ?? [])].sort();
	}

	get generation(): number {
		return this.#generation;
	}

	/** Resolves once the current or last generation's teardown (group sweep, ledger removal) finished. */
	ended(): Promise<void> {
		return this.#lastEnded;
	}

	get pid(): number | undefined {
		return this.#live?.child.pid;
	}

	async start(): Promise<void> {
		if (this.#state === "spawning" || this.#state === "live")
			throw new ToolChildError("tool_child_busy", `already ${this.#state}`);
		const generation = ++this.#generation;
		this.#state = "spawning";
		try {
			await this.#bootstrap(generation);
		} catch (error) {
			// Whatever failed (the listener, the spawn, the hello), the client never stays "spawning": the next job retries.
			if (this.#state === "spawning") this.#state = "dead";
			throw error instanceof ToolChildError
				? error
				: new ToolChildError(
						"tool_child_bootstrap_failed",
						`spawn_failed: ${error instanceof Error ? error.message : String(error)}`,
					);
		}
	}

	async #bootstrap(generation: number): Promise<void> {
		// A crashed predecessor (host or child) may have left owned groups and a ledger this generation would reuse.
		await this.#lastEnded;
		await sweepStaleGenerations(this.#options.dir);
		const listener = await openChannelListener({ dir: this.#options.dir, generation });
		const child = spawnToolChild({
			generation,
			channelEnv: listener.env,
			env: typeof this.#options.env === "function" ? this.#options.env() : (this.#options.env ?? process.env),
			command: this.#options.command ?? (await toolChildCommand()),
			cwd: this.#options.cwd,
			refsRoot: this.#refsRoot,
			ledgerPath: generationLedgerPath(this.#options.dir, generation),
		});
		let spawnError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		// A spawn that fails (ENOENT, a missing cwd) emits "error" instead of "exit": both end the child.
		const exited = Promise.race([once(child, "exit"), once(child, "error")]).then(
			() => undefined,
			() => undefined,
		);
		let containment: ChildContainment;
		try {
			containment = containChild(child, this.#options.containmentHost);
		} catch (error) {
			// A spawn that failed has no pid and no process to stop. Node 26 turns `kill()` on such a child into a
			// signal to the caller's own process group, so it is only sent to a child that really started.
			if (child.pid !== undefined) child.kill("SIGKILL");
			await listener.close();
			throw error instanceof ChildContainmentError ? new ToolChildError(error.code, error.message) : error;
		}
		// Marks this generation live while its child runs: another start on the same session never sweeps it.
		if (child.pid !== undefined) await recordGenerationChild(this.#options.dir, generation, child.pid);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.#options.readyMs ?? 10_000);
		});
		const hello = listener.accepted.then((channel) =>
			firstMessage(channel).then((message) => ({ channel, message })),
		);
		const outcome = await Promise.race([hello, exited.then(() => "exited" as const), timedOut]);
		clearTimeout(timer);
		await listener.close();
		if (outcome === "timeout" || outcome === "exited") {
			containment.kill();
			containment.close();
			this.#state = "dead";
			throw new ToolChildError(
				"tool_child_bootstrap_failed",
				outcome === "timeout"
					? "ready_timeout"
					: spawnError
						? `spawn_failed: ${spawnError.message}`
						: "exited_before_ready",
			);
		}
		const { channel, message } = outcome;
		if (
			message.type !== "hello" ||
			message.generation !== generation ||
			message.protocol !== TOOL_CHILD_PROTOCOL_VERSION
		) {
			containment.kill();
			containment.close();
			this.#state = "dead";
			throw new ToolChildError("tool_child_bootstrap_failed", "version_mismatch");
		}
		const pending = new Map<string, Pending>();
		const barrier = createGenerationBarrier({
			dir: this.#options.dir,
			generation,
			channel,
			...(containment.isMember === undefined ? {} : { confirmMember: containment.isMember }),
			onViolation: (violation) => {
				const failure = new ToolChildError(violation.code, `${violation.launchId}: ${violation.reason}`);
				if (violation.jobId !== undefined) settle({ pending }, violation.jobId, (p) => p.reject(failure));
				containment.kill();
			},
		});
		const supervisor = new JobSupervisor(
			{
				sendCancel: (jobId) => channel.send({ type: "cancel", jobId }),
				sendPing: (seq) => channel.send({ type: "ping", seq }),
				signal: (signal) => {
					// Windows has no graceful group signal: the Job Object is the only tree-wide stop.
					if (signal === "SIGKILL" || process.platform === "win32") containment.kill();
					else if (child.pid !== undefined) {
						try {
							process.kill(-child.pid, "SIGTERM");
						} catch {
							// The child's group is already gone.
						}
					}
				},
			},
			this.#options.timers,
		);
		const onHostCall = this.#options.onHostCall;
		const refs: HostCallRefs = {
			writer: new PayloadRefWriter({ root: this.#refsRoot, generation }),
			reader: new PayloadRefReader({ root: this.#refsRoot, generation, send: (control) => channel.send(control) }),
		};
		const hostCalls = new ServerHostCalls(
			channel,
			onHostCall ??
				((request) => Promise.reject(new Error(`no host-call handler for ${request.name ?? request.kind}`))),
			(jobId) => this.#hostContexts.get(jobId),
			refs,
			{ exited, jobLive: (jobId) => pending.has(jobId) },
		);
		const live: Live = {
			generation,
			child,
			channel,
			exited,
			pending,
			pongs: new Map(),
			barrier,
			supervisor,
			hostCalls,
			refs,
			jobKinds: new Set(message.jobKinds),
			containment,
		};
		this.#live = live;
		this.#state = "live";
		channel.onMessage((frame) => this.#onFrame(live, frame));
		void exited.then(() => this.#onExit(live));
		this.#options.onStatus?.({ state: "spawned", generation, pid: child.pid ?? -1 });
	}

	run(
		kind: string,
		args: unknown,
		signal?: AbortSignal,
		options: {
			readonly idempotent?: boolean;
			readonly deadlineMs?: number;
			readonly hostContext?: unknown;
			readonly onUpdate?: (value: unknown) => void;
		} = {},
	): Promise<unknown> {
		const live = this.#live;
		if (this.#state !== "live" || live === undefined)
			return Promise.reject(new ToolChildError("tool_child_unavailable", this.#state));
		if (!live.jobKinds.has(kind))
			return Promise.reject(
				new ToolChildError(
					"tool_child_unknown_kind",
					`the child runs [${[...live.jobKinds].join(", ")}], not ${kind}`,
				),
			);
		const jobId = `j${++this.#nextJob}`;
		if (signal?.aborted === true)
			return Promise.reject(new ToolChildError("tool_child_cancelled", "cancelled before it started"));
		if (options.hostContext !== undefined) this.#hostContexts.set(jobId, options.hostContext);
		const policy = policyFor(kind, { ...options, env: this.#options.policyEnv ?? process.env });
		return new Promise((resolve, reject) => {
			const done = (finish: () => void) => () => {
				live.supervisor.settle(jobId);
				live.hostCalls.endJob(jobId);
				this.#hostContexts.delete(jobId);
				finish();
			};
			live.pending.set(jobId, {
				resolve: (value) => done(() => resolve(value))(),
				reject: (error) => done(() => reject(error))(),
				...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
				delivered: Promise.resolve(),
			});
			live.supervisor.track(jobId, {
				reject: (error) => settle(live, jobId, (pending) => pending.reject(error)),
				backstopMs: policy.backstopMs(args),
				userText: policy.userText,
				...(signal === undefined ? {} : { signal }),
			});
			sendJob(live, jobId, kind, args, (error) =>
				settle(live, jobId, (pending) =>
					pending.reject(
						new ToolChildError(
							"tool_child_args_unwritable",
							error instanceof Error ? error.message : String(error),
						),
					),
				),
			);
		});
	}

	ping(): Promise<number> {
		const live = this.#live;
		if (live === undefined) return Promise.reject(new ToolChildError("tool_child_unavailable", this.#state));
		const seq = ++this.#nextPing;
		return new Promise((resolve) => {
			live.pongs.set(seq, () => resolve(seq));
			live.channel.send({ type: "ping", seq });
		});
	}

	async close(): Promise<void> {
		const live = this.#live;
		// A child that already died may still be tearing down (ledger, launch log): close() means all of it is finished.
		if (live === undefined) {
			await this.#lastEnded;
			return;
		}
		this.#state = "retiring";
		live.channel.send({ type: "shutdown" });
		const graceful = await Promise.race([
			live.exited.then(() => true),
			delay(this.#options.shutdownMs ?? 2_000).then(() => false),
		]);
		if (!graceful) live.containment.kill();
		await live.exited;
		await live.ended;
	}

	#onFrame(live: Live, frame: ToolChildMessage): void {
		if (this.#live !== live) return;
		if (live.barrier.handle(frame)) return;
		if (live.hostCalls.handle(frame)) return;
		if (frame.type === "ref_ack" || frame.type === "ref_nack") {
			void live.refs.writer.handle(frame);
			return;
		}
		switch (frame.type) {
			case "update":
				this.#onUpdate(live, frame);
				return;
			case "result":
				afterUpdates(live, frame.jobId, () => settle(live, frame.jobId, (p) => p.resolve(frame.value)));
				return;
			case "job_error":
			case "job_refused":
				afterUpdates(live, frame.jobId, () =>
					settle(live, frame.jobId, (p) =>
						p.reject(new ToolChildError(frame.code, frame.type === "job_error" ? frame.message : "refused")),
					),
				);
				return;
			case "wake":
				try {
					this.#options.onWake?.({ source: frame.source, value: frame.value, generation: live.generation });
				} finally {
					live.channel.send({ type: "wake_ack", wakeId: frame.wakeId });
				}
				return;
			case "cancel_ack":
				live.supervisor.cancelAcked(frame.jobId);
				this.#options.onCancelAck?.(frame.jobId);
				return;
			case "pong": {
				live.supervisor.pongReceived();
				const done = live.pongs.get(frame.seq);
				live.pongs.delete(frame.seq);
				done?.();
				return;
			}
			default:
				return;
		}
	}

	/** Delivers one update after the job's earlier ones (reading a ref first), then returns its credit. */
	#onUpdate(live: Live, frame: ToolChildMessageOf<"update">): void {
		const pending = live.pending.get(frame.jobId);
		if (pending === undefined) {
			if (frame.valueRef !== undefined) live.refs.reader.refuse(frame.valueRef, "cancelled");
			return;
		}
		const read = (): Promise<unknown> =>
			frame.valueRef === undefined ? Promise.resolve(frame.value) : unpackPayload(frame.valueRef, live.refs.reader);
		pending.delivered = pending.delivered.then(async () => {
			try {
				const value = await read();
				pending.onUpdate?.(value);
			} finally {
				live.channel.send({ type: "update_ack", jobId: frame.jobId, seq: frame.seq });
			}
		});
	}

	#onExit(live: Live): void {
		live.supervisor.end();
		const failure = new ToolChildError("tool_child_exited", `generation ${live.generation} exited`);
		for (const [jobId, pending] of live.pending) {
			live.pending.delete(jobId);
			pending.reject(failure);
		}
		live.channel.close();
		live.containment.kill();
		if (this.#live === live) {
			this.#live = undefined;
			this.#state = "dead";
		}
		this.#options.onStatus?.({ state: "exited", generation: live.generation, pid: live.child.pid ?? -1 });
		// The containment is closed on every exit, a failed teardown included.
		live.ended = Promise.all([live.barrier.teardown(undefined), live.refs.writer.teardown()])
			.finally(() => live.containment.close())
			.then(() => undefined);
		this.#lastEnded = live.ended;
	}
}

/** Runs `then` once every update the job sent before it has been delivered (at once when there is none). */
function afterUpdates(live: Pick<Live, "pending">, jobId: string, then: () => void): void {
	const pending = live.pending.get(jobId);
	if (pending === undefined) return;
	void pending.delivered.then(then, then);
}

function settle(live: Pick<Live, "pending">, jobId: string, apply: (pending: Pending) => void): void {
	const pending = live.pending.get(jobId);
	if (pending === undefined) return;
	live.pending.delete(jobId);
	apply(pending);
}

/** The channel's first frame; the subscription ends with it (frames after it belong to the live client's handler). */
function firstMessage(channel: ToolChildChannel): Promise<ToolChildMessage> {
	return new Promise((resolve) => {
		let done = false;
		// oxlint-disable-next-line eslint/prefer-const -- a closure reads it; const would throw in the TDZ if that closure ran before the assignment, so the rewrite is reviewed separately
		let unsubscribe: (() => void) | undefined;
		unsubscribe = channel.onMessage((message) => {
			if (done) return;
			done = true;
			resolve(message);
			unsubscribe?.();
		});
		// onMessage replays a queued frame synchronously, before it returned the unsubscribe function.
		if (done) unsubscribe();
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
