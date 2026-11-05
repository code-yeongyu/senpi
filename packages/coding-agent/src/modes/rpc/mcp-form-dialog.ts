import { randomBytes, timingSafeEqual } from "node:crypto";
import { validMcpFormContent } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { MrtrInputResponse } from "../../core/extensions/builtin/mcp/modern/elicitation.ts";
import type { McpFormRequest, McpFormResolved, McpFormSettled } from "../../core/mcp-form-types.ts";
import type { McpFormGroup } from "./mcp-presenter-form-group.ts";

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

export type McpPresenterFrame = McpFormRequest | McpFormResolved | McpFormSettled;
export type McpPresenterReply =
	| { readonly ok: true; readonly form?: McpFormRequest }
	| { readonly error: "presenter_not_authorized" | "invalid_form_response" | "form_stale" | "form_expired" };

export interface McpFormHolder {
	readonly envelope: Omit<McpFormRequest, "type" | "server" | "message" | "schema" | "deadlineAtMs" | "dialogToken">;
	readonly current: () => boolean;
	readonly remove: () => void;
	readonly send: (frame: McpPresenterFrame) => boolean;
	/** The grant's signed acquire carried `elsewhere_v1`; nothing else may receive the negotiated additions. */
	readonly negotiated: boolean;
	readonly answeredBy: NonNullable<McpFormSettled["answeredBy"]>;
}

/** One holder's private view of a group. Lifecycle closures retain it even after its grant is removed. */
export class McpFormDialog {
	readonly holder: McpFormHolder;
	private readonly group: McpFormGroup;
	private delivered = false;
	private presentedHere = false;
	private request: McpFormRequest | undefined;
	private readonly token = randomBytes(32);

	constructor(group: McpFormGroup, holder: McpFormHolder) {
		this.group = group;
		this.holder = holder;
		this.request = {
			...holder.envelope,
			type: "mcp_form_request",
			dialogToken: this.token.toString("hex"),
			server: structuredClone(group.input.server),
			message: group.input.message,
			schema: structuredClone(group.input.schema),
			deadlineAtMs: Date.now() + Math.max(0, group.input.deadlineMs),
		};
	}

	deliver(): void {
		const request = this.request;
		if (!request) return;
		// Marked first: a presenter may answer synchronously inside `send` and must still see its resolution.
		this.delivered = true;
		if (!this.holder.current() || !this.holder.send(request)) this.revoked();
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
		this.presentedHere = true;
		this.group.markPresented();
		return { ok: true };
	}

	respond(action: string, content: unknown): McpPresenterReply {
		if (!this.live()) return { error: "form_expired" };
		if (!this.presentedHere || !this.request) return { error: "invalid_form_response" };
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
		this.group.settle({ kind: "result", result, source: "presenter_action", humanAdmission: true }, this);
		return { ok: true };
	}

	/** Internal-only: holder loss ends this dialog alone; a binding teardown aborts the whole group. */
	revoked(operation = false): void {
		if (operation) {
			this.group.terminate("operation_aborted");
			return;
		}
		this.close();
		this.group.leave(this);
	}

	close(): void {
		this.request = undefined;
		this.token.fill(0);
		this.holder.remove();
	}

	resolved(reason: McpFormResolved["reason"], elsewhere: boolean): void {
		if (!this.delivered || !this.holder.current()) return;
		const { sessionId, grantId, dialogId } = this.holder.envelope;
		this.holder.send({
			type: "mcp_form_resolved",
			sessionId,
			grantId,
			dialogId,
			reason,
			...(elsewhere && this.holder.negotiated ? { elsewhere: true } : {}),
		});
	}

	settled(record: McpFormSettled): void {
		if (this.delivered && this.holder.negotiated && this.holder.current()) this.holder.send(record);
	}

	private live(): boolean {
		if (!this.group.live()) return false;
		if (this.holder.current()) return true;
		this.revoked();
		return false;
	}
}
