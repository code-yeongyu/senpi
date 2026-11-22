import type { SessionMessageEntry } from "../../core/session-manager.ts";

/** Session-owned cell metadata; live and recently settled cells share the same list shape. */
export interface RpcEvalCell {
	readonly cellId: string;
	readonly language: "js" | "py" | "rb" | "jl";
	readonly state: "queued" | "running" | "detached" | "completed" | "failed" | "cancelled";
	readonly startedAtMs: number;
	readonly summary?: string;
	readonly queuedBehind?: readonly string[];
}

/** Bounded text-only snapshot: no duplicated result body, code, or inline images. */
export interface RpcEvalCellSnapshot extends RpcEvalCell {
	readonly outputTail: string;
	readonly stateRetained?: boolean;
	readonly interruptNote?: string;
	readonly hardLimitSeconds?: number;
	readonly runBudgetSeconds?: number;
}

/** Success payload of `edit_assistant_message`. `leafId` is the session leaf after the call. */
export type EditAssistantMessageResult =
	| { outcome: "edited"; entry: SessionMessageEntry; leafId: string; summaryEntryId?: string }
	| { outcome: "unchanged"; leafId: string | null }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };

/**
 * Success payload of `edit_user_message`, mirroring `EditAssistantMessageResult`. `leafId` is the
 * session leaf after the call and is reported on EVERY outcome so a client resynchronizes in one
 * round trip; it is `null` when the call left the session on an empty conversation.
 */
export type EditUserMessageResult =
	| { outcome: "edited"; entry: SessionMessageEntry; leafId: string; summaryEntryId?: string }
	| { outcome: "unchanged"; leafId: string | null }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };

/**
 * Success payload of an `entryId`-addressed `navigate_tree`. `editorText` is present when the
 * intent is selection and the target is a user/custom message, as in the TUI editor. Resumption
 * never returns editor text. `leafId` is `null` when selection reset the session to an empty
 * conversation, which is what selecting the root user message does.
 */
export type NavigateTreeResult =
	| { outcome: "navigated"; leafId: string | null; editorText?: string; summaryEntryId?: string }
	| { outcome: "cancelled"; leafId: string | null; aborted?: boolean };
