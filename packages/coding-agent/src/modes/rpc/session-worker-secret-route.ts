import type { SecretInputUnavailableReason } from "../../core/extensions/secret-input.ts";
import { PresenterJtiCache } from "./mcp-presenter-attestation.ts";
import type {
	SealedAnswer,
	SealedAnswerReply,
	SealedLatch,
	SecretInputOutcome,
	SecretInputRoute,
} from "./secret-input-requests.ts";
import type { SessionWorkerToHost } from "./session-worker-protocol.ts";

type Exchange = (message: (signal: SharedArrayBuffer) => SessionWorkerToHost) => void;

type SelectResult =
	| { accepted: true; connection?: string; raiser: boolean; sealed: boolean }
	| { accepted: false; reason: SecretInputUnavailableReason };

/**
 * A worker isolate's secret-prompt route (senpi#5192; D11 secret phase 5.5). The host selects the presenter and
 * authenticates sealed answers; this isolate keeps the latch, the per-request key, the receipts and the step-up `jti`
 * cache, and claims, opens and settles here.
 */
export class WorkerSecretRoutes {
	readonly cancels = new Map<string, () => void>();
	private latch?: SealedLatch;
	/** Step-up `jti`s admitted beside the receipts, after the replay check (5.5, gate r2 L2). */
	private readonly jtis = new PresenterJtiCache();
	private readonly exchange: Exchange;
	private readonly currentConnection: () => string | undefined;

	constructor(exchange: Exchange, currentConnection: () => string | undefined) {
		this.exchange = exchange;
		this.currentConnection = currentConnection;
	}

	route(): SecretInputRoute {
		const presenters = new Map<string, { connection?: string; raiser: boolean; sealed: boolean }>();
		const outcomes = new Map<string, { outcome: SecretInputOutcome; winnerGrant?: string }>();
		return {
			select: (id, unavailable) => {
				const decision = new SharedArrayBuffer(8192);
				this.exchange((signal) => ({
					type: "secret_select",
					id,
					connection: this.currentConnection(),
					decision,
					signal,
				}));
				const length = new Int32Array(decision, 0, 1)[0];
				const result = JSON.parse(new TextDecoder().decode(new Uint8Array(decision, 4, length))) as SelectResult;
				if (!result.accepted) return result.reason;
				presenters.set(id, { connection: result.connection, raiser: result.raiser, sealed: result.sealed });
				this.cancels.set(id, unavailable);
				return undefined;
			},
			presenter: (id) => presenters.get(id)?.connection,
			// The host authorizes the actual sender before forwarding a response into this isolate; a sealed-only
			// request has no raiser and accepts no forwarded response, not even on the sole lane (5.5).
			accepts: (id) => {
				const presenter = presenters.get(id);
				return presenter?.raiser === true && presenter.connection === this.currentConnection();
			},
			available: (id) => presenters.has(id),
			sealed: (id) => presenters.get(id)?.sealed === true,
			raiser: (id) => presenters.get(id)?.raiser === true,
			// Every frame still reaches the host, which counts open requests by them; the host's own route writes no
			// raiser lane for a request that has no raiser.
			send: (id, record) => this.exchange((signal) => ({ type: "secret_frame", id, record, signal })),
			offerSealed: (id, offer) =>
				this.exchange((signal) => ({
					type: "secret_frame",
					id,
					record: { type: "secret_sealed_offer", ...offer },
					signal,
				})),
			sealedOutcome: (id, outcome, winnerGrant) =>
				outcomes.set(id, { outcome, ...(winnerGrant === undefined ? {} : { winnerGrant }) }),
			bindSealedResponder: (latch) => {
				this.latch = latch;
			},
			settled: (id) => {
				this.cancels.delete(id);
				const settle = outcomes.get(id);
				outcomes.delete(id);
				this.exchange((signal) => ({ type: "secret_settled", id, signal, ...settle }));
			},
			forget: (id) => {
				this.cancels.delete(id);
				presenters.delete(id);
				outcomes.delete(id);
				this.exchange((signal) => ({ type: "secret_forget", id, signal }));
			},
			handshake: (capabilities) => {
				if (this.currentConnection() === undefined)
					this.exchange((signal) => ({ type: "secret_handshake", capabilities, signal }));
			},
		};
	}

	/**
	 * 7.1 steps 3 and 6 for an answer the host authenticated, at this isolate's latch. The grant check is the host's
	 * step 2 followed by this one request (5.5): the isolate has no grants.
	 */
	answer(answer: SealedAnswer): SealedAnswerReply | Promise<SealedAnswerReply> {
		const latch = this.latch;
		if (!latch) return { error: "secret_answer_refused" };
		return (
			latch.settled(answer.uiRequestId, answer.answerId, answer.principal) ??
			latch.respond(answer, {
				current: () => true,
				admitJti: (jti, exp) => this.jtis.admit(jti, exp, Math.floor(Date.now() / 1000)) === "ok",
			})
		);
	}
}
