import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "../../types.ts";
import { type DispatchAuthorizer, type DispatchIdentity, prepareDispatchApproval } from "./dispatch.ts";

type IdentityForInput = (input: Record<string, unknown>) => DispatchIdentity | undefined;

// ToolInfo retains the registered schema object. Its identity scopes metadata
// to the offered definition, without adding private fields to provider schemas.
const identities = new WeakMap<object, IdentityForInput>();

export function registerDispatchIdentity(parameters: object, identity: IdentityForInput): void {
	identities.set(parameters, identity);
}

export function getDispatchIdentity(parameters: object, input: Record<string, unknown>): DispatchIdentity | undefined {
	return identities.get(parameters)?.(input);
}

export function prepareMcpDispatchApproval(
	pi: Pick<ExtensionAPI, "getAllTools">,
	event: ToolCallEvent,
	ctx: ExtensionContext,
	authorizer: DispatchAuthorizer,
): (() => void) | undefined {
	// Other tools retain their existing preflight path, including calls while
	// the extension runtime is still starting and cannot list tools (#2617).
	if (!event.toolName.startsWith("mcp_")) return undefined;
	const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
	const identity = tool === undefined ? undefined : getDispatchIdentity(tool.parameters, event.input);
	if (identity === undefined) return undefined;
	const request = { ...event, identity };
	return prepareDispatchApproval(ctx.sessionManager, request, authorizer.policy(request, ctx));
}
