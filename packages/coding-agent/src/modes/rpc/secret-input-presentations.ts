import type { SecretInputRoute } from "./secret-input-requests.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";
import { serializeJsonLine } from "./jsonl.ts";
import { type ConnectionLocality, RaiserNotices } from "./raiser-notices.ts";
import { type RpcRemoteOrigin, remoteOriginField } from "./remote-origin.ts";
import type { SealedAnswerReply, SealedLatch } from "./secret-input-requests.ts";
import { parseSealedAnswer } from "./secret-sealed-answers.ts";
import type { SealedHolder, SealedSecretSource } from "./secret-sealed-holders.ts";

interface SecretOwner {
	readonly session: string;
	/** The raiser route's connection; `undefined` is the sole stdio client only while `raiser` holds. */
	connection?: string;
	cancel?: () => void;
	/** The raiser route selected and its connection has not detached (D11 secret phase 5.2). */
	raiser: boolean;
	/** The sealed holders snapshotted at creation; the set never grows. */
	readonly sealed: ReadonlySet<SealedHolder>;
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
	private sealedSource?: SealedSecretSource;
	private unsubscribeSealed?: () => void;
	private readonly latches = new Map<string, SealedLatch>();
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
	/** The presenter control's sealed holders (D11 secret phase); `undefined` detaches them. */
	useSealed(source: SealedSecretSource | undefined): void {
		this.unsubscribeSealed?.();
		this.sealedSource = source;
		this.unsubscribeSealed = source?.onChange(() => this.recheck());
	}
	/** `sealed`: this route may add sealed holders (in-process sessions); a worker's route stays raiser-only. */
	route(session: string, sealed = false): SecretInputRoute {
		const capable = (connection: string | undefined) => this.capable(connection);
		let bound: SealedLatch | undefined;
		return {
			presenter: (id) => this.owners.get(id)?.connection,
			select: (id, cancel) => {
				const preferred = this.current();
				const attached = this.fanout.attachedConnections(session);
				let refused: "client_unsupported" | "no_presenter" | undefined;
				const connection = preferred ?? attached.find((candidate) => capable(candidate) && this.local(candidate));
				if (preferred !== undefined && (!attached.includes(preferred) || !capable(preferred)))
					refused = "client_unsupported";
				else if (connection === undefined && !(this.fanout.isEmpty() && capable(undefined)))
					refused = this.fanout.isEmpty() ? "client_unsupported" : "no_presenter";
				const holders = sealed ? this.sealedSource?.holders(session) : undefined;
				if (refused !== undefined && !holders?.size) return refused;
				const origin = preferred === undefined ? undefined : this.locality.originOf(preferred);
				this.owners.set(id, {
					session,
					...(refused === undefined ? { connection } : {}),
					cancel,
					raiser: refused === undefined,
					sealed: holders ?? new Set(),
					background: preferred === undefined,
					raisedBy: preferred ?? "agent",
					...(origin === undefined ? {} : { origin }),
				});
				return undefined;
			},
			accepts: (id) => {
				const owner = this.owners.get(id);
				return (
					owner?.session === session && owner.raiser && owner.connection === this.current() && this.live(owner)
				);
			},
			available: (id) => {
				const owner = this.owners.get(id);
				return owner?.session === session && this.available(owner);
			},
			sealed: (id) => (this.owners.get(id)?.sealed.size ?? 0) > 0,
			raiser: (id) => this.owners.get(id)?.raiser === true,
			sealedOutcome: (id, outcome, winner) => {
				const owner = this.owners.get(id);
				if (owner?.session === session && owner.sealed.size > 0)
					this.sealedSource?.settle(owner.sealed, id, outcome, winner);
			},
			bindSealedResponder: (latch) => {
				// Unbinding removes only this route's own latch: a late exit must not clear a newer binding's.
				if (!latch) {
					if (bound !== undefined && this.latches.get(session) === bound) this.latches.delete(session);
					bound = undefined;
				} else if (sealed) {
					bound = latch;
					this.latches.set(session, latch);
				}
			},
			offerSealed: (id, offer) => {
				const owner = this.owners.get(id);
				if (owner?.session === session && owner.sealed.size > 0)
					this.sealedSource?.offer(session, owner.sealed, { uiRequestId: id, ...offer });
			},
			send: (id, record) => {
				const owner = this.owners.get(id);
				if (owner?.session === session) this.notify(id, owner, record);
				if (!owner || owner.session !== session || !this.available(owner)) {
					owner?.cancel?.();
					return;
				}
				// A sealed-only request never writes a raiser lane, the sole stdio lane included (5.2).
				if (!owner.raiser || !this.live(owner)) return;
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
				this.sealedSource?.withdraw(id);
			},
			forget: (id) => {
				this.owners.delete(id);
				this.sealedSource?.withdraw(id);
			},
			handshake: (capabilities) => {
				if (this.current() === undefined) this.handshake(capabilities);
			},
		};
	}
	/**
	 * An `mcp_presenter_secret_answer` from `connection` (design 7.1): the shape, then the sender must hold a grant in
	 * the request's sealed snapshot that is still eligible, then the authority's checks; the session's latch decides.
	 */
	async answerSealed(connection: string, value: unknown): Promise<SealedAnswerReply> {
		const frame = parseSealedAnswer(value);
		if (!frame) return { error: "invalid_secret_response" };
		const owner = this.owners.get(frame.uiRequestId);
		const source = this.sealedSource;
		const holder =
			owner && source
				? [...owner.sealed].find((grant) => grant.id === frame.grantId && source.connectionOf(grant) === connection)
				: undefined;
		const latch = owner && this.latches.get(owner.session);
		if (!owner || !source || !holder || !latch || !source.eligible(holder)) return { error: "secret_answer_refused" };
		const principal = source.principalOf(holder);
		const settled = principal === undefined ? undefined : latch.settled(frame.uiRequestId, frame.answerId, principal);
		if (settled) return settled;
		const checked = await source.answer(holder, frame);
		if ("error" in checked || "disposition" in checked) return checked;
		return latch.respond(checked, {
			current: () => source.eligible(holder),
			admitJti: (jti, exp) => source.admitJti(jti, exp),
		});
	}
	recheck(): void {
		for (const owner of this.owners.values()) if (!this.available(owner)) owner.cancel?.();
	}
	/** The raiser leaves; the request ends only when no sealed holder is current either (5.2, gate r2 L1). */
	detach(connection: string): void {
		for (const [id, owner] of this.owners)
			if (owner.connection === connection) {
				owner.raiser = false;
				owner.connection = undefined;
				if (this.available(owner)) continue;
				owner.cancel?.();
				this.owners.delete(id);
			}
	}
	/** The prompt's title and deadline reach non-presenters as a notice; its value, answer id and receipt never do. */
	private notify(id: string, owner: SecretOwner, record: object): void {
		const type = Reflect.get(record, "type");
		if (type === "extension_ui_request" && this.available(owner))
			this.notices.raised(owner.session, id, [owner.connection, ...this.holderConnections(owner)], {
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
	private available(owner: SecretOwner): boolean {
		return (
			(owner.raiser && this.live(owner)) ||
			[...owner.sealed].some((holder) => this.sealedSource?.current(holder) === true)
		);
	}
	private holderConnections(owner: SecretOwner): string[] {
		const source = this.sealedSource;
		return source ? [...owner.sealed].map((holder) => source.connectionOf(holder)) : [];
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
