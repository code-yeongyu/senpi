import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../types.ts";
import type { DispatchAuthorizer, DispatchPolicy } from "./dispatch.ts";
import { type ParserRegistry, toolOwnedPermissionRequests } from "./parsers.ts";
import type { PermissionService } from "./service.ts";
import type { PermissionPresetName } from "./types.ts";

export interface DispatchPermissionState {
	readonly service: PermissionService | null;
	readonly parsers: ParserRegistry | null;
	readonly preset: PermissionPresetName | null;
	readonly setupError: string | null;
}

/** Use the permission extension's live parser, evaluator and approval handler. */
export function createDispatchAuthorizer(
	pi: Pick<ExtensionAPI, "getAllTools">,
	stateFor: (ctx: ExtensionContext) => DispatchPermissionState,
	authorize: (
		event: ToolCallEvent,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	) => Promise<ToolCallEventResult | undefined>,
): DispatchAuthorizer {
	return {
		policy(request, ctx): DispatchPolicy {
			const state = stateFor(ctx);
			if (state.setupError !== null) throw new Error(`Permission setup failed: ${state.setupError}`);
			const { service, parsers } = state;
			if (!service || !parsers) throw new Error("Permission authorizer is not initialized");
			const requests = parsers.has(request.toolName)
				? parsers.parse(request.toolName, request.input, ctx.cwd)
				: (toolOwnedPermissionRequests(pi.getAllTools(), request.toolName, request.input, ctx.cwd) ??
					parsers.parse(request.toolName, request.input, ctx.cwd));
			let action: DispatchPolicy["action"] = "allow";
			const decisions = requests.map((permission) => {
				const rules = permission.patterns.map((pattern) =>
					service.dispatchDecision(permission.permission, permission.ruleAliases ?? pattern, {
						presetBound: state.preset === "auto",
					}),
				);
				for (const decision of rules) {
					if (decision.action === "deny") action = "deny";
					else if (decision.action === "ask" && !permission.autoApproveAsk && action !== "deny") action = "ask";
				}
				return { permission, rules };
			});
			return {
				action,
				fingerprint: JSON.stringify([
					ctx.sessionManager.getSessionId(),
					ctx.cwd,
					state.preset === "auto",
					decisions,
				]),
			};
		},
		async ask(request, ctx, signal): Promise<void> {
			signal?.throwIfAborted();
			const result = await authorize(
				{
					type: "tool_call",
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					input: request.input,
					...(request.parentToolCallId === undefined ? {} : { parentToolCallId: request.parentToolCallId }),
				},
				ctx,
				signal,
			);
			if (result?.block) throw new Error(result.reason ?? "Permission request was rejected.");
		},
	};
}
