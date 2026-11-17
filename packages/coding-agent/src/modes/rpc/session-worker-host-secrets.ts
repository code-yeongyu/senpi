import type {
	SealedAnswer,
	SealedAnswerReply,
	SealedClaim,
	SecretInputOutcome,
	SecretInputRoute,
} from "./secret-input-requests.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { HostToSessionWorker, SessionWorkerToHost } from "./session-worker-protocol.ts";
import type { WorkerRequestInput } from "./session-worker-requests.ts";
import { isSealedOffer, WorkerSecretIds } from "./session-worker-secrets.ts";
import { acknowledge } from "./session-worker-signals.ts";

type Reply = Extract<SessionWorkerToHost, { request: number }>;

/** The most answers for one request in flight or queued toward the isolate (D11 secret phase 5.5). */
const SEALED_ANSWERS_PER_ID = 5;
const OUTCOMES: ReadonlySet<SecretInputOutcome> = new Set(["answered", "cancelled", "timed_out", "unavailable"]);
type ReplyError = Extract<SealedAnswerReply, { error: string }>["error"];
const REPLY_ERRORS: ReadonlySet<string> = new Set<ReplyError>([
	"already_answered",
	"unknown_extension_ui_request",
	"secret_stepup_refused",
	"invalid_secret_response",
	"secret_answer_refused",
]);

const isReplyError = (error: string): error is ReplyError => REPLY_ERRORS.has(error);

/** The isolate's reply is untrusted (#5192): only the shapes its latch can produce pass, rebuilt field by field. */
function isolateReply(value: unknown): SealedAnswerReply {
	if (typeof value !== "object" || value === null) return { error: "secret_answer_refused" };
	const disposition = "disposition" in value ? value.disposition : undefined;
	if (disposition === "applied" || disposition === "replay") return { disposition };
	const error = "error" in value ? value.error : undefined;
	if (typeof error === "string" && isReplyError(error)) return { error };
	return { error: "secret_answer_refused" };
}

interface HostSecretsDeps {
	readonly post: (message: HostToSessionWorker) => void;
	readonly request: (message: WorkerRequestInput) => Promise<Reply>;
}

/**
 * The host half of one worker isolate's secret prompts (senpi#5192; D11 secret phase 5.5): the route selection the
 * isolate asks for, its bounded frames, and sealed answers forwarded to the isolate's latch after the host
 * authenticated them.
 */
export class WorkerHostSecrets {
	private route?: SecretInputRoute;
	private writer?: SessionEventWriter;
	private readonly ids = new WorkerSecretIds();
	private readonly queue = new Map<string, { tail: Promise<void>; depth: number }>();
	/** Grants whose sealed answer the host forwarded, per id: the only grants an isolate may name as the winner. */
	private readonly forwarded = new Map<string, Set<string>>();
	private readonly settledIds = new Set<string>();
	private readonly deps: HostSecretsDeps;

	constructor(deps: HostSecretsDeps) {
		this.deps = deps;
	}

	bind(sessionId: string, writer: SessionEventWriter): void {
		this.writer = writer;
		this.route = writer.secretInputRoute(sessionId, true);
		this.route.bindSealedResponder?.({
			settled: () => undefined,
			respond: (answer, claim) => this.forward(answer, claim),
		});
	}

	/** A forwarded `extension_ui_response` for one of this isolate's secrets that its route does not accept. */
	refuses(uiRequestId: string): boolean {
		return this.ids.has(uiRequestId) && this.route?.accepts(uiRequestId) !== true;
	}

	exited(): void {
		this.route?.bindSealedResponder?.(undefined);
		// A request the isolate never settled ends with it: its sealed holders are told, then it is forgotten.
		for (const id of this.ids.ids())
			if (!this.settledIds.has(id)) {
				this.route?.sealedOutcome?.(id, "unavailable", undefined);
				this.route?.settled(id);
			}
		for (const id of this.ids.ids()) this.route?.forget(id);
		this.ids.clear();
		this.forwarded.clear();
		this.settledIds.clear();
	}

	receive(message: SessionWorkerToHost): boolean {
		switch (message.type) {
			case "secret_select":
				this.select(message);
				return true;
			case "secret_frame":
				// A record that claims to be a sealed offer but is malformed is refused, never relayed as a raiser frame.
				if (
					("type" in message.record &&
						message.record.type === "secret_sealed_offer" &&
						!isSealedOffer(message.record)) ||
					!this.ids.admitFrame(message.id, message.record)
				) {
					acknowledge(message.signal, false);
					return true;
				}
				if (isSealedOffer(message.record)) {
					const { hpkePk, title, placeholder, deadlineAtMs } = message.record;
					this.route?.offerSealed?.(message.id, { hpkePk, title, placeholder, deadlineAtMs });
				} else this.route?.send(message.id, message.record);
				acknowledge(message.signal, true);
				return true;
			case "secret_settled":
				// The isolate's settle is untrusted (#5192): one per held id, a known outcome, and a winner only among
				// the grants whose answers the host forwarded for that id.
				if (!this.admitsSettle(message)) {
					acknowledge(message.signal, false);
					return true;
				}
				this.settledIds.add(message.id);
				if (message.outcome !== undefined)
					this.route?.sealedOutcome?.(message.id, message.outcome, message.winnerGrant);
				this.route?.settled(message.id);
				acknowledge(message.signal, true);
				return true;
			case "secret_forget":
				this.ids.forget(message.id);
				this.forwarded.delete(message.id);
				this.settledIds.delete(message.id);
				this.route?.forget(message.id);
				acknowledge(message.signal, true);
				return true;
			case "secret_handshake":
				this.writer?.setSoleSecretCapabilities(message.capabilities);
				acknowledge(message.signal, true);
				return true;
			default:
				return false;
		}
	}

	private select(message: Extract<SessionWorkerToHost, { type: "secret_select" }>): void {
		if (!this.ids.has(message.id) && !this.ids.admitsNew()) {
			acknowledge(message.signal, false);
			return;
		}
		const select = () => {
			const route = this.route;
			const reason =
				route?.select(message.id, () => this.deps.post({ type: "cancel_secret", id: message.id })) ??
				(route ? undefined : "no_presenter");
			if (reason === undefined) this.ids.add(message.id);
			const result =
				reason === undefined
					? {
							accepted: true,
							connection: route?.presenter(message.id),
							raiser: route?.raiser?.(message.id) ?? true,
							sealed: route?.sealed?.(message.id) ?? false,
						}
					: { accepted: false, reason };
			const encoded = new TextEncoder().encode(JSON.stringify(result));
			new Uint8Array(message.decision, 4).set(encoded);
			Atomics.store(new Int32Array(message.decision, 0, 1), 0, encoded.length);
			acknowledge(message.signal, true);
		};
		if (message.connection !== undefined && this.writer) this.writer.withConnection(message.connection, select);
		else select();
	}

	private admitsSettle(message: Extract<SessionWorkerToHost, { type: "secret_settled" }>): boolean {
		const { id, outcome, winnerGrant } = message;
		if (!this.ids.has(id) || this.settledIds.has(id)) return false;
		if (outcome !== undefined && !OUTCOMES.has(outcome)) return false;
		const decided = outcome === "answered" || outcome === "cancelled";
		return winnerGrant === undefined || (decided && this.forwarded.get(id)?.has(winnerGrant) === true);
	}

	/** Only for ids the isolate holds; one in flight and four queued per id, beyond that `secret_answer_refused`. */
	private forward(answer: SealedAnswer, claim: SealedClaim): Promise<SealedAnswerReply> {
		const id = answer.uiRequestId;
		const queued = this.queue.get(id);
		if (!this.ids.has(id) || (queued?.depth ?? 0) >= SEALED_ANSWERS_PER_ID)
			return Promise.resolve({ error: "secret_answer_refused" });
		const run = async (): Promise<SealedAnswerReply> => {
			// The grant is re-checked when the answer leaves the queue: it may have been revoked while it waited.
			if (!claim.current()) return { error: "secret_answer_refused" };
			const forwarded = this.forwarded.get(id) ?? new Set<string>();
			forwarded.add(answer.grantId);
			this.forwarded.set(id, forwarded);
			const reply = await this.deps.request({ type: "secret_sealed_answer", answer });
			return reply.type === "secret_sealed_result" ? isolateReply(reply.reply) : { error: "secret_answer_refused" };
		};
		const result = (queued?.tail ?? Promise.resolve())
			.then(run)
			.catch((): SealedAnswerReply => ({ error: "secret_answer_refused" }));
		const entry = { tail: result.then(() => undefined), depth: (queued?.depth ?? 0) + 1 };
		this.queue.set(id, entry);
		void result.finally(() => {
			const current = this.queue.get(id);
			if (current === entry) this.queue.delete(id);
			else if (current) current.depth--;
		});
		return result;
	}
}
