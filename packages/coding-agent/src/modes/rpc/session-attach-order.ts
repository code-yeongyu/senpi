/**
 * When each connection first attached to each session, so the router can name "the earliest-attached connection of
 * THIS session" (docs/rpc.md, session relocation), not the connection that happened to open some other session first.
 */
export class SessionAttachOrder {
	private next = 0;
	private readonly order = new Map<string, Map<string, number>>();

	/** Records `connection`'s first attachment to `sessionId`; a repeated attach keeps its original place. */
	attached(sessionId: string, connection: string): void {
		const connections = this.order.get(sessionId) ?? new Map<string, number>();
		if (!connections.has(connection)) connections.set(connection, this.next++);
		this.order.set(sessionId, connections);
	}

	detached(sessionId: string, connection: string): void {
		const connections = this.order.get(sessionId);
		connections?.delete(connection);
		if (connections?.size === 0) this.order.delete(sessionId);
	}

	forgetSession(sessionId: string): void {
		this.order.delete(sessionId);
	}

	/** The session's attached connections, earliest first. */
	connections(sessionId: string): string[] {
		return [...(this.order.get(sessionId) ?? new Map<string, number>()).entries()]
			.sort((left, right) => left[1] - right[1])
			.map(([connection]) => connection);
	}
}
