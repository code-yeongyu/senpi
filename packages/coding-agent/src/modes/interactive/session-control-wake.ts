/**
 * Edge-driven wakes for a session's inbox drain. Nothing here runs on a timer: every pass is caused
 * by an edge (idle, submission, draft cleared, a `wake` command, an inbox entry created or deleted,
 * a delivery written, a continue after a stop).
 *
 * One pass runs at a time. Edges that arrive while a pass runs set the dirty flag - they are merged
 * into exactly ONE more pass after it returns, never dropped and never multiplied, so the drain's own
 * marker deletions cost at most one extra empty pass and then the watcher falls silent.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createFsWatchEventSource } from "../../core/extensions/builtin/config-reload/watch-event-source.ts";
import type {
	SessionControlDrainResult,
	SessionControlWakeEvent,
	SessionControlWakeReason,
} from "../../core/extensions/session-control-types.ts";

/** The reason a coalesced pass reports: the edge a held delivery is waiting for wins. */
const REASON_PRIORITY: readonly SessionControlWakeReason[] = [
	"submission",
	"draft_cleared",
	"idle",
	"continue",
	"command",
	"emitted",
	"inbox",
];

type WakePass = (event: SessionControlWakeEvent) => Promise<SessionControlDrainResult>;

interface WakeBatch {
	readonly reasons: Set<SessionControlWakeReason>;
	readonly deliveryIds: Set<string>;
	readonly waiters: Array<(result: SessionControlDrainResult) => void>;
}

const EMPTY_RESULT: SessionControlDrainResult = { admitted: [] };

export class WakeScheduler {
	private running = false;
	private disposed = false;
	private next: WakeBatch | undefined;
	private readonly pass: WakePass;
	private readonly onError: (error: unknown) => void;

	constructor(pass: WakePass, onError: (error: unknown) => void) {
		this.pass = pass;
		this.onError = onError;
	}

	/** Resolves with the result of the pass that covers this edge. */
	request(reason: SessionControlWakeReason, deliveryIds?: readonly string[]): Promise<SessionControlDrainResult> {
		if (this.disposed) return Promise.resolve(EMPTY_RESULT);
		this.next ??= { reasons: new Set(), deliveryIds: new Set(), waiters: [] };
		const batch = this.next;
		batch.reasons.add(reason);
		for (const id of deliveryIds ?? []) batch.deliveryIds.add(id);
		const settled = new Promise<SessionControlDrainResult>((resolve) => batch.waiters.push(resolve));
		if (!this.running) void this.run();
		return settled;
	}

	dispose(): void {
		this.disposed = true;
		const batch = this.next;
		this.next = undefined;
		for (const waiter of batch?.waiters ?? []) waiter(EMPTY_RESULT);
	}

	private async run(): Promise<void> {
		this.running = true;
		try {
			for (let batch = this.next; batch !== undefined && !this.disposed; batch = this.next) {
				this.next = undefined;
				let result = EMPTY_RESULT;
				try {
					result = await this.pass(wakeEvent(batch));
				} catch (error) {
					this.onError(error);
				}
				for (const waiter of batch.waiters) waiter(result);
			}
		} finally {
			this.running = false;
		}
	}
}

function wakeEvent(batch: WakeBatch): SessionControlWakeEvent {
	const reasons = REASON_PRIORITY.filter((reason) => batch.reasons.has(reason));
	const reason = reasons[0] ?? "inbox";
	const ids = [...batch.deliveryIds];
	return { type: "session_control_wake", reason, reasons, ...(ids.length > 0 ? { delivery_ids: ids } : {}) };
}

/** Prefix of the engine's own entries in an inbox; a registrant never treats them as deliveries. */
export const INBOX_ENGINE_ENTRY_PREFIX = ".senpi-";
const INBOX_ARM_ATTEMPTS = 25;
const INBOX_ARM_ATTEMPT_MS = 200;

/** A live inbox watch. `armed` settles once arming did: the watch confirmed, the bounded retry ran out, or it was stopped. */
export interface InboxWatch {
	readonly armed: Promise<void>;
	stop(): void;
}

/**
 * One watch on the inbox directory. Creation and teardown run on the shared watch worker (FSEvents
 * and inotify setup/teardown block the calling thread), so neither ever stalls the terminal.
 *
 * The worker arms the watch asynchronously, and an entry written before it is armed produces no
 * event. Arming is confirmed by a sentinel entry's own event coming back - the sentinel is re-touched
 * until then, bounded, which is the only timer here and runs only while arming (an unconfirmed arm is
 * reported through `onError`). Nothing waits on that confirmation: the watch is returned at once and
 * `armed` settles when arming did, so the caller can request the pass that picks up anything created
 * before the watch could see it.
 */
export async function watchInbox(
	inboxDir: string,
	onChange: () => void,
	onError: (error: unknown) => void,
): Promise<InboxWatch> {
	await mkdir(inboxDir, { recursive: true, mode: 0o700 });
	const sentinel = `${INBOX_ENGINE_ENTRY_PREFIX}armed-${randomUUID()}`;
	const confirmation = Promise.withResolvers<boolean>();
	let stopped = false;
	const unsubscribe = createFsWatchEventSource((error) => onError(error))(
		inboxDir,
		(_eventType, filename) => {
			if (filename === sentinel) confirmation.resolve(true);
			else if (!filename?.startsWith(INBOX_ENGINE_ENTRY_PREFIX)) onChange();
		},
		{ recursive: false },
	);
	const arming = confirmArm(join(inboxDir, sentinel), confirmation.promise, () => stopped).then(
		(confirmed) => {
			if (!confirmed && !stopped) onError(new Error(`inbox watch on ${inboxDir} was not confirmed`));
		},
		(error: unknown) => {
			if (!stopped) onError(error);
		},
	);
	// Settles on the sentinel's own event, before any later event of the same watch is delivered, so a
	// pass requested on it runs ahead of the passes those events cause; otherwise when arming ended.
	const armed = Promise.race([confirmation.promise.then((confirmed) => (confirmed ? undefined : arming)), arming]);
	return {
		armed,
		stop: () => {
			stopped = true;
			confirmation.resolve(false);
			void Promise.resolve(unsubscribe()).catch(onError);
		},
	};
}

async function confirmArm(sentinelPath: string, confirmed: Promise<boolean>, stopped: () => boolean): Promise<boolean> {
	let seen = false;
	try {
		for (let attempt = 0; attempt < INBOX_ARM_ATTEMPTS && !seen && !stopped(); attempt++) {
			await writeFile(sentinelPath, String(attempt), { mode: 0o600 });
			seen = await Promise.race([confirmed, delay(INBOX_ARM_ATTEMPT_MS, false)]);
		}
	} finally {
		await rm(sentinelPath, { force: true });
	}
	return seen;
}

/**
 * A continue after any stop (`^Z` or an external SIGSTOP) wakes the drain once the terminal has been
 * restored: the listener is persistent, so every stop/continue cycle is covered, and it defers past
 * the handlers that restore the terminal on the same signal.
 */
export function onProcessContinue(listener: () => void): () => void {
	const handler = (): void => {
		setImmediate(listener);
	};
	process.on("SIGCONT", handler);
	return () => {
		process.removeListener("SIGCONT", handler);
	};
}
