import { randomUUID, type KeyObject } from "node:crypto";
import {
	armSecretInputDeadline,
	isSecretInputValue,
	resolveSecretInputTimeout,
	SecretInputUnavailableError,
	type SecretInputUnavailableReason,
} from "../../core/extensions/secret-input.ts";
import type { ExtensionUIInputOptions } from "../../core/extensions/types.ts";
import type { SealedSecretOffer } from "./secret-sealed-holders.ts";
import { generateSecretRequestKey } from "./secret-sealed.ts";
import {
	answeredUiRequestId,
	refusedExtensionUiResponse,
	type ExtensionUiResponseReply,
} from "./extension-ui-response.ts";

export type SecretInputOutcome = "answered" | "cancelled" | "timed_out" | "unavailable";
export interface SecretInputRoute {
	select(id: string, unavailable: () => void): SecretInputUnavailableReason | undefined;
	accepts(id: string): boolean;
	available(id: string): boolean;
	presenter(id: string): string | undefined;
	send(id: string, record: object): void;
	settled(id: string): void;
	forget(id: string): void;
	handshake?(capabilities: readonly string[]): void;
	/** The request has sealed holders (D11 secret phase 5.2); only an in-process route can. */
	sealed?(id: string): boolean;
	/** Signs the request for its sealed holders and sends it to each (4.3). */
	offerSealed?(id: string, offer: Omit<SealedSecretOffer, "uiRequestId">): void;
	/** Sends every sealed holder the value-free settle; `winner` is the grant whose answer won, if any (7.2). */
	sealedOutcome?(id: string, outcome: SecretInputOutcome, winner: object | undefined): void;
	/** Registers this session's latch for sealed answers (7.1 steps 3 and 6). */
	bindSealedResponder?(latch: SealedLatch | undefined): void;
}

/** A sealed answer that passed design 7.1 steps 1, 2, 4 and 5 in the host process; steps 3 and 6 run here. */
export interface SealedAnswer {
	readonly uiRequestId: string;
	readonly principal: string;
	readonly answerId: string;
	/** The answering grant, so every other holder settles with `elsewhere: true`. */
	readonly winner: object;
	/** 5.1 re-checked at the claim: the grant is current and still eligible. */
	readonly current: () => boolean;
	/** Absent for a cancel. `admitJti` consumes the step-up token; `open` decrypts with the request key. */
	readonly value?: {
		readonly admitJti: () => boolean;
		readonly open: (key: KeyObject, hpkePk: string) => string | undefined;
	};
}

export type SealedAnswerReply =
	| { readonly disposition: "applied" | "replay" }
	| {
			readonly error:
				| "already_answered"
				| "unknown_extension_ui_request"
				| "secret_stepup_refused"
				| "invalid_secret_response"
				| "secret_answer_refused";
	  };

/** What a route's sealed answers reach at the session's latch. */
export interface SealedLatch {
	/** 7.1 step 3 for a request that is no longer pending; `undefined` while it is. */
	settled(uiRequestId: string, answerId: string, principal: string): SealedAnswerReply | undefined;
	respond(answer: SealedAnswer): SealedAnswerReply;
}

interface Receipt {
	readonly answerId: string;
	/** The sealed answer's principal; absent for an answer on the raiser route. */
	readonly principal?: string;
}

interface Pending {
	readonly deadline: number;
	/** The request's private X25519 key while it has sealed holders; dropped with the entry (design 4.1, 8.2). */
	readonly key?: KeyObject;
	readonly hpkePk?: string;
	finish(outcome: SecretInputOutcome, value?: string, winner?: object): void;
}

/** Private, live-only state. Never registered in progress, snapshot, transcript or answer-ledger maps. */
export class SecretInputRequests {
	private readonly route: SecretInputRoute;
	private readonly admit: () => void;
	private readonly pending = new Map<string, Pending>();
	private readonly receipts = new Map<string, Receipt | undefined>();
	constructor(route: SecretInputRoute, admit: () => void) {
		this.route = route;
		this.admit = admit;
		route.bindSealedResponder?.({
			settled: (id, answerId, principal) =>
				this.pending.has(id) ? undefined : this.receipt(id, answerId, principal),
			respond: (answer) => this.respondSealed(answer),
		});
	}

	input(title: string, placeholder: string | undefined, opts?: ExtensionUIInputOptions): Promise<string | undefined> {
		if (opts?.signal?.aborted) return Promise.resolve(undefined);
		const timeout = resolveSecretInputTimeout(opts);
		const id = randomUUID();
		const refused = this.route.select(id, () => this.pending.get(id)?.finish("unavailable"));
		if (refused) return Promise.reject(new SecretInputUnavailableError(refused));
		return new Promise((resolve) => {
			const deadline = Date.now() + timeout;
			let disarm: (() => void) | undefined;
			const onAbort = () => finish("cancelled");
			const finish = (outcome: SecretInputOutcome, value?: string, winner?: object) => {
				if (!this.pending.delete(id)) return;
				disarm?.();
				opts?.signal?.removeEventListener("abort", onAbort);
				this.remember(id);
				this.route.send(id, { type: "secret_input_settled", id, outcome });
				this.route.sealedOutcome?.(id, outcome, winner);
				this.route.settled(id);
				resolve(value);
			};
			const key = this.route.sealed?.(id) === true ? generateSecretRequestKey() : undefined;
			this.pending.set(id, {
				deadline,
				finish,
				...(key === undefined ? {} : { key: key.privateKey, hpkePk: key.hpkePk }),
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			disarm = armSecretInputDeadline(deadline, () => finish("timed_out"));
			if (opts?.signal?.aborted) return finish("cancelled");
			this.route.send(id, {
				type: "extension_ui_request",
				id,
				method: "input",
				secret: true,
				title,
				...(placeholder === undefined ? {} : { placeholder }),
				timeout,
				deadlineAtMs: deadline,
				...(opts?.toolCallId === undefined ? {} : { toolCallId: opts.toolCallId }),
				...(opts?.parentToolCallId === undefined ? {} : { parentToolCallId: opts.parentToolCallId }),
			});
			if (key !== undefined)
				this.route.offerSealed?.(id, { hpkePk: key.hpkePk, title, placeholder, deadlineAtMs: deadline });
		});
	}

	has(id: string): boolean {
		return this.pending.has(id) || this.receipts.has(id);
	}
	answered(): { uiRequestId: string; answerId: string }[] {
		return [...this.receipts]
			.filter(
				(entry): entry is [string, Receipt] =>
					entry[1] !== undefined && entry[1].principal === undefined && this.route.accepts(entry[0]),
			)
			.slice(-64)
			.map(([uiRequestId, receipt]) => ({ uiRequestId, answerId: receipt.answerId }));
	}

	respond(frame: Record<string, unknown>): ExtensionUiResponseReply {
		const id = typeof frame.id === "string" ? frame.id : "";
		const requestId = answeredUiRequestId(frame);
		if (!requestId || !this.route.accepts(requestId)) return refusedExtensionUiResponse(id, "secret_answer_refused");
		if (!this.has(requestId)) return refusedExtensionUiResponse(id, "unknown_extension_ui_request");
		const allowed = new Set(["type", "id", "uiRequestId", "answerId", "sessionId", "secret", "value", "cancelled"]);
		if (
			frame.secret !== true ||
			typeof frame.id !== "string" ||
			typeof frame.answerId !== "string" ||
			frame.answerId.length < 1 ||
			frame.answerId.length > 256 ||
			Object.keys(frame).some((key) => !allowed.has(key)) ||
			!("value" in frame
				? !("cancelled" in frame) && typeof frame.value === "string" && isSecretInputValue(frame.value)
				: frame.cancelled === true)
		)
			return refusedExtensionUiResponse(id, "invalid_secret_response");
		const pending = this.pending.get(requestId);
		const reply = { type: "response", command: "extension_ui_response", id } as const;
		if (!pending) {
			const receipt = this.receipts.get(requestId);
			if (receipt?.answerId === frame.answerId && receipt.principal === undefined)
				return { ...reply, success: true, disposition: "replay" };
			return receipt === undefined
				? refusedExtensionUiResponse(id, "unknown_extension_ui_request")
				: { ...reply, success: false, error: "already_answered", disposition: "already_answered" };
		}
		if (Date.now() >= pending.deadline) {
			pending.finish("timed_out");
			return refusedExtensionUiResponse(id, "unknown_extension_ui_request");
		}
		this.admit();
		pending.finish(
			frame.cancelled === true ? "cancelled" : "answered",
			typeof frame.value === "string" ? frame.value : undefined,
		);
		this.receipts.set(requestId, { answerId: frame.answerId });
		return { ...reply, success: true, disposition: "applied" };
	}

	/**
	 * Design 7.1 steps 3 and 6 at the latch, synchronously: a settled request answers `replay` or `already_answered`
	 * from its receipt before the step-up token is consumed; then the claim re-checks the request, the deadline and the
	 * grant, and only then opens the ciphertext. A losing answer is never decrypted.
	 */
	respondSealed(answer: SealedAnswer): SealedAnswerReply {
		const id = answer.uiRequestId;
		const pending = this.pending.get(id);
		if (!pending) return this.receipt(id, answer.answerId, answer.principal);
		if (answer.value && !answer.value.admitJti()) return { error: "secret_stepup_refused" };
		if (Date.now() >= pending.deadline) {
			pending.finish("timed_out");
			return { error: "unknown_extension_ui_request" };
		}
		if (!answer.current()) return { error: "secret_answer_refused" };
		let value: string | undefined;
		if (answer.value) {
			if (!pending.key || pending.hpkePk === undefined) return { error: "invalid_secret_response" };
			try {
				value = answer.value.open(pending.key, pending.hpkePk);
			} catch {
				// No fault inside the open may escape or carry the plaintext: it is a refusal (decision 0022 SP-0 L2).
				value = undefined;
			}
			if (value === undefined || !isSecretInputValue(value)) return { error: "invalid_secret_response" };
		}
		this.admit();
		pending.finish(answer.value ? "answered" : "cancelled", value, answer.winner);
		this.receipts.set(id, { answerId: answer.answerId, principal: answer.principal });
		return { disposition: "applied" };
	}

	/** 7.1 step 3: `replay` for the same answer id and principal, else `already_answered`; no receipt is unknown. */
	private receipt(id: string, answerId: string, principal: string): SealedAnswerReply {
		const receipt = this.receipts.get(id);
		if (receipt === undefined) return { error: "unknown_extension_ui_request" };
		return receipt.answerId === answerId && receipt.principal === principal
			? { disposition: "replay" }
			: { error: "already_answered" };
	}

	cancelAll(outcome: SecretInputOutcome = "cancelled"): void {
		for (const pending of [...this.pending.values()]) pending.finish(outcome);
	}
	recheck(): void {
		for (const [id, pending] of this.pending) if (!this.route.available(id)) pending.finish("unavailable");
	}
	close(): void {
		this.route.bindSealedResponder?.(undefined);
		this.cancelAll();
		for (const id of this.receipts.keys()) this.route.forget(id);
		this.receipts.clear();
	}
	private remember(id: string): void {
		this.receipts.set(id, undefined);
		if (this.receipts.size > 1024) {
			const oldest = this.receipts.keys().next().value;
			if (oldest !== undefined) {
				this.receipts.delete(oldest);
				this.route.forget(oldest);
			}
		}
	}
}
