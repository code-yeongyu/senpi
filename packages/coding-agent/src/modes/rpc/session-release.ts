/**
 * `release_session`: a host hands one of its sessions to a runtime outside it - `omo daemon adopt`
 * resumes it in a local terminal with `senpi --session <session_path>`.
 *
 * The hand-over is a teardown, not a transfer: nothing is replayed, the runtime is disposed and the
 * path reservation is released (the in-process one and the cross-generation claim), so the next
 * process to write the file is the one the caller starts. Before that the transcript gains one
 * `session_released` entry - a `custom` bookkeeping entry the model never sees - so the file itself
 * records which host let go of it and when. Clients still attached (only with `force`) receive
 * `session_closed { reason: "released" }`, which tells them NOT to reopen the path here.
 *
 * A session is released only when it is QUIET: no agent run, no prompt still in preflight, no queued user
 * input, no admitted delivery waiting to be written, no bash, compaction or barrier-held session work (the fields the
 * handoff park judges by), and no other request for the session in flight on any connection. Anything
 * else would write the file after the new writer took it. Busy is refused with nothing changed -
 * `turn_active` when a turn is running or about to start, `session_busy` for other work, both naming
 * the signals in `errorData.busy` - unless `interrupt` is set: then the run and any bash are aborted,
 * the release waits (bounded) for the run to go idle and for the other requests and prompts to
 * settle, and checks again. The last check and the close claim run in one synchronous step, so a
 * command routed after it finds the session closing, and work started before it is seen by it.
 * Also refused while clients are attached (`attached`, unless `force`) and for a session this host
 * cannot hand over (`release_unsupported`: a worker isolate owns the runtime, or there is no file).
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import {
	RPC_ERROR_ATTACHED,
	RPC_ERROR_HOST_DRAINING,
	RPC_ERROR_INVALID_RELEASE_REASON,
	RPC_ERROR_RELEASE_FAILED,
	RPC_ERROR_RELEASE_UNSUPPORTED,
	RPC_ERROR_SESSION_BUSY,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_TURN_ACTIVE,
	type RpcCommand,
	type RpcResponse,
} from "./rpc-types.ts";
import type { RpcSessionEntry } from "./session-registry.ts";
import {
	abortAndSettle,
	NOTHING_DROPPED,
	type ReleaseDropped,
	type ReleaseSettlePort,
	takeQueuedInput,
} from "./session-release-interrupt.ts";

/** `customType` of the transcript entry a release appends. */
export const SESSION_RELEASED_ENTRY_TYPE = "session_released";

export type ReleaseSessionCommand = Extract<RpcCommand, { type: "release_session" }>;

/** What `pi.session.admitExternalMessage` throws once a release has closed admission. */
export const RELEASED_ADMISSION_CLOSED =
	"release_session handed this session to another runtime; deliver there instead (admission is closed here)";

/** `errorData.hint` of a refusal whose `busy` names `queued`: only an interrupt hands that input back. */
export const RELEASE_QUEUED_HINT =
	"queued user input is still owed a turn; release with interrupt: true to take it out and receive it in dropped.user_messages";

export type ReleaseBusySignal =
	| "turn"
	| "prompt"
	| "queued"
	| "delivery"
	| "bash"
	| "compaction"
	| "session_work"
	| "activity"
	| "request";

/** What the router lends a release: its lookup, its request accounting, and the park teardown. */
export interface SessionReleasePort extends ReleaseSettlePort {
	readonly draining: () => boolean;
	readonly hostInstance: string | undefined;
	/** The live entry, or a throw carrying the wire code (`unknown_session`, `session_closing`). */
	lookup(sessionId: string): RpcSessionEntry;
	code(cause: unknown): string;
	/** Requests for the session in flight on any connection, the release itself not counted. */
	otherRequests(sessionId: string): number;
	/**
	 * Claims every attachment and tears the session down, sealing it as released. Its claim is taken
	 * before its first await. `false` when another close already owns the entry.
	 */
	tearDown(sessionId: string, sessionPath: string): Promise<boolean>;
}

interface Releasable {
	readonly session: AgentSession;
	readonly sessionPath: string;
	readonly attachments: number;
}

export async function releaseSession(port: SessionReleasePort, command: ReleaseSessionCommand): Promise<RpcResponse> {
	if (command.reason !== "takeover") return refusal(command.id, RPC_ERROR_INVALID_RELEASE_REASON);
	if (port.draining()) return refusal(command.id, RPC_ERROR_HOST_DRAINING);
	const first = releasable(port, command, undefined);
	if (!("session" in first)) return first;
	const busy = busySignals(port, command.sessionId, first.session);
	const interrupted = busy.length > 0;
	if (interrupted && command.interrupt !== true) {
		return refusal(command.id, busyCode(busy), { attachments: first.attachments, ...busyData(busy) });
	}
	// Admission closes below (for the interrupt, or at the claim). Every answer except a release reopens it
	// on the session the host keeps, and a throw is answered `release_failed` rather than left unanswered.
	const admission = first.session.externalAdmission;
	let dropped = NOTHING_DROPPED;
	let answer: RpcResponse | undefined;
	try {
		if (interrupted) {
			admission.close(RELEASED_ADMISSION_CLOSED);
			dropped = takeQueuedInput(first.session);
			await abortAndSettle(port, command.sessionId, first.session);
		}
		// A never-written session gets its file here, before the final check: its `session_released` entry
		// must reach disk, and a header write that fails is this release's failure, never a stray rejection.
		// A written session awaits nothing, so its claim stays in the same turn as the request that asked.
		const manager = first.session.sessionManager;
		if (!manager.isTranscriptFlushed()) await manager.persistHeaderNow();
		answer = await claimAndRelease(port, command, interrupted, dropped);
		return answer;
	} catch (cause) {
		answer = refusal(command.id, RPC_ERROR_RELEASE_FAILED, {
			detail: cause instanceof Error ? cause.message : String(cause),
			...(interrupted ? { interrupted: true, dropped } : {}),
		});
		return answer;
	} finally {
		if (answer?.success !== true) admission.reopen();
	}
}

/**
 * The final check and the release. After an interrupt every refusal carries `interrupted` and `dropped`:
 * the queues were already emptied, so what they held must reach the caller whatever the answer.
 */
async function claimAndRelease(
	port: SessionReleasePort,
	command: ReleaseSessionCommand,
	interrupted: boolean,
	dropped: ReleaseDropped,
): Promise<RpcResponse> {
	const taken = interrupted ? { interrupted: true, dropped } : undefined;
	const ready = releasable(port, command, taken);
	if (!("session" in ready)) return ready;
	const stillBusy = busySignals(port, command.sessionId, ready.session);
	if (stillBusy.length > 0) {
		return refusal(command.id, busyCode(stillBusy), {
			attachments: ready.attachments,
			...busyData(stillBusy),
			interrupted,
			...taken,
		});
	}
	// From here to the close claim nothing awaits: a drain pass still running admits nothing more, so a
	// delivery it had not admitted stays with its sender and reaches the next owner.
	const admission = ready.session.externalAdmission;
	admission.close(RELEASED_ADMISSION_CLOSED);
	try {
		// On disk or not at all: a failed write leaves no entry a later append could chain onto.
		ready.session.sessionManager.appendCustomEntry(SESSION_RELEASED_ENTRY_TYPE, {
			reason: command.reason,
			interrupted,
			attachments: ready.attachments,
			host_instance: port.hostInstance ?? null,
			released_at: new Date().toISOString(),
		});
	} catch (cause) {
		admission.reopen();
		throw cause;
	}
	if (!(await port.tearDown(command.sessionId, ready.sessionPath))) {
		return refusal(command.id, RPC_ERROR_SESSION_CLOSING, taken);
	}
	return {
		id: command.id,
		type: "response",
		command: "release_session",
		success: true,
		data: { released: true, session_path: ready.sessionPath, attachments: ready.attachments, dropped },
	};
}

function busySignals(port: SessionReleasePort, sessionId: string, session: AgentSession): ReleaseBusySignal[] {
	const activity = session.activitySnapshot;
	const signals: ReleaseBusySignal[] = [];
	if (activity.isStreaming) signals.push("turn");
	if (port.pendingPrompts(sessionId).length > 0) signals.push("prompt");
	// Queued user input outlives its run (a steer can end the stream it was aimed at): it is still owed a turn.
	if (session.pendingMessageCount > 0) signals.push("queued");
	if (session.externalAdmission.list().pending.length > 0) signals.push("delivery");
	if (activity.isBashRunning) signals.push("bash");
	if (activity.isCompacting) signals.push("compaction");
	if (activity.hasSessionWork) signals.push("session_work");
	// The handoff park's predicate decides; a source added to it later is not missed here.
	if (signals.length === 0 && isHandoffBusy(activity)) signals.push("activity");
	if (port.otherRequests(sessionId) > 0) signals.push("request");
	return signals;
}

function busyData(signals: readonly ReleaseBusySignal[]): Readonly<Record<string, unknown>> {
	return signals.includes("queued")
		? { busy: signals, retry_with: { interrupt: true }, hint: RELEASE_QUEUED_HINT }
		: { busy: signals };
}

function busyCode(signals: readonly ReleaseBusySignal[]): string {
	return signals.some(
		(signal) => signal === "turn" || signal === "prompt" || signal === "queued" || signal === "delivery",
	)
		? RPC_ERROR_TURN_ACTIVE
		: RPC_ERROR_SESSION_BUSY;
}

/** `taken`: what an interrupt already took out of the session, merged into any refusal's `errorData`. */
function releasable(
	port: SessionReleasePort,
	command: ReleaseSessionCommand,
	taken: Readonly<Record<string, unknown>> | undefined,
): Releasable | RpcResponse {
	const refuse = (code: string, data?: Readonly<Record<string, unknown>>): RpcResponse =>
		refusal(command.id, code, data || taken ? { ...data, ...taken } : undefined);
	let entry: RpcSessionEntry;
	try {
		entry = port.lookup(command.sessionId);
	} catch (cause) {
		return refuse(port.code(cause));
	}
	if (entry.state !== "open") return refuse(RPC_ERROR_SESSION_CLOSING);
	const session = entry.runtime?.session;
	if (session === undefined) return refuse(RPC_ERROR_RELEASE_UNSUPPORTED, { detail: "worker_runtime" });
	const sessionPath = entry.sessionPath ?? session.sessionFile;
	if (sessionPath === undefined) return refuse(RPC_ERROR_RELEASE_UNSUPPORTED, { detail: "no_session_file" });
	if (entry.attachments > 0 && command.force !== true)
		return refuse(RPC_ERROR_ATTACHED, { attachments: entry.attachments });
	return { session, sessionPath, attachments: entry.attachments };
}

function refusal(id: string | undefined, code: string, data?: Readonly<Record<string, unknown>>): RpcResponse {
	return {
		id,
		type: "response",
		command: "release_session",
		success: false,
		error: code,
		...(data && { errorCode: code, errorData: data }),
	};
}
