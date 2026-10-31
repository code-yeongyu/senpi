import { serializeJsonLine } from "./jsonl.ts";
import type { RpcSessionClosedEvent, RpcSessionClosedReason, RpcSessionParkedEvent } from "./rpc-types.ts";
import { MAX_SHARED_STDIO_QUEUE_BYTES, MAX_SHARED_STDIO_QUEUE_RECORDS } from "./session-event-writer-lanes.ts";
import { SessionEventWriterPresenters } from "./session-event-writer-presenters.ts";
import { causeOfRecord, type SessionStatusActor, terminalOfLifecycle } from "./session-status.ts";
import { type SessionOpenedRecord, sessionOpenedLines } from "./session-status-opened.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";

/** Session lifecycle: `session_opened`, close, seal, close-reply admission and forgetting a handle. */
export abstract class SessionEventWriterLifecycle extends SessionEventWriterPresenters {
	/** Who caused a change: the client whose command is being dispatched, else `fallback`. */
	protected changeActor(fallback: SessionStatusActor): SessionStatusActor {
		return this.connectionContext.getStore() === undefined ? fallback : "client";
	}

	/**
	 * Publish `session_opened` for a session this host just created. Interactive sessions broadcast it (the
	 * lifecycle whitelist); a worker's reaches only its attached connections and subscribers that asked for
	 * workers (invariant I4). `context` travels only to subscribers that asked for it.
	 */
	publishSessionOpened(record: SessionOpenedRecord): void {
		if (this.fanout.isEmpty()) {
			const { context: _context, ...wire } = record;
			this.appendSessionRecord(record.sessionId, { ...wire });
			this.requestFlush();
			return;
		}
		const lines = sessionOpenedLines(record);
		const subscribers = this.status.matchingConnections(record.sessionId);
		const recipients =
			record.kind === "worker"
				? new Set([...this.fanout.attachedConnections(record.sessionId), ...subscribers.keys()])
				: new Set(this.fanout.connectionIds());
		for (const id of recipients)
			this.fanout.get(id)?.actor.enqueue(subscribers.get(id) === true ? lines.withContext : lines.plain);
		this.requestFlush();
	}

	/**
	 * Prevent subsequent records for a session and append its terminal response.
	 * Existing records retain FIFO order; this response is therefore that
	 * session's final stdout record.
	 */
	closeSession(sessionId: string, response: object, reason?: RpcSessionClosedReason, sessionPath?: string): void {
		this.presenterBindings.get(sessionId)?.dispose();
		this.presenterBindings.delete(sessionId);
		if (!this.settleBeforeSeal(sessionId)) return;
		this.sealedSessions.add(sessionId);
		this.securityPresentations.dropSession(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		const targetId = this.connectionContext.getStore();
		// `reason` tells an attached client WHY the handle ended, so a park it can reopen by path is
		// not read as a session that is gone. Absent unless the caller names one; clients tolerate that.
		const lifecycle: RpcSessionClosedEvent = {
			type: "session_closed",
			sessionId,
			...(reason && { reason }),
			...(sessionPath && { sessionPath }),
		};
		if (this.fanout.isEmpty()) this.appendSessionRecord(sessionId, lifecycle);
		else if (this.workerSessions.has(sessionId))
			this.fanout.deliverToSession(sessionId, serializeJsonLine(lifecycle));
		else this.fanout.broadcast(serializeJsonLine(lifecycle));
		this.sealStatus(sessionId, lifecycle);
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered)
			registered.actor.enqueue(
				serializeJsonLine(taggedResponse),
				undefined,
				undefined,
				undefined,
				isCorrelatedReply(response),
			);
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/**
	 * Seal a session whose open rolled back after `session_opened` was published, so subscribers get
	 * its terminal record. The opener's answer is its own failed `open_session`; like a park, no close
	 * response is owed to anyone.
	 */
	sealRolledBackOpen(sessionId: string, sessionPath: string | undefined): void {
		this.sealLifecycle(sessionId, {
			type: "session_closed",
			sessionId,
			reason: "error",
			...(sessionPath !== undefined && { sessionPath }),
		});
	}

	sealLifecycle(
		sessionId: string,
		lifecycle: RpcSessionParkedEvent | RpcSessionClosedEvent,
		attachedOnly = false,
	): void {
		this.presenterBindings.get(sessionId)?.dispose();
		this.presenterBindings.delete(sessionId);
		if (!this.settleBeforeSeal(sessionId)) return;
		this.sealedSessions.add(sessionId);
		this.securityPresentations.dropSession(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		if (this.fanout.isEmpty()) this.appendSessionRecord(sessionId, lifecycle);
		else if (attachedOnly || this.workerSessions.has(sessionId))
			this.fanout.deliverToSession(sessionId, serializeJsonLine(lifecycle));
		else this.fanout.broadcast(serializeJsonLine(lifecycle));
		this.sealStatus(sessionId, lifecycle);
		this.requestFlush();
	}

	private sealStatus(sessionId: string, lifecycle: RpcSessionParkedEvent | RpcSessionClosedEvent): void {
		const terminal = terminalOfLifecycle(lifecycle);
		const cause = causeOfRecord(lifecycle);
		if (terminal !== undefined && cause !== undefined)
			this.status.seal(sessionId, terminal, cause, this.changeActor("host"));
	}

	/**
	 * Admit reply debt before routing can mutate attachments or await finalization.
	 * Reserve the lifecycle as well: the claimant's role is not known yet. Rejected
	 * closes do not wait, retain their ids, or create per-request stderr output.
	 */
	reserveCloseResponse(
		sessionId: string,
		response: object,
		records = 2,
	): { release: () => void; complete: (terminal: boolean, reason?: RpcSessionClosedReason) => void } | undefined {
		const bytes =
			Buffer.byteLength(serializeJsonLine({ ...response, sessionId })) +
			(records === 2
				? Buffer.byteLength(serializeJsonLine({ type: "session_closed", sessionId, reason: "client_close" }))
				: 0);
		if (
			this.bufferedRecordCount + this.reservedCloseRecords + records > MAX_SHARED_STDIO_QUEUE_RECORDS ||
			this.bufferedByteLength + this.reservedCloseBytes + bytes > MAX_SHARED_STDIO_QUEUE_BYTES
		) {
			const overflow = {
				type: "overflow",
				command: "close_session",
				error: "rpc_close_output_overflow, resync required",
			};
			const targetId = this.currentConnection();
			if (targetId !== undefined) {
				const actor = this.fanout.get(targetId)?.actor;
				if (actor && !this.closeOverflowActors.has(actor)) {
					this.closeOverflowActors.add(actor);
					// One outstanding notice per sink, released only on consumption.
					// Actor identity isolates reconnects and does not retain dead sinks.
					actor.enqueue(serializeJsonLine(overflow), undefined, () => this.closeOverflowActors.delete(actor));
				}
			} else if (!this.closeOverflowReported) {
				this.closeOverflowReported = true;
				this.records.append(this.controlQueue, overflow);
				this.markReady(this.controlQueue);
				this.requestFlush();
			}
			return undefined;
		}
		this.reservedCloseRecords += records;
		this.reservedCloseBytes += bytes;
		let active = true;
		const release = () => {
			if (!active) return;
			active = false;
			this.reservedCloseRecords -= records;
			this.reservedCloseBytes -= bytes;
		};
		return {
			release,
			complete: (terminal, reason) => {
				if (!active) return;
				release();
				if (terminal && !this.sealedSessions.has(sessionId)) this.closeSession(sessionId, response, reason);
				else this.appendClosedResponse(sessionId, response);
			},
		};
	}

	/** Queue a joined close only after admitting its noncompactable reply. */
	enqueueClosedResponse(sessionId: string, response: object): void {
		this.reserveCloseResponse(sessionId, response, 1)?.complete(false);
	}

	private appendClosedResponse(sessionId: string, response: object): void {
		const targetId = this.connectionContext.getStore();
		const taggedResponse = { ...response, sessionId };
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered)
			registered.actor.enqueue(
				serializeJsonLine(taggedResponse),
				undefined,
				undefined,
				undefined,
				isCorrelatedReply(response),
			);
		else this.appendSessionRecord(sessionId, taggedResponse, targetId);
		this.requestFlush();
	}

	/**
	 * Drops per-session bookkeeping for a handle whose runtime is fully disposed.
	 * Routing handles are unique per process epoch, so nothing can legitimately
	 * emit under this id again; without this every host-closed session would
	 * leave a permanent sealed-handle (and snapshot) entry behind.
	 */
	forgetSession(sessionId: string): void {
		this.sealedSessions.delete(sessionId);
		this.openTurns.take(sessionId);
		this.workerSessions.delete(sessionId);
		this.fanout.forgetSession(sessionId);
		this.mediaPersisters.delete(sessionId);
		this.status.forget(sessionId);
		this.surfaceDedupe.forgetSession(sessionId);
	}

	protected abstract settleBeforeSeal(sessionId: string): boolean;
}
