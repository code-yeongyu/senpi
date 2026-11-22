import { getMcpMrtrPresentation, type McpMrtrPresentation } from "../../../mcp-mrtr-presentations.ts";
import type { ExtensionUIContext } from "../../types.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import { McpMrtrError } from "./modern/errors.ts";
import { createMcpRequestOrigin, type McpRequestOrigin } from "./request-origin.ts";
import type { McpConnectionEntry, McpSessionContext } from "./service-types.ts";

type McpScopeUi = Pick<ExtensionUIContext, "input" | "select" | "confirm"> &
	Partial<Pick<ExtensionUIContext, "notify">>;
type McpCaller = { readonly sessionManager?: object };

/**
 * One execution scope a binding serves beside its own context (brain/hand S16c): a runtime that serves several
 * scopes keeps each one's MCP forms, presentation and control inventory instead of the latest scope taking them.
 */
interface McpBindingScope {
	readonly sessionId: string | undefined;
	presentation: McpMrtrPresentation | undefined;
	readonly ui: () => McpScopeUi | undefined;
}

export interface McpScopedBinding {
	readonly lifetime: AbortController;
	presentation?: McpMrtrPresentation;
	readonly context: McpSessionContext;
	readonly config: ResolvedMcpConfig;
	/** Further scopes of one runtime this binding also serves, by session manager; empty for one session. */
	readonly scopes: Map<object, McpBindingScope>;
	/** Its own context's elicitation UI, so a scoped call of that context opens its form there and not in a peer's. */
	readonly ui: () => McpScopeUi | undefined;
}

/** A context's elicitation UI, read per request: a host that offers none answers no form (`hasUI` false). */
export function elicitationUiOf(ctx: McpSessionContext): () => McpScopeUi | undefined {
	return () => (ctx.hasUI === false ? undefined : ctx.ui);
}

/**
 * A further scope joins the binding and returns its session id; the binding's own context, or a context with no
 * session manager, joins nothing.
 */
export function joinBindingScope(
	binding: McpScopedBinding,
	ctx: McpSessionContext,
): { sessionId?: string } | undefined {
	const sessionManager = ctx.sessionManager;
	if (sessionManager === undefined || sessionManager === binding.context.sessionManager) return undefined;
	const sessionId = sessionManager.getSessionId?.();
	binding.scopes.set(sessionManager, {
		sessionId,
		presentation: ctx.ui === undefined ? undefined : getMcpMrtrPresentation(ctx.ui),
		ui: elicitationUiOf(ctx),
	});
	return { sessionId };
}

/** A joined scope presents its own forms; the binding's own context keeps the binding's presentation. */
export function bindScopePresentation(
	binding: McpScopedBinding,
	presentation: McpMrtrPresentation,
	sessionManager: object | undefined,
): void {
	const scope = sessionManager === undefined ? undefined : binding.scopes.get(sessionManager);
	if (scope === undefined) binding.presentation = presentation;
	else scope.presentation = presentation;
}

export function bindingServesScope(binding: McpScopedBinding, sessionManager: object | undefined): boolean {
	return sessionManager !== undefined && binding.scopes.has(sessionManager);
}

export function bindingServesScopeSession(binding: McpScopedBinding, sessionId: string): boolean {
	return [...binding.scopes.values()].some((scope) => scope.sessionId === sessionId);
}

/**
 * The scope a call belongs to while its binding serves several. A binding serving its own context alone resolves to
 * none, and its requests carry no scope: the single-session path is unchanged.
 */
function callerScope(binding: McpScopedBinding, caller: McpCaller | undefined) {
	const key = caller?.sessionManager;
	if (binding.scopes.size === 0 || key === undefined) return undefined;
	const joined = binding.scopes.get(key);
	if (joined !== undefined) return { key, presentation: joined.presentation, ui: joined.ui };
	return key === binding.context.sessionManager
		? { key, presentation: binding.presentation, ui: binding.ui }
		: undefined;
}

/** A request's origin for `caller`: its scope's presentation and form UI, under the binding's own lifetime. */
export function scopedRequestOrigin(
	binding: McpScopedBinding,
	entry: McpConnectionEntry,
	caller: McpCaller | undefined,
	isCurrent: () => boolean,
): McpRequestOrigin {
	const source = binding.config.servers[entry.name]?.source;
	const scope = callerScope(binding, caller);
	const presentation = scope === undefined ? binding.presentation : scope.presentation;
	return createMcpRequestOrigin({
		binding,
		connection: entry.connection,
		signal: AbortSignal.any([binding.lifetime.signal, entry.connection.requestLifetimeSignal]),
		presentation,
		privateFormsEnforced: presentation?.privateForms !== undefined,
		privateForm: presentation?.privateForms?.capture(),
		scope: scope?.key,
		elicitationUi: scope?.ui,
		serverLabel: entry.name,
		serverSource:
			source === "project" || source === "claude"
				? "project"
				: source === "skill" || source === "extension"
					? "plugin"
					: "user",
		isCurrent,
		resolveAuthority: async (signal) => {
			if (await entry.generationChanged?.()) throw new McpMrtrError("MCP_MRTR_CONTEXT_CHANGED");
			// Same observed-revocation boundary as ordinary MCP requests. Never prompts for a new grant.
			return await entry.connection.projectPolicy?.resolve(signal, false);
		},
	});
}
