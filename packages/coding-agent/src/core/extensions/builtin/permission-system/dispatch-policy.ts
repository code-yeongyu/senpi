import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "../../types.ts";
import type { DispatchAuthorizer, DispatchPolicy, DispatchRequest } from "./dispatch.ts";
import { type ParserRegistry, permissionRequestsFor } from "./parsers.ts";
import { decideWithPathFacts, PathFacts } from "./path-facts.ts";
import type { PermissionService } from "./service.ts";
import type { PermissionPresetName } from "./types.ts";

export interface DispatchPermissionState {
	readonly service: PermissionService | null;
	readonly parsers: ParserRegistry | null;
	readonly preset: PermissionPresetName | null;
	readonly setupError: string | null;
}

/** Facts each dispatched call prepared, by its input object (the key the dispatch approvals use too). */
const preparedFacts = new WeakMap<object, PathFacts>();

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
	const decide = (request: DispatchRequest, ctx: ExtensionContext, facts: PathFacts): DispatchPolicy => {
		const state = stateFor(ctx);
		if (state.setupError !== null) throw new Error(`Permission setup failed: ${state.setupError}`);
		const { service, parsers } = state;
		if (!service || !parsers) throw new Error("Permission authorizer is not initialized");
		const requests = permissionRequestsFor(
			() => pi.getAllTools(),
			parsers,
			request.toolName,
			request.input,
			ctx.cwd,
			facts,
		);
		// The same session key the tool_call check gives its requests, so only this session's answers count.
		const sessionID = ctx.sessionManager === undefined ? "" : ctx.sessionManager.getSessionId();
		let action: DispatchPolicy["action"] = "allow";
		const decisions = requests.map((permission) => {
			const rules = permission.patterns.map((pattern) =>
				service.dispatchDecision(
					permission.permission,
					pattern,
					{
						presetBound: state.preset === "auto",
						ruleAliases: permission.ruleAliases,
						originalPaths: permission.originalPaths,
						facts,
					},
					sessionID,
				),
			);
			for (const decision of rules) {
				if (decision.action === "deny") action = "deny";
				else if (decision.action === "ask" && !permission.autoApproveAsk && action !== "deny") action = "ask";
			}
			return { permission, rules };
		});
		return {
			action,
			fingerprint: JSON.stringify([sessionID, ctx.cwd, state.preset === "auto", decisions]),
		};
	};
	return {
		async prepare(request, ctx): Promise<void> {
			const facts = new PathFacts();
			await decideWithPathFacts(() => decide(request, ctx, facts), facts);
			preparedFacts.set(request.input, facts);
		},
		// The fence runs this synchronously: it reads the facts its call prepared, and anything not prepared reads as
		// pending, which never allows more than the prepared decision did.
		policy: (request, ctx) => decide(request, ctx, preparedFacts.get(request.input) ?? new PathFacts()),
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
