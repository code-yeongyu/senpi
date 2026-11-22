import type { ExtensionUIInputOptions } from "../../core/extensions/types.ts";
import {
	type SealedAnswerReply,
	type SealedLatch,
	SecretInputRequests,
	type SecretInputRoute,
} from "../rpc/secret-input-requests.ts";
import { answerSealedFrame } from "../rpc/secret-sealed-answer-route.ts";
import type { SealedHolder, SealedSecretSource } from "../rpc/secret-sealed-holders.ts";

/**
 * A TUI session's own secret prompts offered, sealed, to its same-account presenters (D11 secret phase, S3-6b parity).
 * The terminal stays the raiser: its local input and every sealed holder race one latch, and the first answer wins.
 * Only the terminal process opens an answer, with the request key its latch holds.
 */
export class TerminalSealedSecrets {
	readonly requests: SecretInputRequests;
	private readonly owners = new Map<string, ReadonlySet<SealedHolder>>();
	private latch?: SealedLatch;
	private readonly source: SealedSecretSource;
	private readonly sessionId: string;
	private readonly unsubscribe: () => void;

	constructor(source: SealedSecretSource, sessionId: string, admit: () => void) {
		this.source = source;
		this.sessionId = sessionId;
		this.requests = new SecretInputRequests(this.route(), admit);
		this.unsubscribe = source.onChange(() => this.requests.recheck());
	}

	/** A sealed request for a prompt the terminal raises, or `undefined` when the session has no sealed holder. */
	open(
		title: string,
		placeholder: string | undefined,
		opts: ExtensionUIInputOptions | undefined,
	): { readonly id: string; readonly result: Promise<string | undefined> } | undefined {
		let id: string | undefined;
		const result = this.requests.input(title, placeholder, opts, (created) => {
			id = created;
		});
		if (id === undefined) {
			result.catch(() => undefined);
			return undefined;
		}
		return { id, result };
	}

	receive(connection: string, frame: unknown): Promise<SealedAnswerReply> {
		return answerSealedFrame(connection, frame, this.source, (id) => {
			const sealed = this.owners.get(id);
			return sealed && { sealed, latch: this.latch };
		});
	}

	dispose(): void {
		this.unsubscribe();
		this.requests.close();
	}

	private route(): SecretInputRoute {
		return {
			select: (id) => {
				const holders = this.source.holders(this.sessionId);
				if (holders.size === 0) return "no_presenter";
				this.owners.set(id, holders);
				return undefined;
			},
			// The terminal answers through `answerLocal`, never an `extension_ui_response`; it stays available while its
			// own input is open, whatever happens to the holders.
			accepts: () => false,
			available: () => true,
			presenter: () => undefined,
			send: () => {},
			sealed: (id) => this.owners.has(id),
			raiser: () => false,
			offerSealed: (id, offer) => {
				const holders = this.owners.get(id);
				if (holders) this.source.offer(this.sessionId, holders, { uiRequestId: id, ...offer });
			},
			sealedOutcome: (id, outcome, winnerGrant) => {
				const holders = this.owners.get(id);
				if (holders) this.source.settle(holders, id, outcome, winnerGrant);
			},
			bindSealedResponder: (latch) => {
				this.latch = latch;
			},
			settled: (id) => this.source.retire(id),
			forget: (id) => {
				this.owners.delete(id);
				this.source.withdraw(id);
			},
		};
	}
}

/**
 * The terminal's secret input when sealed holders may answer too: the local component and the sealed request race,
 * the first answer settles both, and the losing side is dismissed. Without a holder, the local component alone.
 */
export function raceTerminalSecretInput(
	sealed: TerminalSealedSecrets | undefined,
	local: (opts: ExtensionUIInputOptions | undefined) => Promise<string | undefined>,
	title: string,
	placeholder: string | undefined,
	opts: ExtensionUIInputOptions | undefined,
): Promise<string | undefined> {
	const dismiss = new AbortController();
	const signal = opts?.signal ? AbortSignal.any([opts.signal, dismiss.signal]) : dismiss.signal;
	const opened = opts?.secret ? sealed?.open(title, placeholder, { ...opts, signal }) : undefined;
	if (!sealed || !opened) return local(opts);
	void local({ ...opts, signal }).then(
		(value) => sealed.requests.answerLocal(opened.id, value),
		() => dismiss.abort(),
	);
	return opened.result.finally(() => dismiss.abort());
}
