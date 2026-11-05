import type { SecretInputRoute } from "./secret-input-requests.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { type ConnectionLocality, RaiserNotices } from "./raiser-notices.ts";
import { type RpcRemoteOrigin, remoteOriginField } from "./remote-origin.ts";

interface SecretOwner {
	readonly session: string;
	readonly connection?: string;
	cancel?: () => void;
	/** No connection raised it: the host picked a local presenter (D11 S3-5), never a delegated or remote one. */
	readonly background: boolean;
	readonly raisedBy: string;
	readonly origin?: RpcRemoteOrigin;
}

/** Private presenter records contain identities only; output bypasses every replay and observer lane. */
export class SecretInputPresentations {
	private readonly fanout: SessionEventFanout;
	private readonly current: () => string | undefined;
	private readonly writeSole: (line: string) => void;
	private readonly flush: () => void;
	private readonly locality: ConnectionLocality;
	private readonly notices: RaiserNotices;
	private readonly owners = new Map<string, SecretOwner>();
	private soleCapabilities: readonly string[] = [];
	constructor(
		fanout: SessionEventFanout,
		current: () => string | undefined,
		writeSole: (line: string) => void,
		flush: () => void,
		locality: ConnectionLocality,
	) {
		this.fanout = fanout;
		this.current = current;
		this.writeSole = writeSole;
		this.flush = flush;
		this.locality = locality;
		this.notices = new RaiserNotices(fanout, flush);
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
				const connection = preferred ?? attached.find((candidate) => capable(candidate) && this.local(candidate));
				if (connection === undefined && !(this.fanout.isEmpty() && capable(undefined)))
					return this.fanout.isEmpty() ? "client_unsupported" : "no_presenter";
				const origin = preferred === undefined ? undefined : this.locality.originOf(preferred);
				this.owners.set(id, {
					session,
					connection,
					cancel,
					background: preferred === undefined,
					raisedBy: preferred ?? "agent",
					...(origin === undefined ? {} : { origin }),
				});
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
				if (owner?.session === session) this.notify(id, owner, record);
				if (!owner || owner.session !== session || !this.live(owner)) {
					owner?.cancel?.();
					return;
				}
				const line = serializeJsonLine({ ...record, sessionId: session });
				if (owner.connection === undefined) this.writeSole(line);
				else
					this.fanout
						.get(owner.connection)
						?.actor.enqueue(
							line,
							undefined,
							undefined,
							undefined,
							true,
							undefined,
							() =>
								this.owners.get(id) === owner &&
								this.live(owner) &&
								(!("type" in record && record.type === "extension_ui_request") || owner.cancel !== undefined),
						);
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
	/** The prompt's title and deadline reach non-presenters as a notice; its value, answer id and receipt never do. */
	private notify(id: string, owner: SecretOwner, record: object): void {
		const type = Reflect.get(record, "type");
		if (type === "extension_ui_request" && this.live(owner))
			this.notices.raised(owner.session, id, owner.connection, {
				type: "secret_input_notice",
				title: Reflect.get(record, "title"),
				deadlineAtMs: Reflect.get(record, "deadlineAtMs"),
				raisedBy: owner.raisedBy,
				...remoteOriginField(owner.origin),
			});
		else if (type === "secret_input_settled")
			this.notices.settled(owner.session, id, {
				type: "secret_input_notice_settled",
				outcome: Reflect.get(record, "outcome"),
			});
	}
	private local(connection: string): boolean {
		return !this.locality.isRemote(connection);
	}
	private capable(connection: string | undefined): boolean {
		const caps = connection === undefined ? this.soleCapabilities : this.fanout.getConnectionCapabilities(connection);
		return caps?.includes("secret_input_v1") === true && caps.includes("interactive_user");
	}
	private live(owner: SecretOwner): boolean {
		return (
			this.capable(owner.connection) &&
			(owner.connection === undefined
				? this.fanout.isEmpty()
				: this.fanout.attachedConnections(owner.session).includes(owner.connection) &&
					(!owner.background || this.local(owner.connection)))
		);
	}
}
