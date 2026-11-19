/**
 * The drain of a graceful close (`unload_session { graceful: true }`, oh-my-openagent#14313), shared by a host and a
 * terminal's control endpoint. The fence comes first and in one synchronous step: automatic turns wait as notices
 * (the running turn is the session's last), admission refuses every new delivery typed `session_closing`, and the
 * queued input leaves the session at once, handed back to its senders unread. The running turn and its tool calls
 * then end on their own; nothing is aborted. A drain that outlives its bound reopens the session as it was.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import type { SessionClosedRecord } from "../../core/session-closed.ts";
import { type ReleaseDropped, takeQueuedInput } from "./session-release-interrupt.ts";

const GRACEFUL_CLOSE_DEFAULT_WAIT_MS = 60_000;
const GRACEFUL_CLOSE_MAX_WAIT_MS = 600_000;

/** What `admit_external_message` refuses with (`session_closing`) while a graceful close drains. */
const GRACEFUL_ADMISSION_CLOSED =
	"session_closing: the session is closing on request and takes no new deliveries";

export interface GracefulDrainPort {
	/** What still keeps the session from closing (a run, a prompt in preflight, bash, compaction, a request); empty when quiet. */
	busy(): readonly string[];
	/** Work that settles as the session quiets: prompts in preflight and other requests for it. */
	settling(): readonly Promise<unknown>[];
}

export interface GracefulDrain {
	readonly dropped: ReleaseDropped;
	readonly startedAt: number;
}

export function gracefulWaitMs(requested: number | undefined): number {
	return Math.min(requested ?? GRACEFUL_CLOSE_DEFAULT_WAIT_MS, GRACEFUL_CLOSE_MAX_WAIT_MS);
}

export function fenceForClose(session: AgentSession): GracefulDrain {
	session.holdForClose();
	session.externalAdmission.close(GRACEFUL_ADMISSION_CLOSED);
	return { dropped: takeQueuedInput(session, false), startedAt: Date.now() };
}

/** A drain that did not end in a close leaves the session open and admitting, as before the fence. */
export function reopenAfterDrain(session: AgentSession): void {
	session.releaseCloseHold();
	session.externalAdmission.reopen();
}

/**
 * Resolves `true` once `port.busy()` is empty, `false` when `waitMs` passes first. It wakes on every session event and
 * on the settling work, re-checking each time; nothing polls.
 */
export async function drainUntilQuiet(
	session: AgentSession,
	port: GracefulDrainPort,
	waitMs: number,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	let settlingPending = true;
	while (port.busy().length > 0) {
		const left = deadline - Date.now();
		if (left <= 0) return false;
		const changed = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(() => changed.resolve());
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, left);
		});
		const waits: Promise<unknown>[] = [changed.promise.then(() => (settlingPending = true)), expired];
		// Settled work stays settled: once it is, only a session event can change what keeps the session busy.
		if (settlingPending)
			waits.push(
				Promise.allSettled([session.waitForIdle(), ...port.settling()]).then(() => (settlingPending = false)),
			);
		try {
			await Promise.race(waits);
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}
	}
	return true;
}

export function drainFacts(session: AgentSession, drain: GracefulDrain): { turn: number; waited_ms: number } {
	return { turn: session.externalAdmission.turnEpoch, waited_ms: Date.now() - drain.startedAt };
}

/**
 * The quiet session's clean stop, in the same synchronous step as the close claim that follows it: the closing hold is
 * released (a reopen replays no pause), the `session-closed` record is written, and the teardown's `session_shutdown`
 * will carry `closed: true`. Answers the record.
 */
export function recordGracefulClose(session: AgentSession, drain: GracefulDrain): SessionClosedRecord {
	const record: SessionClosedRecord = {
		graceful: true,
		...drainFacts(session, drain),
		returned: { deliveries: [...drain.dropped.deliveries], user_messages: [...drain.dropped.user_messages] },
		stopped: { wake_sources: [...session.activeWakeSources] },
		at: new Date().toISOString(),
	};
	session.releaseCloseHold();
	session.recordClosedOnRequest(record);
	return record;
}
