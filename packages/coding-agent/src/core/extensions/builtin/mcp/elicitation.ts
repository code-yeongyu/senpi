// MCP elicitation, form mode only (todo 41).
//
// The client declares the capability as an EMPTY object — Spring-AI servers
// reject richer shapes (FieldCoding lesson from the comparison corpus) — and
// answers elicitation/create requests mid tool-call by walking the requested
// flat-primitive schema through sequential ctx.ui primitives (input/select/
// confirm; NEVER ctx.ui.custom, which is undefined in RPC mode). Without a UI
// (print mode) the request is declined immediately — spec-correct, no hang.
// The whole form is bounded by a timeout that resolves to cancel so a wedged
// dialog can never wedge the tool-call pipeline. URL mode is deliberately not
// implemented in v1.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionUIContext } from "../../types.ts";
import { createMcpLogger } from "./log.ts";
import { safeTimer } from "./wrap.ts";

/** Declared empty on purpose: maximum server compatibility (form mode only). */
export const MCP_CLIENT_ELICITATION_CAPABILITY = { elicitation: {} } as const;

export const MCP_ELICITATION_TIMEOUT_MS = 5 * 60 * 1000;

type ElicitationUi = Pick<ExtensionUIContext, "input" | "select" | "confirm">;

export type McpElicitationUiProvider = () => ElicitationUi | undefined;
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

/** Wire the elicitation/create handler onto a fresh client. */
export function configureMcpElicitation(
	client: Client,
	owner: McpElicitationUiOwner | McpElicitationUiProvider | undefined = legacyUiProvider,
	timeoutMs: number = MCP_ELICITATION_TIMEOUT_MS,
): void {
	client.setRequestHandler(ElicitRequestSchema, async (request) => {
		const params = request.params;
		// URL mode is deliberately unsupported in v1 (form mode only).
		if (!("requestedSchema" in params)) return { action: "decline" };
		const ui = typeof owner === "function" ? owner() : owner?.getMcpElicitationUi();
		if (ui === undefined) return { action: "decline" };
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
		const title = `${message} — ${property.title ?? name}`;
		if (property.type === "boolean") {
			content[name] = await ui.confirm(title, property.description ?? name);
			continue;
		}
		if (Array.isArray(property.enum) && property.enum.length > 0) {
			const picked = await ui.select(title, property.enum.map(String));
			if (picked === undefined) return { action: "decline" };
			content[name] = picked;
			continue;
		}
		const answer = await ui.input(title, property.description);
		if (answer === undefined || answer.length === 0) {
			if (required.has(name)) return { action: "decline" };
			continue;
		}
		if (property.type === "number" || property.type === "integer") {
			const parsed = Number(answer);
			if (!Number.isFinite(parsed)) return { action: "decline" };
			content[name] = parsed;
			continue;
		}
		content[name] = answer;
	}
	return { action: "accept", content };
}
