import { randomUUID } from "node:crypto";
import { queuedForm } from "../../core/extensions/builtin/mcp/modern/consent-queue.ts";
import { isRecord, validateMrtrForm } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { McpFormInput, McpFormOutcome, McpFormPresentation } from "../../core/mcp-form-types.ts";
import type { McpPresenterReply } from "./mcp-form-dialog.ts";
import type { Binding, McpPresenterConnection, McpPresenterState } from "./mcp-presenter-bindings.ts";
import { McpFormGroup } from "./mcp-presenter-form-group.ts";
import { current, holders } from "./mcp-presenter-grants.ts";

export function receive(state: McpPresenterState, sender: McpPresenterConnection, value: unknown): McpPresenterReply {
	const connection = state.connections.get(sender);
	if (!isRecord(value) || typeof value.sessionId !== "string") return { error: "presenter_not_authorized" };
	const binding = state.bindings.get(value.sessionId);
	const held = binding ? holders(state, binding).filter((grant) => grant.registration.connection === connection) : [];
	// Check authority before parsing the private namespace, including invented dialog ids.
	if (!connection || held.length === 0) return { error: "presenter_not_authorized" };
	const grant = held.find((candidate) => candidate.id === value.grantId);
	if (
		!grant ||
		value.bindingEpoch !== grant.scope.bindingEpoch ||
		value.attachmentEpoch !== grant.scope.attachmentEpoch
	)
		return { error: "presenter_not_authorized" };
	const allowed = [
		"type",
		"id",
		"sessionId",
		"bindingEpoch",
		"attachmentEpoch",
		"grantId",
		"dialogId",
		"dialogToken",
		"formRevision",
	];
	if (value.type === "mcp_form_response") allowed.push("action", "content");
	if (Object.keys(value).some((key) => !allowed.includes(key))) return { error: "invalid_form_response" };
	if (value.type === "mcp_form_sync") {
		const form = grant.dialogs.values().next().value?.sync();
		return form === undefined ? { ok: true } : { ok: true, form };
	}
	if (
		typeof value.dialogId !== "string" ||
		typeof value.dialogToken !== "string" ||
		typeof value.formRevision !== "string"
	)
		return { error: "invalid_form_response" };
	const dialog = grant.dialogs.get(value.dialogId);
	if (!dialog) return { error: "form_stale" };
	if (!dialog.matches(value.dialogToken, value.formRevision)) return { error: "invalid_form_response" };
	switch (value.type) {
		case "mcp_form_presented":
			return dialog.presented();
		case "mcp_form_response":
			return typeof value.action === "string"
				? dialog.respond(value.action, value.content)
				: { error: "invalid_form_response" };
		default:
			return { error: "invalid_form_response" };
	}
}

export function presentation(
	state: McpPresenterState,
	binding: Binding,
	presence: NonNullable<Binding["presence"]>,
): McpFormPresentation {
	const ready = () => binding.presence === presence && holders(state, binding).length > 0;
	return {
		signal: presence.lifetime.signal,
		ready,
		present: (input) => present(state, binding, presence.lifetime.signal, ready, input),
	};
}

function present(
	state: McpPresenterState,
	binding: Binding,
	lifetime: AbortSignal,
	ready: () => boolean,
	input: McpFormInput,
): Promise<McpFormOutcome> {
	const { clock } = state;
	const unavailable: McpFormOutcome = {
		kind: "processing_failure",
		source: "host_termination",
		humanAdmission: false,
	};
	if (
		!ready() ||
		!validateMrtrForm(input.schema) ||
		Object.keys(input.schema.properties).length > 64 ||
		Buffer.byteLength(JSON.stringify({ message: input.message, schema: input.schema })) > 512 * 1024
	)
		return Promise.resolve(unavailable);
	const deadline = clock.now() + input.deadlineMs;
	const expired = new AbortController();
	const timer = clock.schedule(() => expired.abort(), Math.max(0, input.deadlineMs));
	const signal = AbortSignal.any([input.operationSignal, input.presentationSignal, lifetime, expired.signal]);
	return queuedForm(binding.queue, signal, () => {
		clock.cancel(timer);
		// The holder snapshot: only grants current now get a dialog; later holders wait for the next form (2.5, 2.7).
		const snapshot = ready() ? holders(state, binding) : [];
		if (snapshot.length === 0) return Promise.resolve(unavailable);
		const group = new McpFormGroup(
			{ ...input, presentationSignal: signal, deadlineMs: Math.max(0, deadline - clock.now()) },
			{ clock, sessionId: binding.sessionId, admit: binding.admit },
		);
		for (const grant of snapshot) {
			const dialogId = randomUUID();
			const dialog = group.join({
				envelope: {
					sessionId: binding.sessionId,
					bindingEpoch: binding.epoch,
					attachmentEpoch: grant.scope.attachmentEpoch,
					grantId: grant.id,
					dialogId,
					formRevision: randomUUID(),
				},
				current: () => current(state, grant),
				remove: () => {
					grant.dialogs.delete(dialogId);
				},
				send: grant.registration.connection.send,
				negotiated: grant.registration.elsewhere,
				answeredBy: grant.answeredBy,
			});
			grant.dialogs.set(dialogId, dialog);
		}
		group.start();
		return group.result;
	})
		.catch((): McpFormOutcome => ({
			...unavailable,
			kind:
				input.operationSignal.aborted || binding.signal.aborted || input.operationCurrent?.() === false
					? "operation_aborted"
					: "processing_failure",
		}))
		.finally(() => clock.cancel(timer));
}
