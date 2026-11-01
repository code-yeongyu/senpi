// MCP elicitation, form mode only (todo 41).
//
// The client declares the capability as an EMPTY object — Spring-AI servers
// reject richer shapes (FieldCoding lesson from the comparison corpus) — and
// answers elicitation/create requests mid tool-call by walking the requested
// flat-primitive schema through sequential ctx.ui primitives (input/select;
// NEVER ctx.ui.custom, which is undefined in RPC mode). Without a UI
// (print mode) the request fails with a processing error, never a user refusal.
// The whole form is bounded by a timeout that resolves to cancel so a wedged
// dialog can never wedge the tool-call pipeline. URL mode is deliberately not
// implemented in v1.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionUIContext } from "../../types.ts";
import { privateMcpForms } from "../../../mcp-form-types.ts";
import { legacyMcpOperation } from "./request-origin.ts";
import { isRecord, validateMrtrForm } from "./modern/form-schema.ts";
import { createMcpLogger } from "./log.ts";
import { loadMcpSdkTypes } from "./sdk.lazy.ts";
import { safeTimer } from "./wrap.ts";

/** Declared empty on purpose: maximum server compatibility (form mode only). */
export const MCP_CLIENT_ELICITATION_CAPABILITY = { elicitation: {} } as const;

export function mcpClientCapabilities(elicitationEnabled = true): { elicitation?: Record<string, never> } {
	return elicitationEnabled ? MCP_CLIENT_ELICITATION_CAPABILITY : {};
}

export const MCP_ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

type ElicitationUi = Pick<ExtensionUIContext, "input" | "select">;

export type McpElicitationUiProvider = (() => ElicitationUi | undefined) & {
	readonly eligible?: () => boolean;
	readonly enforced?: () => boolean;
	readonly subscribe?: (listener: () => void) => () => void;
};
export interface McpElicitationUiOwner {
	getMcpElicitationUi(): ElicitationUi | undefined;
}

export interface ElicitationResponse {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, string | number | boolean>;
	// SDK request handlers must return an index-signature-compatible result.
	[key: string]: unknown;
}

interface ElicitProperty {
	type?: string;
	title?: string;
	description?: string;
	enum?: unknown[];
}

let legacyUiProvider: McpElicitationUiProvider | undefined;

/** Legacy classic-session seam. Session-owned services pass themselves directly. */
export function setMcpElicitationUiProvider(provider: McpElicitationUiProvider | undefined): void {
	legacyUiProvider = provider;
}

async function rejectElicitation(): Promise<never> {
	const { ErrorCode, McpError } = await loadMcpSdkTypes();
	throw new McpError(ErrorCode.InternalError, "Elicitation cannot be processed");
}

export function legacyMcpFormEligible(provider: McpElicitationUiProvider | undefined, enabled: boolean): boolean {
	if (!enabled) return false;
	if (provider?.eligible) return provider.eligible();
	const ui = provider?.();
	const binding = ui === undefined ? undefined : privateMcpForms(ui);
	return binding === undefined || binding.capture()?.ready() === true;
}

async function rejectPrivateElicitation(): Promise<never> {
	const { ErrorCode, McpError } = await loadMcpSdkTypes();
	throw new McpError(ErrorCode.InternalError, "Elicitation processing unavailable");
}

async function privateElicitation(
	client: Client,
	params: unknown,
	signal: AbortSignal,
	requestId: string | number,
	timeoutMs: number,
) {
	const operation = legacyMcpOperation(client);
	if (operation === "ambiguous") return rejectPrivateElicitation();
	const presenter = operation?.origin.privateForm;
	if (
		!isRecord(params) ||
		typeof params.message !== "string" ||
		(params.mode !== undefined && params.mode !== "form") ||
		!operation ||
		!presenter?.ready() ||
		!validateMrtrForm(params.requestedSchema)
	)
		return rejectPrivateElicitation();
	const outcome = await presenter.present({
		operationId: String(requestId),
		inputId: String(requestId),
		round: 0,
		server: { label: operation.origin.serverLabel, source: operation.origin.serverSource ?? "user" },
		message: params.message,
		schema: params.requestedSchema,
		operationSignal: AbortSignal.any([operation.signal, signal]),
		presentationSignal: presenter.signal,
		deadlineMs: timeoutMs,
	});
	if (outcome.kind !== "result" || operation.signal.aborted || !operation.origin.isCurrent())
		return rejectPrivateElicitation();
	return outcome.result;
}

/**
 * Wire the elicitation/create handler onto a fresh client. Async because the
 * request schema comes from the lazily loaded SDK; the caller (`buildMcpClient`
 * in `transport-sdk.ts`) awaits it before any connect, so a mid-call
 * elicitation still cannot race registration.
 */
export async function configureMcpElicitation(
	client: Client,
	owner: McpElicitationUiOwner | McpElicitationUiProvider | undefined = legacyUiProvider,
	timeoutMs: number = MCP_ELICITATION_TIMEOUT_MS,
	elicitationEnabled = true,
): Promise<void> {
	if (!elicitationEnabled) {
		// The SDK requires an advertised capability for setRequestHandler.
		// Its public fallback handles unsolicited requests without claiming UI support.
		const { ErrorCode, McpError } = await loadMcpSdkTypes();
		client.fallbackRequestHandler = async (request) => {
			if (request.method === "elicitation/create")
				return typeof owner === "function" && owner.enforced?.() ? rejectPrivateElicitation() : rejectElicitation();
			throw new McpError(ErrorCode.MethodNotFound, "Method not found");
		};
		return;
	}
	const { ElicitRequestSchema } = await loadMcpSdkTypes();
	if (typeof owner === "function" && owner.enforced?.()) {
		// Private validation prevents SDK error.data from echoing malformed form bodies.
		client.setRequestHandler(ElicitRequestSchema.omit({ params: true }).passthrough(), (request, extra) =>
			privateElicitation(client, request.params, extra.signal, extra.requestId, timeoutMs),
		);
		return;
	}
	client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
		const params = request.params;
		// URL mode is deliberately unsupported in v1 (form mode only).
		if (!("requestedSchema" in params)) return rejectElicitation();
		const ui = typeof owner === "function" ? owner() : owner?.getMcpElicitationUi();
		const enforced =
			(typeof owner === "function" && owner.enforced?.()) || (ui !== undefined && privateMcpForms(ui) !== undefined);
		if (enforced) {
			return privateElicitation(client, params, extra.signal, extra.requestId, timeoutMs);
		}
		if (ui === undefined) return rejectElicitation();
		return await runElicitationForm(ui, params.message, params.requestedSchema, timeoutMs);
	});
}

/** Exported for tests: drive the form directly with a scripted UI. */
export async function runElicitationForm(
	ui: ElicitationUi,
	message: string,
	requestedSchema: { properties?: Record<string, ElicitProperty>; required?: string[] },
	timeoutMs: number = MCP_ELICITATION_TIMEOUT_MS,
): Promise<ElicitationResponse> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<ElicitationResponse>((resolve) => {
		timer = safeTimer("mcp.elicitation.timeout", timeoutMs, () => resolve({ action: "cancel" }), {
			logger: createMcpLogger("elicitation"),
		});
	});
	try {
		return await Promise.race([collectForm(ui, message, requestedSchema), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function collectForm(
	ui: ElicitationUi,
	message: string,
	requestedSchema: { properties?: Record<string, ElicitProperty>; required?: string[] },
): Promise<ElicitationResponse> {
	const content: Record<string, string | number | boolean> = {};
	const required = new Set(requestedSchema.required ?? []);
	for (const [name, property] of Object.entries(requestedSchema.properties ?? {})) {
		const title = `${message} - ${property.title ?? name}`;
		if (property.type === "boolean") {
			// confirm collapses cancellation into false, including automated RPC replies.
			// A selection preserves dismissal separately from a human's explicit No.
			const picked = await ui.select(property.description ? `${title}\n${property.description}` : title, [
				"Yes",
				"No",
			]);
			if (picked === undefined) return { action: "cancel" };
			// The thread gateway also accepts y/n and true/false, ignoring case and whitespace.
			switch (picked.trim().toLowerCase()) {
				case "yes":
				case "y":
				case "true":
					content[name] = true;
					break;
				case "no":
				case "n":
				case "false":
					content[name] = false;
					break;
				default:
					return rejectElicitation();
			}
			continue;
		}
		if (Array.isArray(property.enum) && property.enum.length > 0) {
			const picked = await ui.select(title, property.enum.map(String));
			if (picked === undefined) return { action: "cancel" };
			content[name] = picked;
			continue;
		}
		const answer = await ui.input(title, property.description);
		if (answer === undefined) return { action: "cancel" };
		if (answer.length === 0) {
			if (required.has(name)) return rejectElicitation();
			continue;
		}
		if (property.type === "number" || property.type === "integer") {
			const parsed = Number(answer);
			if (!Number.isFinite(parsed)) return rejectElicitation();
			content[name] = parsed;
			continue;
		}
		content[name] = answer;
	}
	// Even a fieldless form needs an explicit submission rather than an automatic accept.
	if (Object.keys(content).length === 0 && (await ui.select(message, ["Submit"])) !== "Submit") {
		return { action: "cancel" };
	}
	return { action: "accept", content };
}
