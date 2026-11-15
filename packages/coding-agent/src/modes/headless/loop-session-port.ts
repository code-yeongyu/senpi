/**
 * The loop's side of the session port (senpi#6754) for a headless engine session whose tools run on a chosen hand: the
 * session tools (todo, tool_search, ...) run there too, so each of their calls carries this session's facts and its
 * writes are committed back into this session, as the same tools would write it locally. Other calls carry nothing.
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
	| "appendCustomSessionEntry"
	| "sendCustomMessage"
	| "sendUserMessage"
	| "extensionRunner"
> & { readonly sessionManager: Pick<SessionManager, "getBranch" | "getLeafId" | "getHeader"> };

/**
 * The tools whose subject is the session, which alone carry it. The same set the S-CAT catalog marks
 * `ToolDefinition.sessionBound` (#6757); once that lands this reads the flag from the session's own definitions.
 */
export const SESSION_BOUND_TOOLS: ReadonlySet<string> = new Set([
	"todo",
	"create_goal",
	"update_goal",
	"get_goal",
	"tool_search",
	"schedule_wakeup",
	"schedule_prompt",
	"list_relocation_targets",
	"relocate_session",
]);

/** What a hand may read of the branch: after the last compaction, the custom entries and the user's messages. */
function carriedBranch(branch: readonly SessionEntry[]): SessionEntry[] {
	const compacted = branch.findLastIndex((entry) => entry.type === "compaction");
	return branch
		.slice(compacted + 1)
		.filter((entry) => entry.type === "custom" || (entry.type === "message" && entry.message.role === "user"));
}

/** A commit that stopped part-way: what landed in the session before `cause`, so nothing is reported twice or lost. */
export class SessionCommitError extends Error {
	override readonly name = "SessionCommitError";
	readonly landedEntryIds: readonly string[];
	constructor(landedEntryIds: readonly string[], cause: unknown) {
		const why = cause instanceof Error ? cause.message : String(cause);
		const landed = landedEntryIds.length === 0 ? "nothing landed" : `entries ${landedEntryIds.join(", ")} landed`;
		super(`the hand's session writes stopped part-way (${landed}; nothing else was applied): ${why}`, { cause });
		this.landedEntryIds = landedEntryIds;
	}
}

export function createLoopSessionPort(session: LoopPortSession): RemoteSessionPort<SessionEffects> {
	const ui = () => session.extensionRunner.getUIContext();
	const report = (error: unknown) =>
		ui().notify(`A hand's session write failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	return {
		carry: (call) => {
			if (!SESSION_BOUND_TOOLS.has(call.name)) return undefined;
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
		sessionId: () => session.sessionId,
		parse: parseSessionEffects,
		/**
		 * All or nothing, as far as an append-only log allows: everything is checked before anything is applied; entries
		 * land first, and if one fails the error names those that landed (a durable entry cannot be withdrawn) and nothing
		 * else is applied; the active set comes next and is restored if a later step throws; messages and notices last.
		 */
		commit: (_call, effects) => {
			// This port carries no documents, wakes or relocation offer, so no call can rightly change them.
			if (effects.documents !== undefined || effects.wakes !== undefined || effects.relocation !== undefined)
				throw new Error("the hand changed session state this session did not carry");
			const landed: string[] = [];
			try {
				for (const { customType, data } of effects.entries ?? [])
					landed.push(session.appendCustomSessionEntry(customType, data));
			} catch (error) {
				throw new SessionCommitError(landed, error);
			}
			const before = session.getActiveToolNames();
			try {
				if (effects.activeTools !== undefined)
					session.setActiveToolsByName(applyActiveToolsChange(before, effects.activeTools));
				// Delivered as the session's own `pi.sendMessage` / `pi.sendUserMessage` deliver them: queued, never awaited.
				for (const { message, options } of effects.sent ?? [])
					session.sendCustomMessage(message, options).catch(report);
				for (const { content, options } of effects.userMessages ?? [])
					session.sendUserMessage(content, options).catch(report);
				for (const { message, type } of effects.notices ?? []) ui().notify(message, type);
				if ((effects.droppedLate ?? 0) > 0)
					ui().notify(`${effects.droppedLate} late messages from the hand were dropped`, "warning");
			} catch (error) {
				session.setActiveToolsByName(before);
				throw new SessionCommitError(landed, error);
			}
		},
	};
}
