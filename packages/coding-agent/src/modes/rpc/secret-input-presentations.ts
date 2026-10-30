import type { SecretInputRoute } from "./secret-input-requests.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";
import { serializeJsonLine } from "./jsonl.ts";

/** Private presenter records contain identities only; output bypasses every replay and observer lane. */
export class SecretInputPresentations {
	private readonly fanout: SessionEventFanout;
	private readonly current: () => string | undefined;
	private readonly writeSole: (line: string) => void;
	private readonly flush: () => void;
	private readonly owners = new Map<string, { session: string; connection?: string; cancel?: () => void }>();
	private soleCapabilities: readonly string[] = [];
	constructor(
		fanout: SessionEventFanout,
		current: () => string | undefined,
		writeSole: (line: string) => void,
		flush: () => void,
	) {
		this.fanout = fanout;
		this.current = current;
		this.writeSole = writeSole;
		this.flush = flush;
	}

	handshake(capabilities: readonly string[]): void {
		this.soleCapabilities = [...capabilities];
		this.recheck();
	}
	route(session: string): SecretInputRoute {
		const capable = (connection: string | undefined) => this.capable(connection);
		return {
			presenter: (id) => this.owners.get(id)?.connection,
			select: (id, cancel) => {
				const preferred = this.current();
				const attached = this.fanout.attachedConnections(session);
				if (preferred !== undefined && (!attached.includes(preferred) || !capable(preferred)))
					return "client_unsupported";
				const connection = preferred ?? attached.find(capable);
				if (connection === undefined && !(this.fanout.isEmpty() && capable(undefined)))
					return this.fanout.isEmpty() ? "client_unsupported" : "no_presenter";
				this.owners.set(id, { session, connection, cancel });
				return undefined;
			},
			accepts: (id) => {
				const owner = this.owners.get(id);
				return owner?.session === session && owner.connection === this.current() && this.live(owner);
			},
			available: (id) => {
				const owner = this.owners.get(id);
				return owner?.session === session && this.live(owner);
			},
			send: (id, record) => {
				const owner = this.owners.get(id);
				if (!owner || owner.session !== session || !this.live(owner)) {
					owner?.cancel?.();
					return;
				}
				const line = serializeJsonLine({ ...record, sessionId: session });
				if (owner.connection === undefined) this.writeSole(line);
				else this.fanout.get(owner.connection)?.actor.enqueue(line);
				this.flush();
			},
			settled: (id) => {
				const owner = this.owners.get(id);
				if (owner) owner.cancel = undefined;
			},
			forget: (id) => {
				this.owners.delete(id);
			},
			handshake: (capabilities) => {
				if (this.current() === undefined) this.handshake(capabilities);
			},
		};
	}
	recheck(): void {
		for (const owner of this.owners.values()) if (!this.live(owner)) owner.cancel?.();
	}
	detach(connection: string): void {
		for (const [id, owner] of this.owners)
			if (owner.connection === connection) {
				owner.cancel?.();
				this.owners.delete(id);
			}
	}
	private capable(connection: string | undefined): boolean {
		const caps = connection === undefined ? this.soleCapabilities : this.fanout.getConnectionCapabilities(connection);
		return caps?.includes("secret_input_v1") === true && caps.includes("interactive_user");
	}
	private live(owner: { session: string; connection?: string }): boolean {
		return (
			this.capable(owner.connection) &&
			(owner.connection === undefined
				? this.fanout.isEmpty()
				: this.fanout.attachedConnections(owner.session).includes(owner.connection))
		);
	}
}
