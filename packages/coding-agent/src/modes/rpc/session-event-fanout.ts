import { SocketEventSinkActor } from "./socket-event-fanout.ts";

export type RawWriter = (chunk: string) => void;
export type BackpressureWaiter = () => Promise<void>;

export interface SessionEventWriterConnection {
	readonly writeRaw: RawWriter;
	readonly waitForBackpressure: BackpressureWaiter;
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

type SnapshotRecord = { readonly line: string; readonly rendered: boolean };

export class SessionEventFanout {
	private readonly connections = new Map<string, RegisteredConnection>();
	private readonly sessionSnapshots = new Map<string, SnapshotRecord[]>();
	private readonly connectionCapabilities = new Map<string, Set<string>>();
	private readonly connectionSessions = new Map<string, Set<string>>();
	private readonly registeredCapabilityConnections = new Set<string>();

	registerConnection(id: string, connection: SessionEventWriterConnection): void {
		const actor = new SocketEventSinkActor(connection, () => {
			if (this.connections.get(id)?.actor === actor) {
				this.connections.delete(id);
				this.connectionCapabilities.delete(id);
				this.connectionSessions.delete(id);
				this.registeredCapabilityConnections.delete(id);
			}
		});
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
		const wasCapable = this.connectionCapabilities.get(id)?.has("rendered_components") ?? false;
		this.connectionCapabilities.set(id, new Set(capabilities));
		this.registeredCapabilityConnections.add(id);
		if (!wasCapable && capabilities.includes("rendered_components"))
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
		for (const [id, capabilities] of this.connectionCapabilities)
			if (capabilities.has("rendered_components") && this.connectionSessions.get(id)?.has(sessionId)) return true;
		return false;
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
							this.connectionCapabilities.get(id)?.has("rendered_components") &&
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

	rememberSnapshot(sessionId: string, value: Record<string, unknown>, line: string): void {
		const event = value.assistantMessageEvent as Record<string, unknown> | undefined;
		const record = { line, rendered: value[RENDERED_COMPONENT_RECORD] === true };
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
		const capable = this.connectionCapabilities.get(id)?.has("rendered_components") ?? false;
		for (const record of this.sessionSnapshots.get(sessionId) ?? [])
			if (!record.rendered || capable) actor.enqueue(record.line);
	}

	private replayRendered(id: string, sessionId: string): void {
		const actor = this.connections.get(id)?.actor;
		if (!actor) return;
		for (const record of this.sessionSnapshots.get(sessionId) ?? []) if (record.rendered) actor.enqueue(record.line);
	}
}
