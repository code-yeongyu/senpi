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

/** Boundary records own normalized JSON data; compact deltas keep only one full line. */
type SnapshotRecord = {
	readonly line?: string;
	readonly source?: unknown;
	readonly placeholderSource?: unknown;
	readonly rendered: boolean;
	readonly demotedLine?: string;
	readonly retainedBytes: number;
};

type SessionSnapshot = {
	readonly records: SnapshotRecord[];
	readonly strings: Map<string, string>;
	retainedBytes: number;
	latestFull?: number;
};

/**
 * Parse the already emitted wire value, never a mutable caller object or another
 * invocation of its toJSON. Equal strings from independently parsed host events
 * share one value within this active message; cumulative delta prefixes stay out
 * of this pool. The queue charge estimates UTF-16 storage and object metadata,
 * not the much larger JSON history produced by expanding these shared values.
 */
function rememberBoundary(
	snapshot: SessionSnapshot,
	line: string,
	rendered: boolean,
	placeholderLine?: string,
): SnapshotRecord {
	let retainedBytes = 64;
	const share = (_key: string, value: unknown): unknown => {
		if (typeof value === "string") {
			const existing = snapshot.strings.get(value);
			if (existing !== undefined) return existing;
			snapshot.strings.set(value, value);
			retainedBytes += 64 + value.length * 2;
		} else if (typeof value === "object" && value !== null) {
			retainedBytes += 64;
			for (const key of Object.keys(value)) retainedBytes += 32 + key.length * 2;
		}
		return value;
	};
	const source: unknown = JSON.parse(line, share);
	const placeholderSource: unknown = placeholderLine === undefined ? undefined : JSON.parse(placeholderLine, share);
	return { source, placeholderSource, rendered, retainedBytes };
}

function snapshotLine(record: SnapshotRecord, placeholders: boolean): string {
	if (record.line !== undefined) return record.line;
	if (placeholders && record.placeholderSource !== undefined) return serializeJsonLine(record.placeholderSource);
	const source = record.source;
	return serializeJsonLine(
		placeholders && typeof source === "object" && source !== null ? omitInlineMedia(source) : source,
	);
}

export class SessionEventFanout {
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly sessionSnapshots = new Map<string, SessionSnapshot>();
	private readonly pendingQuestions = new Map<string, Map<string, Record<string, unknown>>>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	private readonly connectionSessions = new Map<string, Set<string>>();
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(
		id: string,
		connection: SessionEventWriterConnection,
		options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
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
			options.stallMs,
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

	/** Deliver one line to the connections attached to a session, never to the rest of the fanout. */
	deliverToSession(sessionId: string, line: string): void {
		for (const [id, { actor }] of this.connections)
			if (this.connectionSessions.get(id)?.has(sessionId)) actor.enqueue(line);
	}

	rememberSnapshot(
		sessionId: string,
		value: Record<string, unknown>,
		line: string,
		placeholderLine?: string,
		demotedLine?: string,
	): void {
		if (value.type === "extension_ui_request" && value.method === "question" && typeof value.id === "string") {
			const pending = this.pendingQuestions.get(sessionId) ?? new Map<string, Record<string, unknown>>();
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
		if (value.type === "message_end") {
			this.sessionSnapshots.delete(sessionId);
			return;
		}
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		if (value.type === "message_start" || (value.type === "message_update" && event?.type === "text_start")) {
			this.sessionSnapshots.set(sessionId, { records: [], strings: new Map(), retainedBytes: 0 });
		}
		const snapshot = this.sessionSnapshots.get(sessionId);
		if (!snapshot) return;
		const rendered = value[RENDERED_COMPONENT_RECORD] === true;
		const record: SnapshotRecord =
			demotedLine === undefined
				? rememberBoundary(snapshot, line, rendered, placeholderLine)
				: { line, demotedLine, rendered, retainedBytes: 64 + 2 * (line.length + demotedLine.length) };
		if (demotedLine !== undefined) {
			// Keep every delta, but only the newest compact delta's cumulative snapshot.
			const previous = snapshot.latestFull === undefined ? undefined : snapshot.records[snapshot.latestFull];
			if (previous?.demotedLine !== undefined) {
				const demoted = {
					line: previous.demotedLine,
					rendered: previous.rendered,
					retainedBytes: 64 + 2 * previous.demotedLine.length,
				};
				snapshot.records[snapshot.latestFull!] = demoted;
				snapshot.retainedBytes += demoted.retainedBytes - previous.retainedBytes;
			}
			snapshot.latestFull = snapshot.records.length;
		}
		snapshot.records.push(record);
		snapshot.retainedBytes += record.retainedBytes;
	}

	forgetSession(sessionId: string): void {
		this.pendingQuestions.delete(sessionId);
		this.sessionSnapshots.delete(sessionId);
	}

	private replaySnapshot(id: string, sessionId: string): void {
		const capable = this.connectionHas(id, RENDERED_COMPONENTS_CAPABILITY);
		this.replay(
			id,
			sessionId,
			(record) => !record.rendered || capable,
			this.connectionHas(id, MEDIA_PLACEHOLDERS_CAPABILITY),
		);
	}

	private replayRendered(id: string, sessionId: string): void {
		this.replay(id, sessionId, (record) => record.rendered, false);
	}

	private replay(
		id: string,
		sessionId: string,
		include: (record: SnapshotRecord) => boolean,
		placeholders: boolean,
	): void {
		const actor = this.connections.get(id)?.actor;
		const snapshot = this.sessionSnapshots.get(sessionId);
		if (!actor || !snapshot) return;
		// Freeze the attachment's view before subsequent events replace the newest
		// full delta or clear this session. Records themselves are immutable.
		const records = snapshot.records.filter(include);
		if (records.length === 0) return;
		actor.enqueueReplay(
			(function* () {
				try {
					for (const record of records) yield snapshotLine(record, placeholders);
				} finally {
					// A closed actor may still await its current transport write.
					records.length = 0;
				}
			})(),
			snapshot.retainedBytes + 8 * records.length,
		);
	}
}
