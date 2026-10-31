import { randomBytes, timingSafeEqual } from "node:crypto";
import { validMcpFormContent } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { MrtrInputResponse } from "../../core/extensions/builtin/mcp/modern/elicitation.ts";
import type { McpFormInput, McpFormOutcome, McpFormRequest, McpFormResolved } from "../../core/mcp-form-types.ts";

export interface McpFormClock {
	now(): number;
	schedule(callback: () => void, delay: number): object;
	cancel(timer: object): void;
}

export const mcpFormClock: McpFormClock = {
	now: () => performance.now(),
	schedule: (callback, delay) => setTimeout(callback, delay),
	cancel: (timer) => {
		if ("close" in timer && typeof timer.close === "function") timer.close();
	},
};

type Termination = "presentation_lost" | "presentation_timeout" | "operation_aborted";
export type McpPresenterReply =
	| { readonly ok: true; readonly form?: McpFormRequest }
	| { readonly error: "presenter_not_authorized" | "invalid_form_response" | "form_stale" | "form_expired" };

/** One private entry. Lifecycle closures retain this object even after its grant is removed. */
export class McpFormDialog {
	readonly result: Promise<McpFormOutcome>;
	readonly deadline: number;
	private stage: "prepared" | "presented" | "settled" = "prepared";
	private request: McpFormRequest | undefined;
	private readonly token = randomBytes(32);
	private readonly cleanups: Array<() => void> = [];
	private resolve: (outcome: McpFormOutcome) => void = () => {};
	private readonly input: McpFormInput;
	private readonly context: {
		readonly clock: McpFormClock;
		readonly envelope: Omit<
			McpFormRequest,
			"type" | "server" | "message" | "schema" | "deadlineAtMs" | "dialogToken"
		>;
		readonly current: () => boolean;
		readonly remove: () => void;
		readonly admit: () => void;
		readonly send: (frame: McpFormRequest | McpFormResolved) => boolean;
	};

	constructor(
		input: McpFormInput,
		context: {
			readonly clock: McpFormClock;
			readonly envelope: Omit<
				McpFormRequest,
				"type" | "server" | "message" | "schema" | "deadlineAtMs" | "dialogToken"
			>;
			readonly current: () => boolean;
			readonly remove: () => void;
			readonly admit: () => void;
			readonly send: (frame: McpFormRequest | McpFormResolved) => boolean;
		},
	) {
		this.input = input;
		this.context = context;
		this.deadline = context.clock.now() + Math.max(0, input.deadlineMs);
		this.result = new Promise((resolve) => {
			this.resolve = resolve;
		});
		this.request = {
			...context.envelope,
			type: "mcp_form_request",
			dialogToken: this.token.toString("hex"),
			server: structuredClone(input.server),
			message: input.message,
			schema: structuredClone(input.schema),
			deadlineAtMs: Date.now() + Math.max(0, input.deadlineMs),
		};
	}

	start(): void {
		const watch = (signal: AbortSignal, cause: Termination) => {
			const stop = () => this.terminate(cause);
			signal.addEventListener("abort", stop, { once: true });
			this.cleanups.push(() => signal.removeEventListener("abort", stop));
			if (signal.aborted) stop();
		};
		watch(this.input.operationSignal, "operation_aborted");
		watch(this.input.presentationSignal, "presentation_lost");
		if (this.stage === "settled") {
			for (const cleanup of this.cleanups.splice(0)) cleanup();
			return;
		}
		const timer = this.context.clock.schedule(() => this.terminate("presentation_timeout"), this.input.deadlineMs);
		this.cleanups.push(() => this.context.clock.cancel(timer));
		if (!this.context.current() || !this.request || !this.context.send(this.request))
			this.terminate("presentation_lost");
	}

	sync(): McpFormRequest | undefined {
		if (!this.live()) return undefined;
		return this.request === undefined ? undefined : structuredClone(this.request);
	}

	matches(token: string, revision: string): boolean {
		return (
			this.request?.formRevision === revision &&
			/^[a-f0-9]{64}$/.test(token) &&
			timingSafeEqual(this.token, Buffer.from(token, "hex"))
		);
	}

	presented(): McpPresenterReply {
		if (!this.live()) return { error: "form_expired" };
		this.stage = "presented";
		return { ok: true };
	}

	respond(action: string, content: unknown): McpPresenterReply {
		if (!this.live()) return { error: "form_expired" };
		if (this.stage !== "presented" || !this.request) return { error: "invalid_form_response" };
		let result: MrtrInputResponse;
		switch (action) {
			case "accept":
				if (
					!validMcpFormContent(this.request.schema, content) ||
					Buffer.byteLength(JSON.stringify(content)) > 1024 * 1024
				)
					return { error: "invalid_form_response" };
				result = { action, content: structuredClone(content) };
				break;
			case "decline":
			case "cancel":
				if (content !== undefined) return { error: "invalid_form_response" };
				result = { action };
				break;
			default:
				return { error: "invalid_form_response" };
		}
		if (!this.live()) return { error: "form_expired" };
		this.commit({ kind: "result", result, source: "presenter_action", humanAdmission: true });
		return { ok: true };
	}

	/** Internal-only: never called with a cause or entry reference decoded from RPC. */
	terminate(cause: Termination): void {
		const provenance = { source: "host_termination", humanAdmission: false } as const;
		if (
			cause === "operation_aborted" ||
			this.input.operationSignal.aborted ||
			this.input.operationCurrent?.() === false
		) {
			this.commit({ kind: "operation_aborted", ...provenance });
		} else if (this.stage === "presented") {
			this.commit({ kind: "result", result: { action: "cancel" }, ...provenance });
		} else {
			this.commit({ kind: "processing_failure", ...provenance });
		}
	}

	private live(): boolean {
		if (this.stage === "settled") return false;
		if (this.input.operationSignal.aborted || this.input.operationCurrent?.() === false) {
			this.terminate("operation_aborted");
			return false;
		}
		if (this.context.clock.now() >= this.deadline || !this.context.current()) {
			this.terminate("presentation_timeout");
			return false;
		}
		return true;
	}

	private commit(outcome: McpFormOutcome): void {
		if (this.stage === "settled") return;
		this.stage = "settled";
		const request = this.request;
		this.request = undefined;
		this.token.fill(0);
		this.context.remove();
		for (const cleanup of this.cleanups.splice(0)) cleanup();
		// No callback, promise resolution or admission precedes the synchronous terminal claim.
		if (outcome.humanAdmission) this.context.admit();
		this.resolve(outcome);
		if (request && this.context.current()) {
			const reason =
				outcome.kind === "result"
					? outcome.result.action === "accept"
						? "answered"
						: outcome.result.action === "decline"
							? "declined"
							: "cancelled"
					: outcome.kind === "operation_aborted"
						? "operation_aborted"
						: "processing_failed";
			this.context.send({
				type: "mcp_form_resolved",
				sessionId: request.sessionId,
				grantId: request.grantId,
				dialogId: request.dialogId,
				reason,
			});
		}
	}
}
