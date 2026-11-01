import { collectMrtrForm } from "../../core/extensions/builtin/mcp/modern/elicitation.ts";
import { queuedForm } from "../../core/extensions/builtin/mcp/modern/consent-queue.ts";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { McpFormBinding, McpFormInput } from "../../core/mcp-form-types.ts";
import { McpPresenterAuthority } from "../rpc/mcp-presenter-authority.ts";

/** The terminal itself is the principal; an RPC attachment never receives this handle. */
export function registerLocalMcpPresenter(
	ui: ExtensionUIContext,
	sessionId: string,
	lifetime: AbortSignal,
	admit: () => void,
): McpFormBinding {
	const authority = new McpPresenterAuthority();
	const binding = authority.bind(sessionId, sessionId, admit);
	let activeInput: { input: McpFormInput; fail: () => void } | undefined;
	const drafts = new Map<string, AbortController>();
	const sender = authority.connect("local_tui", (frame) => {
		if (frame.type !== "mcp_form_request") {
			drafts.get(frame.dialogId)?.abort();
			drafts.delete(frame.dialogId);
			return true;
		}
		const active = activeInput;
		if (!active) return false;
		const { input } = active;
		const draft = new AbortController();
		drafts.set(frame.dialogId, draft);
		const signal = AbortSignal.any([input.operationSignal, input.presentationSignal, lifetime, draft.signal]);
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = frame;
		const envelope = { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
		void collectMrtrForm(
			{
				ui,
				signal,
				presented: () => authority.receive(sender, { ...envelope, type: "mcp_form_presented" }),
			},
			`${frame.server.label} (${frame.server.source})`,
			{ message: frame.message, requestedSchema: frame.schema },
			signal,
		)
			.then(
				(result) => {
					if (!signal.aborted) authority.receive(sender, { ...envelope, type: "mcp_form_response", ...result });
				},
				() => active.fail(),
			)
			.finally(() => drafts.delete(frame.dialogId));
		return true;
	});
	authority.attach(sender, binding);
	const owner = authority.enroll();
	owner.acquire(owner.register(binding, sender, { kind: "local_tui" }));
	const dispose = () => {
		authority.dispose();
		for (const draft of drafts.values()) draft.abort();
		drafts.clear();
	};
	lifetime.addEventListener("abort", dispose, { once: true });
	const privateForms: McpFormBinding = {
		epoch: binding.epoch,
		signal: binding.signal,
		capture: () => {
			const presentation = binding.capture();
			if (!presentation) return undefined;
			return {
				...presentation,
				present: async (input) => {
					const deadline = performance.now() + input.deadlineMs;
					const timeout = new AbortController();
					const timer = setTimeout(() => timeout.abort(), Math.max(0, input.deadlineMs));
					const signal = AbortSignal.any([
						input.operationSignal,
						input.presentationSignal,
						presentation.signal,
						lifetime,
						timeout.signal,
					]);
					try {
						return await queuedForm(binding, signal, async () => {
							const failure = new AbortController();
							const current = {
								input: {
									...input,
									presentationSignal: AbortSignal.any([signal, failure.signal]),
									deadlineMs: Math.max(0, deadline - performance.now()),
								},
								fail: () => failure.abort(),
							};
							activeInput = current;
							try {
								return await presentation.present(current.input);
							} finally {
								if (activeInput === current) activeInput = undefined;
							}
						});
					} catch {
						return {
							kind:
								input.operationSignal.aborted || binding.signal.aborted || input.operationCurrent?.() === false
									? "operation_aborted"
									: "processing_failure",
							source: "host_termination",
							humanAdmission: false,
						};
					} finally {
						clearTimeout(timer);
					}
				},
			};
		},
		dispose,
	};
	if (lifetime.aborted) dispose();
	return privateForms;
}
