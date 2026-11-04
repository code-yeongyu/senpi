import { randomUUID } from "node:crypto";
import { queuedForm } from "../../core/extensions/builtin/mcp/modern/consent-queue.ts";
import { isRecord, validateMrtrForm } from "../../core/extensions/builtin/mcp/modern/form-schema.ts";
import type { McpFormInput, McpFormOutcome, McpFormPresentation } from "../../core/mcp-form-types.ts";
import { McpFormDialog, type McpPresenterReply } from "./mcp-form-dialog.ts";
import type { McpPresenterConnection, McpPresenterState } from "./mcp-presenter-bindings.ts";
import { current, type Grant } from "./mcp-presenter-grants.ts";

export function receive(state: McpPresenterState, sender: McpPresenterConnection, value: unknown): McpPresenterReply {
	const connection = state.connections.get(sender);
	const binding =
		isRecord(value) && typeof value.sessionId === "string" ? state.bindings.get(value.sessionId) : undefined;
	const grant = binding?.grant;
	// Check authority before parsing the private namespace, including invented dialog ids.
	if (!connection || !grant || grant.registration.connection !== connection || !current(state, grant))
		return { error: "presenter_not_authorized" };
	if (
		!isRecord(value) ||
		value.grantId !== grant.id ||
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

export function presentation(state: McpPresenterState, grant: Grant): McpFormPresentation {
	return {
		signal: grant.lifetime.signal,
		ready: () => current(state, grant),
		present: (input) => present(state, grant, input),
	};
}

function present(state: McpPresenterState, grant: Grant, input: McpFormInput): Promise<McpFormOutcome> {
	const { clock } = state;
	const unavailable: McpFormOutcome = {
		kind: "processing_failure",
		source: "host_termination",
		humanAdmission: false,
	};
	if (
		!current(state, grant) ||
		!validateMrtrForm(input.schema) ||
		Object.keys(input.schema.properties).length > 64 ||
		Buffer.byteLength(JSON.stringify({ message: input.message, schema: input.schema })) > 512 * 1024
	)
		return Promise.resolve(unavailable);
	const binding = grant.registration.binding;
	const deadline = clock.now() + input.deadlineMs;
	const expired = new AbortController();
	const timer = clock.schedule(() => expired.abort(), Math.max(0, input.deadlineMs));
	const signal = AbortSignal.any([
		input.operationSignal,
		input.presentationSignal,
		grant.lifetime.signal,
		expired.signal,
	]);
	return queuedForm(grant, signal, () => {
		clock.cancel(timer);
		if (!current(state, grant)) return Promise.resolve(unavailable);
		const dialogId = randomUUID();
		const dialog = new McpFormDialog(
			{
				...input,
				presentationSignal: signal,
				deadlineMs: Math.max(0, deadline - clock.now()),
			},
			{
				clock,
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
				admit: binding.admit,
				send: grant.registration.connection.send,
			},
		);
		grant.dialogs.set(dialogId, dialog);
		dialog.start();
		return dialog.result;
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
