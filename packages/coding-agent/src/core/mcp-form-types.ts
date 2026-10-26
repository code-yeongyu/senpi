import type { MrtrInputResponse } from "./extensions/builtin/mcp/modern/elicitation.ts";
import type { ValidatedMcpFormSchema } from "./extensions/builtin/mcp/modern/form-schema.ts";
import type { ExtensionUIContext } from "./extensions/types.ts";
import { getMcpMrtrPresentation, registerMcpMrtrPresentation } from "./mcp-mrtr-presentations.ts";

export interface McpFormScope {
	readonly hostInstance: string;
	readonly durableSessionId: string;
	readonly bindingEpoch: string;
	readonly attachmentId: string;
	readonly attachmentEpoch: string;
	readonly connectionId: string;
	readonly connectionEpoch: string;
	readonly presenterPrincipalId: string;
	readonly presenterGeneration: string;
	readonly presentationBindingId: string;
	readonly presenterKind: "desktop" | "gateway" | "local_tui";
	readonly purpose: "mcp_form";
}

export interface McpFormEnvelope {
	readonly sessionId: string;
	readonly bindingEpoch: string;
	readonly attachmentEpoch: string;
	readonly grantId: string;
	readonly dialogId: string;
	readonly dialogToken: string;
	readonly formRevision: string;
}

export interface McpFormRequest extends McpFormEnvelope {
	readonly type: "mcp_form_request";
	readonly server: { readonly label: string; readonly source: "user" | "project" | "plugin" };
	readonly message: string;
	readonly schema: ValidatedMcpFormSchema;
	readonly deadlineAtMs: number;
}

export interface McpFormResolved {
	readonly type: "mcp_form_resolved";
	readonly sessionId: string;
	readonly grantId: string;
	readonly dialogId: string;
	readonly reason: "answered" | "declined" | "cancelled" | "processing_failed" | "operation_aborted";
}

export type McpFormOutcome = (
	| { readonly kind: "result"; readonly result: MrtrInputResponse }
	| { readonly kind: "processing_failure" | "operation_aborted" }
) &
	(
		| { readonly source: "presenter_action"; readonly humanAdmission: true }
		| { readonly source: "host_termination"; readonly humanAdmission: false }
	);

export interface McpFormInput {
	readonly operationId: string;
	readonly inputId: string;
	readonly round: number;
	readonly server: McpFormRequest["server"];
	readonly message: string;
	readonly schema: ValidatedMcpFormSchema;
	readonly operationSignal: AbortSignal;
	/** Host reads a worker-owned atomic abort fence at the terminal latch, without an IPC round trip. */
	readonly operationCurrent?: () => boolean;
	readonly presentationSignal: AbortSignal;
	/** Remaining UI budget, measured by the host's monotonic clock. */
	readonly deadlineMs: number;
}

export interface McpFormPresentation {
	readonly signal: AbortSignal;
	readonly ready: () => boolean;
	readonly present: (input: McpFormInput) => Promise<McpFormOutcome>;
	/** Worker-backed presenters recheck host readiness before each network attempt. */
	readonly synchronize?: () => Promise<void>;
}

export interface McpFormBinding {
	readonly epoch: string;
	readonly signal: AbortSignal;
	readonly capture: () => McpFormPresentation | undefined;
	readonly dispose: () => void;
	readonly version?: () => string | undefined;
	readonly subscribe?: (listener: () => void) => () => void;
}

const presentedCallbacks = new WeakMap<object, () => void>();
export function bindMcpFormPresented(options: object, callback: (() => void) | undefined): void {
	if (callback) presentedCallbacks.set(options, callback);
	else presentedCallbacks.delete(options);
}
export function markMcpFormPresented(options: object | undefined): void {
	if (!options) return;
	const callback = presentedCallbacks.get(options);
	presentedCallbacks.delete(options);
	callback?.();
}
/** An enforced binding is part of the host-issued presenter identity, not a UI capability declaration. */
export function bindPrivateMcpForms(ui: object, binding: McpFormBinding): void {
	registerMcpMrtrPresentation(ui as ExtensionUIContext, binding.signal, undefined, binding);
}
export function privateMcpForms(ui: object): McpFormBinding | undefined {
	return getMcpMrtrPresentation(ui)?.privateForms;
}
