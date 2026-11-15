/**
 * The loop's side of the session port (senpi#6754) for a headless engine session whose tools run on a chosen hand: the
 * session tools (todo, tool_search, ...) run there too, so each call carries this session's facts and its writes are
 * committed back into this session, as the same tools would write it locally.
 */
import type { RemoteSessionPort } from "@earendil-works/pi-agent-core";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../core/agent-session.ts";
import { applyActiveToolsChange, parseSessionEffects, type SessionEffects } from "../../core/hand/session-effects.ts";
import type { SessionEntry, SessionManager } from "../../core/session-manager.ts";

export type LoopPortSession = Pick<
	AgentSession,
	| "sessionId"
	| "isStreaming"
	| "getActiveToolNames"
	| "setActiveToolsByName"
	| "sendCustomMessage"
	| "sendUserMessage"
	| "extensionRunner"
> & { readonly sessionManager: Pick<SessionManager, "getBranch" | "getLeafId" | "getHeader" | "appendCustomEntry"> };

/** What a hand may read of the branch: after the last compaction, the custom entries and the user's messages. */
function carriedBranch(branch: readonly SessionEntry[]): SessionEntry[] {
	const compacted = branch.findLastIndex((entry) => entry.type === "compaction");
	return branch
		.slice(compacted + 1)
		.filter((entry) => entry.type === "custom" || (entry.type === "message" && entry.message.role === "user"));
}

export function createLoopSessionPort(session: LoopPortSession): RemoteSessionPort<SessionEffects> {
	const ui = () => session.extensionRunner.getUIContext();
	const report = (error: unknown) =>
		ui().notify(`A hand's session write failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	return {
		carry: () => {
			const manager = session.sessionManager;
			const branch = carriedBranch(manager.getBranch());
			const header = manager.getHeader();
			return JSON.parse(
				JSON.stringify({
					sessionId: session.sessionId,
					idle: !session.isStreaming,
					leafId: manager.getLeafId(),
					handEntries: branch.filter((entry) => entry.type === "custom"),
					branch,
					...(header === null ? {} : { header }),
					activeTools: session.getActiveToolNames(),
				}),
			) as JsonValue;
		},
		parse: parseSessionEffects,
		commit: (_call, effects) => {
			for (const { customType, data } of effects.entries ?? [])
				session.sessionManager.appendCustomEntry(customType, data);
			if (effects.activeTools !== undefined)
				session.setActiveToolsByName(applyActiveToolsChange(session.getActiveToolNames(), effects.activeTools));
			// Delivered as the session's own `pi.sendMessage` / `pi.sendUserMessage` deliver them: queued, never awaited.
			for (const { message, options } of effects.sent ?? [])
				session.sendCustomMessage(message, options).catch(report);
			for (const { content, options } of effects.userMessages ?? [])
				session.sendUserMessage(content, options).catch(report);
			for (const { message, type } of effects.notices ?? []) ui().notify(message, type);
		},
	};
}
