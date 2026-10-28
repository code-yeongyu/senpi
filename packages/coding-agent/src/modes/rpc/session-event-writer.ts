import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { normalizeJsonValue } from "./json-normal-value.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitNormalInlineMedia } from "./media-placeholders.ts";
import type { RpcHostLifecycleEvent, RpcOpenQueuedEvent } from "./rpc-types.ts";
import { compactDelta, demoteToDeltaOnly, MESSAGE_KEY, type RpcRecord } from "./session-event-writer-compaction.ts";
import { SessionEventWriterRecovery } from "./session-event-writer-recovery.ts";
import { causeOfRecord } from "./session-status.ts";
import { isCorrelatedReply } from "./socket-peer-recovery.ts";

export type { SessionEventWriterConnection } from "./session-event-fanout.ts";
export { MAX_SHARED_STDIO_QUEUE_BYTES, MAX_SHARED_STDIO_QUEUE_RECORDS } from "./session-event-writer-lanes.ts";

/**
 * Process-wide stdout scheduler for multi-session RPC mode.
 *
 * Each queue contains complete structured JSONL records for one routing handle.
 * Draining takes one record per queue in round-robin order and waits for stdout
 * backpressure before selecting the next one. A record is deliberately written
 * by itself: coalescing records from different sessions would obscure the
 * scheduling boundary and violate D9.
 */
export class SessionEventWriter extends SessionEventWriterRecovery {
	/** Private records bypass event queues, snapshots, mirrors, replay, and overflow preview errors. */
	handleMcpForm(value: unknown): boolean {
		if (!this.presenterAuthority) return false;
		if (
			typeof value !== "object" ||
			value === null ||
			!("type" in value) ||
			typeof value.type !== "string" ||
			(!value.type.startsWith("mcp_form_") && value.type !== "mcp_presenter_context")
		)
			return false;
		const id = this.currentConnection();
		const sender = id === undefined ? undefined : this.presenterConnections.get(id);
		const context =
			value.type === "mcp_presenter_context" && "sessionId" in value && typeof value.sessionId === "string" && sender
				? this.presenterAuthority?.connectionContext(sender, value.sessionId)
				: undefined;
		const reply =
			value.type === "mcp_presenter_context"
				? context
					? { ok: true, context }
					: { error: "presenter_not_authorized" }
				: sender && this.presenterAuthority
					? this.presenterAuthority.receive(sender, value)
					: { error: "presenter_not_authorized" };
		const connection = id === undefined ? undefined : this.fanout.get(id)?.connection;
		if (connection) {
			try {
				connection.writeRaw(
					serializeJsonLine({
						type: "mcp_form_reply",
						...("id" in value && typeof value.id === "string" ? { id: value.id } : {}),
						...reply,
					}),
				);
			} catch {
				if (sender) this.presenterAuthority?.detach(sender);
			}
		}
		return true;
	}

	/** Queue a session record. Content events target connections attached to the session. */
	enqueue(sessionId: string, value: object): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		const targetId = this.connectionContext.getStore();
		const record = normalizeJsonValue(value).value as RpcRecord;
		const isTargeted =
			record.type === "response" ||
			record.type === "bash_execution_update" ||
			// Relocation records belong to the one connection that offers it (session-relocation-channel.ts).
			record.type === "host_request" ||
			record.type === "relocation_due" ||
			(record.type === "extension_ui_request" &&
				["select", "confirm", "input", "editor"].includes(String(record.method)));
		const tagged = { ...record, sessionId } as RpcRecord;
		const line = serializeJsonLine(tagged);
		// Observation records are per-subscription opt-ins on the subscriber's own actor FIFO: never attachments,
		// the attach replay, response broadcast, or the stdio lane, which cannot subscribe.
		if (
			record.type === "snapshot_marker" ||
			record.type === "ui_request_pending" ||
			record.type === "ui_request_settled"
		) {
			const targets =
				record.type === "snapshot_marker"
					? this.status.mirrorTargets(sessionId, "snapshot_marker").filter((id) => id === targetId)
					: this.status.dialogTargets(sessionId);
			for (const target of targets) this.fanout.get(target)?.actor.enqueue(line);
			if (targets.length > 0) this.requestFlush();
			return true;
		}
		if (this.fanout.isEmpty() && this.exceedsStdioCapacity(line)) {
			this.closeSession(
				sessionId,
				{
					type: "response",
					command: "close_session",
					success: false,
					error: "session_output_overflow, resync required",
				},
				"error",
			);
			return false;
		}
		this.openTurns.note(sessionId, record.type);
		const attached = this.fanout.targets(sessionId, targetId, isTargeted, record.type);
		// Mirroring is an explicit per-subscription opt-in; it adds destinations, never an attachment.
		const mirrors = isTargeted ? [] : this.status.mirrorTargets(sessionId, String(record.type));
		const targets = mirrors.length === 0 ? attached : [...new Set([...attached, ...mirrors])];
		// A record is only walked and re-serialized when a target asked for placeholders;
		// otherwise this is byte-for-byte today's path, with serializeJsonLine called once.
		const hasPlaceholderTarget = targets.some((target) =>
			this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY),
		);
		const redacted = hasPlaceholderTarget
			? omitNormalInlineMedia(tagged, this.mediaPersisters.get(sessionId))
			: tagged;
		const placeholderLine = redacted === tagged ? undefined : serializeJsonLine(redacted);
		if (!isTargeted) this.fanout.rememberSnapshot(sessionId, tagged, line, placeholderLine);
		for (const target of targets) {
			if (target !== undefined && !this.fanout.get(target)) continue;
			const registered = target === undefined ? undefined : this.fanout.get(target);
			const wants =
				placeholderLine !== undefined && this.fanout.connectionHas(target, MEDIA_PLACEHOLDERS_CAPABILITY);
			if (registered && target !== undefined) {
				const keyed = compactDelta(tagged) !== undefined && tagged.message !== null;
				registered.actor.enqueue(
					wants ? placeholderLine : line,
					keyed ? MESSAGE_KEY : undefined,
					undefined,
					keyed ? serializeJsonLine(demoteToDeltaOnly(tagged)) : undefined,
					isCorrelatedReply(tagged),
					mirrors.includes(target)
						? undefined
						: this.fanout.attachmentOf(target, sessionId, isTargeted, record.type),
				);
			} else this.appendSessionRecord(sessionId, wants ? (redacted as RpcRecord) : tagged, target);
		}
		// After the causing record is on every destination's FIFO, never before (ordering contract).
		const cause = isTargeted ? undefined : causeOfRecord(record);
		if (cause !== undefined) this.status.publish(sessionId, cause, this.changeActor("agent"));
		this.afterRecord?.(sessionId);
		this.requestFlush();
		return true;
	}

	/**
	 * One `loaded_surfaces_changed` per connection per inventory transition: sessions moving from the
	 * same digest to the same new one share a single event, tagged with the first session that
	 * reported it; a session converging from a different start still announces its own change.
	 */
	publishLoadedSurfacesChanged(sessionId: string, previous: string | undefined, digest: string): void {
		if (this.fanout.isEmpty()) {
			this.enqueue(sessionId, { type: "loaded_surfaces_changed" });
			return;
		}
		if (this.sealedSessions.has(sessionId)) return;
		const line = serializeJsonLine({ type: "loaded_surfaces_changed", sessionId });
		for (const id of this.fanout.attachedConnections(sessionId)) {
			if (!this.surfaceDedupe.announce(id, sessionId, previous, digest)) continue;
			const held = this.fanout.attachmentOf(id, sessionId, false, "loaded_surfaces_changed");
			this.fanout.get(id)?.actor.enqueue(line, undefined, undefined, undefined, false, held);
		}
		this.requestFlush();
	}

	/** Queue one untagged host-control response for the given connection (defaults to the current one). */
	enqueueControl(value: object, targetOverride?: string): Promise<void> {
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const targetId = targetOverride ?? this.connectionContext.getStore();
		const registered = targetId === undefined ? undefined : this.fanout.get(targetId);
		if (registered) {
			registered.actor.enqueue(serializeJsonLine(value), undefined, undefined, undefined, isCorrelatedReply(value));
			this.requestFlush();
			return Promise.resolve();
		}
		if (this.exceedsStdioCapacity(serializeJsonLine(value))) {
			if (!this.controlOverflowReported) {
				this.controlOverflowReported = true;
				this.records.append(this.controlQueue, {
					type: "overflow",
					error: "rpc_control_output_overflow, resync required",
				});
				this.markReady(this.controlQueue);
				this.requestFlush();
			}
			return Promise.reject(new Error("rpc_control_output_overflow, resync required"));
		}
		const queue = targetId === undefined ? this.controlQueue : this.connectionQueue(targetId);
		const completion = new Promise<void>((resolve, reject) => {
			this.records.append(queue, { ...value }, undefined, resolve, reject);
		});
		this.markReady(queue);
		this.requestFlush();
		return completion;
	}

	/**
	 * Queue one HOST-level lifecycle record for every registered connection, or the
	 * shared stdio lane when none is registered. Unlike session records it is not tagged
	 * with a routing handle by the writer: `host_stalled` carries the handle it blames,
	 * and `host_memory_pressure` belongs to the process, not to a session.
	 */
	/**
	 * Tell ONE opener where it sits in the open queue, before its open reaches the loop.
	 *
	 * Sent to the opening connection only: a queue position is about that caller's request, not
	 * about the host. If the connection is gone the record is dropped rather than queued - a
	 * position is worthless to a client that already left.
	 */
	sendOpenQueued(connection: string, record: RpcOpenQueuedEvent): void {
		// Reconstruct so desktop `refresh-senpi-events.ts` sees a literal `type:` site in this file.
		const wire: RpcRecord = {
			type: "queued",
			for_request: record.for_request,
			position: record.position,
			in_flight: record.in_flight,
		};
		const target = this.fanout.get(connection);
		if (target === undefined) return;
		target.actor.enqueue(serializeJsonLine(wire));
		this.requestFlush();
	}

	broadcastHostRecord(record: RpcHostLifecycleEvent): void {
		// Reconstruct so desktop `refresh-senpi-events.ts` sees literal `type:` sites in this file.
		let wire: RpcRecord;
		switch (record.type) {
			case "host_superseded":
				wire = {
					type: "host_superseded",
					instanceId: record.instanceId,
					generation: record.generation,
					successor: record.successor,
				};
				break;
			case "host_stalled":
				wire = {
					type: "host_stalled",
					driftMs: record.driftMs,
					...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
					...(record.tool !== undefined ? { tool: record.tool } : {}),
				};
				break;
			case "host_memory_pressure":
				wire = {
					type: "host_memory_pressure",
					rssMb: record.rssMb,
					...(record.footprintMb !== undefined ? { footprintMb: record.footprintMb } : {}),
					...(record.measure !== undefined ? { measure: record.measure } : {}),
					sessions: record.sessions,
					...(record.main !== undefined ? { main: record.main } : {}),
					...(record.kernels !== undefined ? { kernels: record.kernels } : {}),
				};
				break;
			case "host_trimmed":
				wire = {
					type: "host_trimmed",
					footprintBeforeMb: record.footprintBeforeMb,
					footprintAfterMb: record.footprintAfterMb,
					measure: record.measure,
					collected: record.collected,
					sessions: record.sessions,
					pauseMs: record.pauseMs,
				};
				break;
			case "subscription_limits":
				wire = {
					type: "subscription_limits",
					provider: record.provider,
					account: record.account,
					windows: record.windows,
					reportedAt: record.reportedAt,
					...(record.plan === undefined ? {} : { plan: record.plan }),
					...(record.error === undefined ? {} : { error: record.error }),
				};
				break;
			default: {
				const exhaustive: never = record;
				throw new Error(`unexpected host record ${exhaustive}`);
			}
		}
		if (this.fanout.isEmpty()) {
			this.records.append(this.controlQueue, wire);
			this.markReady(this.controlQueue);
		} else this.fanout.broadcast(serializeJsonLine(wire));
		this.requestFlush();
	}

	/**
	 * Seal a session the host PARKED and publish `session_parked`.
	 *
	 * Parking is the idle sweep putting a RETAINED session back on disk: the routing
	 * handle ends exactly as a close ends it, but the session survives and reopens with
	 * `open_session { sessionPath }`, so the record a client dispatches on must say so
	 * instead of claiming the session ended. Delivery follows the `session_closed` rule -
	 * a worker session's record reaches only its attached connections, an interactive
	 * session's reaches every connection. No client asked for this teardown, so there is
	 * no close response to answer.
	 */
	parkSession(sessionId: string, sessionPath: string, reason: "idle" | "unloaded"): void {
		this.sealLifecycle(sessionId, { type: "session_parked", sessionId, sessionPath, reason });
	}

	/**
	 * Seal a session `release_session` handed to a runtime outside this host and publish
	 * `session_closed { reason: "released", sessionPath }`. Unlike a park the file must NOT be reopened
	 * here - another process now writes it. Delivered like a park; the releasing caller's own answer is
	 * the `release_session` response, so there is no close response either.
	 */
	releaseSession(sessionId: string, sessionPath: string): void {
		this.sealLifecycle(sessionId, { type: "session_closed", sessionId, reason: "released", sessionPath });
	}

	/**
	 * Publishes the settles a seal would strand (session-open-turns.ts) while the session can still write;
	 * false when the session is sealed already, or became sealed by a settle that overflowed the stdio lane.
	 */
	protected settleBeforeSeal(sessionId: string): boolean {
		if (this.sealedSessions.has(sessionId)) return false;
		for (let owed = this.openTurns.take(sessionId); owed > 0; owed -= 1) {
			this.enqueue(sessionId, { type: "agent_settled", reason: "session_closed" });
		}
		return !this.sealedSessions.has(sessionId);
	}
}
