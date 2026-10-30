import { randomUUID } from "node:crypto";
import {
	armSecretInputDeadline,
	isSecretInputValue,
	resolveSecretInputTimeout,
	SecretInputUnavailableError,
	type SecretInputUnavailableReason,
} from "../../core/extensions/secret-input.ts";
import type { ExtensionUIInputOptions } from "../../core/extensions/types.ts";
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
}

interface Pending {
	readonly deadline: number;
	finish(outcome: SecretInputOutcome, value?: string): void;
}

/** Private, live-only state. Never registered in progress, snapshot, transcript or answer-ledger maps. */
export class SecretInputRequests {
	private readonly route: SecretInputRoute;
	private readonly admit: () => void;
	private readonly pending = new Map<string, Pending>();
	private readonly receipts = new Map<string, string | undefined>();
	constructor(route: SecretInputRoute, admit: () => void) {
		this.route = route;
		this.admit = admit;
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
			const finish = (outcome: SecretInputOutcome, value?: string) => {
				if (!this.pending.delete(id)) return;
				disarm?.();
				opts?.signal?.removeEventListener("abort", onAbort);
				this.remember(id);
				this.route.send(id, { type: "secret_input_settled", id, outcome });
				this.route.settled(id);
				resolve(value);
			};
			this.pending.set(id, { deadline, finish });
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
		});
	}

	has(id: string): boolean {
		return this.pending.has(id) || this.receipts.has(id);
	}
	answered(): { uiRequestId: string; answerId: string }[] {
		return [...this.receipts]
			.filter((entry): entry is [string, string] => entry[1] !== undefined && this.route.accepts(entry[0]))
			.slice(-64)
			.map(([uiRequestId, answerId]) => ({ uiRequestId, answerId }));
	}

	respond(frame: Record<string, unknown>): ExtensionUiResponseReply {
		const id = typeof frame.id === "string" ? frame.id : "";
		const requestId = answeredUiRequestId(frame);
		if (!requestId || !this.has(requestId)) return refusedExtensionUiResponse(id, "unknown_extension_ui_request");
		if (!this.route.accepts(requestId)) return refusedExtensionUiResponse(id, "secret_answer_refused");
		const allowed = new Set(["type", "id", "uiRequestId", "answerId", "sessionId", "secret", "value", "cancelled"]);
		if (
			frame.secret !== true ||
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
			const answerId = this.receipts.get(requestId);
			if (answerId === frame.answerId) return { ...reply, success: true, disposition: "replay" };
			return answerId === undefined
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
		this.receipts.set(requestId, frame.answerId);
		return { ...reply, success: true, disposition: "applied" };
	}

	cancelAll(outcome: SecretInputOutcome = "cancelled"): void {
		for (const pending of [...this.pending.values()]) pending.finish(outcome);
	}
	recheck(): void {
		for (const [id, pending] of this.pending) if (!this.route.available(id)) pending.finish("unavailable");
	}
	close(): void {
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
