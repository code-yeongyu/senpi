import { MEDIA_PLACEHOLDERS_CAPABILITY } from "./custom-capability.ts";
import { ExtensionTransportOwner } from "./extension-owner.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { observeLifecycleDelivery } from "./lifecycle-delivery.ts";
import { carriesMedia, omitNormalInlineMedia } from "./media-placeholders.ts";
import type { SessionAcceptanceLane } from "./session-acceptance-lane.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";
import { EVENT_RESYNC_CAPABILITY, type ResyncReason, type RpcSessionResyncRequired } from "./socket-peer-recovery.ts";

export type RawWriter = (chunk: string) => void;
export type BackpressureWaiter = () => Promise<void>;

export interface SessionEventWriterConnection {
	readonly writeRaw: RawWriter;
	readonly waitForBackpressure: BackpressureWaiter;
	/**
	 * Tears the transport down. Called when this connection's event queue fails
	 * (overflow, write error): the actor has already stopped delivering records
	 * AND command responses, so a socket left open would strand the client on a
	 * connection that can never answer again. Closing it lets the client resync.
	 */
	readonly close?: () => void;
}

const BROADCAST_LIFECYCLE_RECORDS = new Set([
	"agent_start",
	"agent_settled",
	"agent_idle",
	"session_opened",
	"session_closed",
	"session_lifecycle",
]);

type RegisteredConnection = {
	readonly connection: SessionEventWriterConnection;
	readonly actor: SocketEventSinkActor;
	readonly owner: ExtensionTransportOwner;
};

/**
 * A replayable snapshot line.
 *
 * `placeholderLine` is the `media_placeholders` variant. The writer supplies it only when
 * a capable connection was already attached when the record was emitted; a connection that
 * attaches later still needs it, so the frozen line supplies the source on the first
 * capable replay. Only the derived line is memoized; no provider object is retained.
 * `mayCarryMedia` is the type gate taken at acceptance: a record whose type cannot carry
 * media (every `message_update` partial) replays its `line` with no parse at all; only
 * media-bearing records parse their frozen line, once.
 */
type SnapshotRecord = {
	readonly line: string;
	placeholderLine?: string;
	readonly hasMessage: boolean;
	readonly mayCarryMedia: boolean;
};

/** The placeholder variant of a remembered record, derived and memoized on first use. */
function snapshotPlaceholderLine(record: SnapshotRecord): string {
	if (record.placeholderLine !== undefined) return record.placeholderLine;
	if (!record.mayCarryMedia) return record.line;
	const source = JSON.parse(record.line) as Record<string, unknown>;
	const redacted = omitNormalInlineMedia(source);
	record.placeholderLine = redacted === source ? record.line : serializeJsonLine(redacted);
	return record.placeholderLine;
}

export class SessionEventFanout {
	onConnectionClosed?: (id: string) => void;
	/** Each routing session's acceptance lane; retired when the session is sealed or forgotten. */
	readonly acceptance = new Map<string, SessionAcceptanceLane>();
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly sessionSnapshots = new Map<string, SnapshotRecord[]>();
	private readonly lifecycleSnapshots = new Map<string, SnapshotRecord>();
	private readonly pendingQuestions = new Map<string, Map<string, Record<string, unknown>>>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	private readonly connectionSessions = new Map<string, Set<string>>();
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
	): void {
		this.unregisterConnection(id);
		const owner = new ExtensionTransportOwner();
		const actor = new SocketEventSinkActor(
			connection,
			(cause) => {
				if (this.connections.get(id)?.actor === actor) {
					owner.retire();
					this.connections.delete(id);
					this.connectionCapabilities.delete(id);
					this.connectionSessions.delete(id);
					this.registeredCapabilityConnections.delete(id);
					this.onConnectionClosed?.(id);
				}
				process.stderr.write(
					`senpi rpc connection ${id} event queue failed; closing: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
				connection.close?.();
			},
			options.maxQueueBytes,
			options.stallMs,
		);
		this.connections.set(id, { connection, actor, owner });
		this.connectionCapabilities.set(id, new Set());
		this.connectionSessions.set(id, new Set());
	}

	unregisterConnection(id: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		registered.owner.retire();
		registered.actor.close();
		this.connections.delete(id);
		this.connectionCapabilities.delete(id);
		this.connectionSessions.delete(id);
		this.registeredCapabilityConnections.delete(id);
	}

	attachConnectionToSession(id: string, sessionId: string): void {
		if (!this.connections.has(id)) return;
		const sessions = this.connectionSessions.get(id) ?? new Set<string>();
		if (sessions.has(sessionId)) return;
		sessions.add(sessionId);
		this.connectionSessions.set(id, sessions);
		this.replaySnapshot(id, sessionId);
		for (const frame of this.pendingQuestions.get(sessionId)?.values() ?? []) {
			this.connections.get(id)?.actor.enqueue(
				serializeJsonLine({
					...frame,
					remainingMs: typeof frame.deadlineAtMs === "number" ? Math.max(0, frame.deadlineAtMs - Date.now()) : 0,
				}),
			);
		}
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		this.connectionSessions.get(id)?.delete(sessionId);
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		this.connectionCapabilities.set(id, new Set(capabilities));
		this.registeredCapabilityConnections.add(id);
		if (capabilities.includes(EVENT_RESYNC_CAPABILITY)) {
			registered.actor.enableRecovery((reason) => {
				const attached = [...(this.connectionSessions.get(id) ?? [])];
				// Frozen at the shed, before the actor awaits its drain (R3.C1.5); released by the recovery.
				const frozen = attached.flatMap((sessionId) => {
					const lane = this.acceptance.get(sessionId);
					return lane && !lane.retired ? [{ lane, root: lane.freeze() }] : [];
				});
				return Object.assign(() => this.resyncSnapshot(id, reason, attached), {
					release: () => {
						for (const { lane, root } of frozen) lane.release(root);
					},
				});
			});
		} else registered.actor.disableRecovery();
	}

	clearConnectionCapabilities(id: string): void {
		if (this.connections.has(id)) {
			this.connectionCapabilities.set(id, new Set());
			this.registeredCapabilityConnections.delete(id);
		}
	}

	hasRegisteredConnectionCapabilities(id: string): boolean {
		return this.registeredCapabilityConnections.has(id);
	}

	getConnectionCapabilities(id: string): readonly string[] | undefined {
		if (!this.registeredCapabilityConnections.has(id)) return undefined;
		return [...(this.connectionCapabilities.get(id) ?? [])];
	}

	/** Whether a connection advertised a capability. The only capability lookup in this file. */
	connectionHas(id: string | undefined, capability: string): boolean {
		return id === undefined ? false : (this.connectionCapabilities.get(id)?.has(capability) ?? false);
	}

	targets(
		sessionId: string,
		targetId: string | undefined,
		isTargeted: boolean,
		recordType: unknown,
	): readonly (string | undefined)[] {
		if (isTargeted) return [targetId];
		if (typeof recordType === "string" && BROADCAST_LIFECYCLE_RECORDS.has(recordType))
			return this.connections.size > 0 ? [...this.connections.keys()] : [undefined];
		return this.connections.size > 0
			? [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId))
			: [undefined];
	}

	get(id: string): RegisteredConnection | undefined {
		return this.connections.get(id);
	}

	values(): IterableIterator<RegisteredConnection> {
		return this.connections.values();
	}

	/** True when no socket connection is registered, i.e. records must fall back to the stdio lane. */
	isEmpty(): boolean {
		return this.connections.size === 0;
	}

	broadcast(line: string): void {
		for (const { actor } of this.connections.values()) actor.enqueue(line);
	}

	connectionIds(): readonly string[] {
		return [...this.connections.keys()];
	}

	attachedConnections(sessionId: string): readonly string[] {
		return [...this.connections.keys()].filter((id) => this.connectionSessions.get(id)?.has(sessionId));
	}

	/** Pending `question` frames a session has asked and nobody answered yet. */
	pendingQuestionCount(sessionId: string): number {
		return this.pendingQuestions.get(sessionId)?.size ?? 0;
	}

	/** Deliver one line to the connections attached to a session, never to the rest of the fanout. */
	deliverToSession(sessionId: string, line: string): void {
		for (const [id, { actor }] of this.connections)
			if (this.connectionSessions.get(id)?.has(sessionId)) actor.enqueue(line);
	}

	rememberSnapshot(sessionId: string, value: Record<string, unknown>, line: string, placeholderLine?: string): void {
		const record: SnapshotRecord = {
			line,
			placeholderLine,
			hasMessage: value.message != null,
			mayCarryMedia: carriesMedia(value),
		};
		if (value.type === "session_lifecycle") {
			this.lifecycleSnapshots.set(sessionId, record);
			return;
		}
		if (value.type === "extension_ui_request" && value.method === "question" && typeof value.id === "string") {
			const pending = this.pendingQuestions.get(sessionId) ?? new Map<string, Record<string, unknown>>();
			// Writer acceptance already detached and JSON-normalized the frame.
			pending.set(value.id, { ...value });
			this.pendingQuestions.set(sessionId, pending);
			return;
		}
		if (value.type === "question_resolved" && typeof value.id === "string") {
			this.pendingQuestions.get(sessionId)?.delete(value.id);
			return;
		}
		if (value.type === "question_updated" && typeof value.id === "string") {
			const frame = this.pendingQuestions.get(sessionId)?.get(value.id);
			if (frame) Object.assign(frame, { deadlineAtMs: value.deadlineAtMs, remainingMs: value.remainingMs });
			return;
		}
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		if (value.type === "message_start" || (value.type === "message_update" && event?.type === "text_start")) {
			this.sessionSnapshots.set(sessionId, [record]);
		} else if (this.sessionSnapshots.has(sessionId)) {
			this.sessionSnapshots.get(sessionId)?.push(record);
		}
		if (value.type === "message_end") this.sessionSnapshots.delete(sessionId);
	}

	forgetSession(sessionId: string): void {
		this.acceptance.get(sessionId)?.retire("close");
		this.acceptance.delete(sessionId);
		this.pendingQuestions.delete(sessionId);
		this.sessionSnapshots.delete(sessionId);
		this.lifecycleSnapshots.delete(sessionId);
	}

	private replaySnapshot(id: string, sessionId: string): void {
		const actor = this.connections.get(id)?.actor;
		if (!actor) return;
		const placeholders = this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY);
		const lifecycle = this.lifecycleSnapshots.get(sessionId);
		if (lifecycle) actor.enqueue(serializeJsonLine(observeLifecycleDelivery(JSON.parse(lifecycle.line))));
		for (const record of this.sessionSnapshots.get(sessionId) ?? [])
			actor.enqueue(placeholders ? snapshotPlaceholderLine(record) : record.line);
	}

	private resyncSnapshot(id: string, reason: ResyncReason, attached: readonly string[]): readonly object[] {
		const placeholders = this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY);
		const current = this.connectionSessions.get(id) ?? new Set<string>();
		return [...new Set([...attached, ...current])].map((sessionId) => {
			const records = this.sessionSnapshots.get(sessionId) ?? [];
			const latest = records.findLast((record) => record.hasMessage);
			// The producer may mutate its partial object after emission. The serialized
			// record, not that object, fixes the recovery cut before later deltas enqueue.
			const frozen: unknown = latest === undefined ? undefined : JSON.parse(latest.line);
			const record: RpcSessionResyncRequired = {
				type: "resync_required",
				sessionId,
				reason,
				message: typeof frozen === "object" && frozen !== null && "message" in frozen ? frozen.message : null,
				...(!current.has(sessionId) ? { closed: true as const } : {}),
			};
			return placeholders ? omitNormalInlineMedia(record) : record;
		});
	}
}
