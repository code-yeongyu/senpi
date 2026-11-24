/**
 * What an accepted RPC connection does with its peer's FIN (oh-my-openagent#14725). Every listener that feeds one is
 * half-open (`allowHalfOpen: true`), so neither the runtime nor a wrapper stream ends the connection on the FIN: a
 * runtime that ended it at once dropped the replies still owed (Node), and one that never did held the socket for good.
 * The owner answers what the peer asked before its FIN, flushes, then ends, within one deadline.
 */
import type { Duplex } from "node:stream";

/** How long a connection may still take, after its peer's FIN, to answer and flush what the peer asked before it. */
export const PEER_END_REPLY_GRACE_MS = 30_000;

/** The replies one connection still owes its peer. */
export class PendingReplies {
	private readonly pending = new Set<Promise<unknown>>();

	track(work: Promise<unknown>): void {
		this.pending.add(work);
		const settle = () => this.pending.delete(work);
		void work.then(settle, settle);
	}

	/** Settles once every reply tracked so far has settled, whichever way. */
	settled(): Promise<void> {
		return Promise.allSettled([...this.pending]).then(() => undefined);
	}
}

/**
 * Arms the end of `stream`'s connection on its peer's FIN. Register it after the line reader, so the last line is
 * dispatched (and its reply tracked) before this runs. `close` runs once, after the replies settled and `flush`
 * finished, or when `graceMs` ran out first.
 */
export function endAfterPeerFin(
	stream: Duplex,
	replies: PendingReplies,
	flush: () => Promise<void>,
	close: () => void,
	graceMs = PEER_END_REPLY_GRACE_MS,
): void {
	stream.once("end", () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, graceMs);
		});
		const finish = () => {
			clearTimeout(timer);
			close();
		};
		void Promise.race([replies.settled().then(flush), deadline]).then(finish, finish);
	});
}
