import type {
	ActivePermissionProfile,
	ApprovalsReviewer,
	AskForApproval,
	JsonValue,
	MultiAgentMode,
	Personality,
	ReasoningEffort,
	ReasoningSummary,
	SandboxPolicy,
	SortDirection,
	ThreadSourceKind,
} from "./base.ts";
import type { CollaborationMode } from "./collaboration-mode.ts";
import type { Thread } from "./thread.ts";
import type { Turn, TurnItemsView } from "./turn.ts";

export type ThreadSearchParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly sortKey?: "created_at" | "updated_at" | "recency_at" | null;
	readonly sortDirection?: SortDirection | null;
	readonly sourceKinds?: readonly ThreadSourceKind[] | null;
	readonly archived?: boolean | null;
	readonly searchTerm: string;
};
export type ThreadSearchResult = { readonly thread: Thread; readonly snippet: string };
export type ThreadSearchResponse = {
	readonly data: readonly ThreadSearchResult[];
	readonly nextCursor: string | null;
	readonly backwardsCursor: string | null;
};

export type ThreadSearchOccurrencesParams = {
	readonly threadId: string;
	readonly searchTerm: string;
	readonly cursor?: string | null;
	readonly limit?: number | null;
};
export type ThreadSearchTextRange = { readonly start: number; readonly end: number };
export type ThreadSearchOccurrence = {
	readonly turnId: string;
	readonly itemId: string;
	readonly snippet: string;
	readonly snippetMatchRange: ThreadSearchTextRange;
	readonly turnCursor: string;
};
export type ThreadSearchOccurrencesResponse = {
	readonly data: readonly ThreadSearchOccurrence[];
	readonly nextCursor: string | null;
};

export type ThreadTurnsListParams = {
	readonly threadId: string;
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly sortDirection?: SortDirection | null;
	readonly itemsView?: TurnItemsView | null;
};
export type ThreadTurnsListResponse = {
	readonly data: readonly Turn[];
	readonly nextCursor: string | null;
	readonly backwardsCursor: string | null;
};

export type ThreadItem = {
	readonly id: string;
	readonly type: string;
	readonly [key: string]: JsonValue | undefined;
};
export type PatchChangeKind =
	| { readonly type: "add" }
	| { readonly type: "delete" }
	| { readonly type: "update"; readonly move_path: string | null };
export type FileUpdateChange = {
	readonly path: string;
	readonly kind: PatchChangeKind;
	readonly diff: string;
};
export type ThreadItemEntry = { readonly turnId: string; readonly item: ThreadItem };
export type ThreadItemsListParams = {
	readonly threadId: string;
	readonly turnId?: string | null;
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly sortDirection?: SortDirection | null;
};
export type ThreadItemsListResponse = {
	readonly data: readonly ThreadItemEntry[];
	readonly nextCursor: string | null;
	readonly backwardsCursor: string | null;
};

export type ThreadCompactStartParams = { readonly threadId: string };
export type ThreadCompactStartResponse = Record<string, never>;
export type ThreadUnarchiveParams = { readonly threadId: string };
export type ThreadUnarchiveResponse = { readonly thread: Thread };

export type ThreadGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type ThreadGoal = {
	readonly threadId: string;
	readonly objective: string;
	readonly status: ThreadGoalStatus;
	readonly tokenBudget: number | null;
	readonly tokensUsed: number;
	readonly timeUsedSeconds: number;
	readonly createdAt: number;
	readonly updatedAt: number;
};
export type ThreadGoalSetParams = {
	readonly threadId: string;
	readonly objective?: string | null;
	readonly status?: ThreadGoalStatus | null;
	readonly tokenBudget?: number | null;
};
export type ThreadGoalSetResponse = { readonly goal: ThreadGoal };
export type ThreadGoalGetParams = { readonly threadId: string };
export type ThreadGoalGetResponse = { readonly goal: ThreadGoal | null };
export type ThreadGoalClearParams = { readonly threadId: string };
export type ThreadGoalClearResponse = { readonly cleared: boolean };

export type ThreadSettingsUpdateParams = {
	readonly threadId: string;
	readonly cwd?: string | null;
	readonly approvalPolicy?: AskForApproval | null;
	readonly approvalsReviewer?: ApprovalsReviewer | null;
	readonly sandboxPolicy?: SandboxPolicy | null;
	readonly permissions?: string | null;
	readonly model?: string | null;
	readonly serviceTier?: string | null;
	readonly effort?: ReasoningEffort | null;
	readonly summary?: ReasoningSummary | null;
	readonly collaborationMode?: CollaborationMode | null;
	readonly multiAgentMode?: MultiAgentMode | null;
	readonly personality?: Personality | null;
};
export type ThreadSettingsUpdateResponse = Record<string, never>;
export type ThreadSettings = {
	readonly cwd: string;
	readonly approvalPolicy: AskForApproval;
	readonly approvalsReviewer: ApprovalsReviewer;
	readonly sandboxPolicy: SandboxPolicy;
	readonly activePermissionProfile: ActivePermissionProfile | null;
	readonly model: string;
	readonly modelProvider: string;
	readonly serviceTier: string | null;
	readonly effort: ReasoningEffort | null;
	readonly summary: ReasoningSummary | null;
	readonly collaborationMode: CollaborationMode;
	readonly multiAgentMode?: MultiAgentMode;
	readonly personality: Personality | null;
};

export type ThreadMetadataGitInfoUpdateParams = {
	readonly sha?: string | null;
	readonly branch?: string | null;
	readonly originUrl?: string | null;
};
export type ThreadMetadataUpdateParams = {
	readonly threadId: string;
	readonly gitInfo?: ThreadMetadataGitInfoUpdateParams | null;
};
export type ThreadMetadataUpdateResponse = { readonly thread: Thread };
