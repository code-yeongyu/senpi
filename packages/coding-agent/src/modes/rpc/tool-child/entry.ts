/**
 * The tool child's main loop (senpi#3566, plan todo 4). It reaches its server only through the private channel, runs
 * each `job` frame through the handler registered for its kind, and exits when the server goes away (parent-watch),
 * so a child can never outlive the session that owns it. It loads no session, provider, extension or MCP scope: the
 * server is the single writer of every session file.
 */
import { connectChannel, type ToolChildChannel } from "./channel.ts";
import { ToolChildJobError } from "./entry-error.ts";
import { WakeAdmission } from "./flow-control.ts";
import { ChildHostCalls, type HostCallTarget } from "./host-calls-child.ts";
import { JobUpdates } from "./job-updates.ts";
import {
	rememberToolChildReentry,
	scrubToolChildEnv,
	TOOL_CHILD_LEDGER_ENV,
	TOOL_CHILD_REENTRY_ENV,
	TOOL_CHILD_REFS_ROOT_ENV,
} from "./launch-env-names.ts";
import { LaunchGate } from "./launch-gate.ts";
import { sweepLedger } from "./orphan-sweep.ts";
import { PayloadRefReader, PayloadRefWriter } from "./payload-ref.ts";
import { unpackPayload } from "./payload-wire.ts";
import type { PayloadRef, RefControl, ToolChildMessageOf } from "./protocol.ts";
import { readTestControls } from "./test-controls.ts";

export const TOOL_CHILD_GENERATION_ENV = "SENPI_TOOL_CHILD_GENERATION";
/** 2: `hello` carries the child's `jobKinds` manifest. */
export const TOOL_CHILD_PROTOCOL_VERSION = 2;

/** The signal of a host call that outlives its job's cancel. */
const NEVER_CANCELLED = new AbortController().signal;

export interface ToolChildJobContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly channel: ToolChildChannel;
	readonly gate: LaunchGate;
	/**
	 * A call to the server for this job (reverse bridge); settles with its reply, refusal or the job's cancel. A call made
	 * with `survivesCancel` is not settled by the cancel (a lock must be released after the job's writes stop, not when
	 * the cancel arrives); it still settles by its reply, its refusal or the channel closing.
	 */
	readonly hostCall: (target: HostCallTarget, options?: { readonly survivesCancel?: boolean }) => Promise<unknown>;
	/** Streams a partial result to the server in order; waits for credit when too many are unacknowledged. */
	readonly update: (value: unknown) => Promise<void>;
	/** This child's generation (the server's count of its spawns). */
	readonly generation: number;
	/**
	 * Tells the server something happened on this child outside any job's lifetime (a background session exited). The
	 * server hands it to the job definition whose kind is `source`. Never dropped: past the pending budget it waits.
	 */
	readonly wake: (source: string, value: unknown) => Promise<void>;
}

export type ToolChildJobHandler = (args: unknown, context: ToolChildJobContext) => Promise<unknown>;

export interface ToolChildEntryOptions {
	readonly handlers: Readonly<Record<string, ToolChildJobHandler>>;
	readonly env?: NodeJS.ProcessEnv;
	readonly exit?: (code: number) => never;
}

export { ToolChildJobError } from "./entry-error.ts";

export async function runToolChild(options: ToolChildEntryOptions): Promise<void> {
	const env = { ...(options.env ?? process.env) };
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const generation = Number(env[TOOL_CHILD_GENERATION_ENV]);
	if (!Number.isSafeInteger(generation) || generation < 0) {
		process.stderr.write("tool-child: invalid generation\n");
		exit(70);
	}
	const channel = await connectChannel(env);
	const controls = readTestControls(env);
	if (controls.enabled("EXIT_ON_START")) exit(1);
	// Read once; from here no command this child starts may see them (only node:child_process honours a deleted key, so
	// the gated Bun.spawn passes process.env explicitly).
	rememberToolChildReentry(env[TOOL_CHILD_REENTRY_ENV]);
	if (options.env === undefined) scrubToolChildEnv(process.env);
	const running = new Map<string, AbortController>();
	const streams = new Map<string, JobUpdates>();
	const gate = new LaunchGate(channel);
	const refsRoot = env[TOOL_CHILD_REFS_ROOT_ENV];
	const refs =
		refsRoot === undefined
			? undefined
			: {
					writer: new PayloadRefWriter({ root: refsRoot, generation }),
					reader: new PayloadRefReader({
						root: refsRoot,
						generation,
						send: (control: RefControl) => channel.send(control),
					}),
				};
	const hostCalls = new ChildHostCalls(channel, refs);
	const wakes = new WakeAdmission();
	let wakeSeq = 0;
	const wake = async (source: string, value: unknown): Promise<void> => {
		const wakeId = `w${++wakeSeq}`;
		const bytes = Buffer.byteLength(JSON.stringify(value ?? null));
		await wakes.send(wakeId, bytes);
		channel.send({ type: "wake", wakeId, source, bytes, value });
	};
	const session = { generation, wake };
	let readerBlocked = false;
	let shutdownRequested = false;
	channel.onMessage((message) => {
		if (controls.enabled("BLOCK_READER") && !readerBlocked) {
			readerBlocked = true;
			// Test-only: the protocol loop stops reading for 30 s, so pings go unanswered.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
		}
		if (gate.handle(message)) return;
		if (hostCalls.handle(message)) return;
		if (message.type === "ref_ack" || message.type === "ref_nack") {
			void refs?.writer.handle(message);
			return;
		}
		switch (message.type) {
			case "ping":
				channel.send({ type: "pong", seq: message.seq });
				return;
			case "job":
				if (controls.value("EXIT_MID_JOB") === message.kind) exit(1);
				void runJob(channel, gate, hostCalls, refs, options.handlers, running, streams, message, session);
				return;
			case "wake_ack":
				wakes.ack(message.wakeId);
				return;
			case "update_ack":
				streams.get(message.jobId)?.acked(message.seq);
				return;
			case "cancel":
				if (controls.enabled("IGNORE_CANCEL")) return;
				running.get(message.jobId)?.abort();
				channel.send({ type: "cancel_ack", jobId: message.jobId });
				return;
			case "shutdown":
				shutdownRequested = true;
				channel.close();
				return;
			default:
				return;
		}
	});
	if (!controls.enabled("HANG_BEFORE_READY"))
		channel.send({
			type: "hello",
			generation,
			pid: process.pid,
			protocol: TOOL_CHILD_PROTOCOL_VERSION,
			jobKinds: Object.keys(options.handlers).sort(),
		});
	if (controls.enabled("STOP_SELF")) process.kill(process.pid, "SIGSTOP");
	await channel.closed;
	hostCalls.close();
	for (const controller of running.values()) controller.abort();
	if (!shutdownRequested) await orphanedByHost(env);
	exit(0);
}

function readJobArgs(ref: PayloadRef, reader: PayloadRefReader | undefined, signal: AbortSignal): Promise<unknown> {
	if (reader === undefined)
		return Promise.reject(
			new ToolChildJobError(
				"tool_child_refs_unavailable",
				"a job sent its arguments by reference, but this child reads no references",
			),
		);
	return unpackPayload(ref, reader, signal);
}

async function runJob(
	channel: ToolChildChannel,
	gate: LaunchGate,
	hostCalls: ChildHostCalls,
	refs: { readonly reader: PayloadRefReader; readonly writer: PayloadRefWriter } | undefined,
	handlers: Readonly<Record<string, ToolChildJobHandler>>,
	running: Map<string, AbortController>,
	streams: Map<string, JobUpdates>,
	job: ToolChildMessageOf<"job">,
	session: Pick<ToolChildJobContext, "generation" | "wake">,
): Promise<void> {
	const refReader = refs?.reader;
	const handler = handlers[job.kind];
	if ((handler === undefined || running.has(job.jobId)) && job.argsRef !== undefined)
		refReader?.refuse(job.argsRef, "cancelled");
	if (handler === undefined) {
		channel.send({
			type: "job_error",
			jobId: job.jobId,
			code: "tool_child_unknown_kind",
			message: `no handler for ${job.kind}`,
		});
		return;
	}
	if (running.has(job.jobId)) {
		channel.send({ type: "job_refused", jobId: job.jobId, code: "tool_child_duplicate_job" });
		return;
	}
	const controller = new AbortController();
	running.set(job.jobId, controller);
	try {
		const hostCall = (target: HostCallTarget, options?: { readonly survivesCancel?: boolean }) =>
			hostCalls.call(job.jobId, target, options?.survivesCancel === true ? NEVER_CANCELLED : controller.signal);
		// Large arguments arrive by a server-written reference: acked (now this child's), consumed, deleted.
		const args = job.argsRef === undefined ? job.args : await readJobArgs(job.argsRef, refReader, controller.signal);
		const stream = new JobUpdates({
			jobId: job.jobId,
			channel,
			...(refs === undefined ? {} : { writer: refs.writer }),
		});
		streams.set(job.jobId, stream);
		const update = (value: unknown) => stream.update(value);
		const value = await handler(args, {
			jobId: job.jobId,
			signal: controller.signal,
			channel,
			gate,
			hostCall,
			update,
			generation: session.generation,
			wake: session.wake,
		});
		channel.send({ type: "result", jobId: job.jobId, value: value ?? null });
	} catch (error) {
		const code =
			error instanceof ToolChildJobError
				? error.code
				: controller.signal.aborted
					? "tool_child_cancelled"
					: "tool_child_job_failed";
		channel.send({
			type: "job_error",
			jobId: job.jobId,
			code,
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		running.delete(job.jobId);
		streams.get(job.jobId)?.end();
		streams.delete(job.jobId);
	}
}

/**
 * The host is gone without asking this child to stop (a crash, SIGKILL, an exit that never closed the session): nobody
 * is left to sweep. Sweep the owned groups the ledger names, then end this child's own group - the inherited commands
 * share it - with this process in it.
 */
async function orphanedByHost(env: NodeJS.ProcessEnv): Promise<void> {
	const ledger = env[TOOL_CHILD_LEDGER_ENV];
	if (ledger !== undefined) await sweepLedger(ledger).catch(() => []);
	if (process.platform === "win32") return;
	try {
		process.kill(-process.pid, "SIGKILL");
	} catch {
		// Not a group leader (a test harness started this entry in-process): nothing more to end.
	}
}
