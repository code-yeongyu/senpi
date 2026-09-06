import { MEDIA_PLACEHOLDERS_CAPABILITY, RENDERED_COMPONENTS_CAPABILITY } from "./custom-capability.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { omitInlineMedia } from "./media-placeholders.ts";
import { SocketEventSinkActor } from "./socket-event-fanout.ts";

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

export const RENDERED_COMPONENT_RECORD = "__senpiRenderedComponent";

const BROADCAST_LIFECYCLE_RECORDS = new Set([
	"agent_start",
	"agent_settled",
	"agent_idle",
	"session_opened",
	"session_closed",
]);

type RegisteredConnection = {
	readonly connection: SessionEventWriterConnection;
	readonly actor: SocketEventSinkActor;
};

/**
 * A replayable snapshot line.
 *
 * `placeholderLine` is the `media_placeholders` variant. The writer supplies it only when
 * a capable connection was already attached when the record was emitted; a connection that
 * attaches later still needs it, so `source` carries the wire record and the variant is
 * derived once, on the first capable replay, then memoized. Records with no media resolve
 * `placeholderLine` to `line`, so replay stays O(1) and never re-serializes twice.
 */
type SnapshotRecord = {
	readonly line: string;
	placeholderLine?: string;
	readonly source?: Record<string, unknown>;
	readonly rendered: boolean;
};

/** The placeholder variant of a remembered record, derived and memoized on first use. */
function snapshotPlaceholderLine(record: SnapshotRecord): string {
	if (record.placeholderLine !== undefined) return record.placeholderLine;
	const redacted = record.source === undefined ? undefined : omitInlineMedia(record.source);
	record.placeholderLine =
		redacted === undefined || redacted === record.source ? record.line : serializeJsonLine(redacted);
	return record.placeholderLine;
}

export class SessionEventFanout {
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly sessionSnapshots = new Map<string, SnapshotRecord[]>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	private readonly connectionSessions = new Map<string, Set<string>>();
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number } = {},
	): void {
		const actor = new SocketEventSinkActor(
			connection,
			(cause) => {
				if (this.connections.get(id)?.actor === actor) {
					this.connections.delete(id);
					this.connectionCapabilities.delete(id);
					this.connectionSessions.delete(id);
					this.registeredCapabilityConnections.delete(id);
				}
				process.stderr.write(
					`senpi rpc connection ${id} event queue failed; closing: ${cause instanceof Error ? cause.message : String(cause)}\n`,
				);
				connection.close?.();
			},
			options.maxQueueBytes,
		);
		this.connections.set(id, { connection, actor });
		this.connectionCapabilities.set(id, new Set());
		this.connectionSessions.set(id, new Set());
	}

	unregisterConnection(id: string): void {
		const registered = this.connections.get(id);
		if (!registered) return;
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
	}

	detachConnectionFromSession(id: string, sessionId: string): void {
		this.connectionSessions.get(id)?.delete(sessionId);
	}

	setConnectionCapabilities(id: string, capabilities: readonly string[]): void {
		const registered = this.connections.get(id);
		if (!registered) return;
		const wasCapable = this.connectionCapabilities.get(id)?.has(RENDERED_COMPONENTS_CAPABILITY) ?? false;
		this.connectionCapabilities.set(id, new Set(capabilities));
		this.registeredCapabilityConnections.add(id);
		if (!wasCapable && capabilities.includes(RENDERED_COMPONENTS_CAPABILITY))
			for (const sessionId of this.connectionSessions.get(id) ?? []) this.replayRendered(id, sessionId);
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

	hasCapableConnection(sessionId: string): boolean {
		for (const id of this.connectionCapabilities.keys())
			if (this.connectionHas(id, RENDERED_COMPONENTS_CAPABILITY) && this.connectionSessions.get(id)?.has(sessionId))
				return true;
		return false;
	}

	/** Whether a connection advertised a capability. The only capability lookup in this file. */
	connectionHas(id: string | undefined, capability: string): boolean {
		return id === undefined ? false : (this.connectionCapabilities.get(id)?.has(capability) ?? false);
	}

	targets(
		sessionId: string,
		targetId: string | undefined,
		isTargeted: boolean,
		rendered: boolean,
		recordType: unknown,
	): readonly (string | undefined)[] {
		if (isTargeted) return [targetId];
		if (typeof recordType === "string" && BROADCAST_LIFECYCLE_RECORDS.has(recordType))
			return this.connections.size > 0 ? [...this.connections.keys()] : [undefined];
		if (rendered)
			return this.connections.size > 0
				? [...this.connections.keys()].filter(
						(id) =>
							this.connectionHas(id, RENDERED_COMPONENTS_CAPABILITY) &&
							this.connectionSessions.get(id)?.has(sessionId),
					)
				: [undefined];
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

	rememberSnapshot(
		sessionId: string,
		value: Record<string, unknown>,
		line: string,
		placeholderLine?: string,
		source?: Record<string, unknown>,
	): void {
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		const record: SnapshotRecord = {
			line,
			placeholderLine,
			source,
			rendered: value[RENDERED_COMPONENT_RECORD] === true,
		};
		if (value.type === "message_start" || (value.type === "message_update" && event?.type === "text_start")) {
			this.sessionSnapshots.set(sessionId, [record]);
		} else if (this.sessionSnapshots.has(sessionId)) {
			this.sessionSnapshots.get(sessionId)?.push(record);
		}
		if (value.type === "message_end") this.sessionSnapshots.delete(sessionId);
	}

	forgetSession(sessionId: string): void {
		this.sessionSnapshots.delete(sessionId);
	}

	private replaySnapshot(id: string, sessionId: string): void {
		const actor = this.connections.get(id)?.actor;
		if (!actor) return;
		const capable = this.connectionHas(id, RENDERED_COMPONENTS_CAPABILITY);
		const placeholders = this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY);
		for (const record of this.sessionSnapshots.get(sessionId) ?? [])
			if (!record.rendered || capable) actor.enqueue(placeholders ? snapshotPlaceholderLine(record) : record.line);
	}

	private replayRendered(id: string, sessionId: string): void {
		const actor = this.connections.get(id)?.actor;
		if (!actor) return;
		for (const record of this.sessionSnapshots.get(sessionId) ?? []) if (record.rendered) actor.enqueue(record.line);
	}
}
