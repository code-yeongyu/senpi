import type {
	AbsolutePathBuf,
	ActivePermissionProfile,
	ApprovalsReviewer,
	AskForApproval,
	DynamicToolSpec,
	GitInfo,
	JsonValue,
	LegacyAppPathString,
	MultiAgentMode,
	Personality,
	ReasoningEffort,
	SandboxMode,
	SandboxPolicy,
	SelectedCapabilityRoot,
	ServiceTier,
	SessionSource,
	SortDirection,
	ThreadId,
	ThreadSource,
	ThreadSourceKind,
	ThreadStartSource,
	ThreadStatus,
	ThreadUnsubscribeStatus,
	TurnEnvironmentParams,
} from "./base.ts";
import type { Turn, TurnsPage } from "./turn.ts";

export type ThreadSortKey = "created_at" | "updated_at" | "recency_at";

export type Thread = {
	readonly id: string;
	readonly sessionId: string;
	readonly forkedFromId: string | null;
	readonly parentThreadId: string | null;
	readonly preview: string;
	readonly ephemeral: boolean;
	readonly modelProvider: string;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly recencyAt: number | null;
	readonly status: ThreadStatus;
	readonly path: string | null;
	readonly cwd: AbsolutePathBuf;
	readonly cliVersion: string;
	readonly source: SessionSource;
	readonly threadSource: ThreadSource | null;
	readonly agentNickname: string | null;
	readonly agentRole: string | null;
	readonly gitInfo: GitInfo | null;
	readonly name: string | null;
	readonly turns: readonly Turn[];
};

type ThreadRuntimeOverrides = {
	readonly model?: string | null;
	readonly modelProvider?: string | null;
	readonly serviceTier?: ServiceTier | null;
	readonly cwd?: string | null;
	readonly runtimeWorkspaceRoots?: readonly AbsolutePathBuf[] | null;
	readonly approvalPolicy?: AskForApproval | null;
	readonly approvalsReviewer?: ApprovalsReviewer | null;
	readonly sandbox?: SandboxMode | null;
	readonly permissions?: string | null;
	readonly config?: { readonly [key: string]: JsonValue | undefined } | null;
	readonly baseInstructions?: string | null;
	readonly developerInstructions?: string | null;
};

type ThreadRuntimeResponse = {
	readonly thread: Thread;
	readonly model: string;
	readonly modelProvider: string;
	readonly serviceTier: string | null;
	readonly cwd: AbsolutePathBuf;
	readonly runtimeWorkspaceRoots: readonly AbsolutePathBuf[];
	readonly instructionSources: readonly LegacyAppPathString[];
	readonly approvalPolicy: AskForApproval;
	readonly approvalsReviewer: ApprovalsReviewer;
	readonly sandbox: SandboxPolicy;
	readonly activePermissionProfile: ActivePermissionProfile | null;
	readonly reasoningEffort: ReasoningEffort | null;
	readonly multiAgentMode: MultiAgentMode;
};

export type ThreadStartParams = ThreadRuntimeOverrides & {
	readonly serviceName?: string | null;
	readonly personality?: Personality | null;
	readonly multiAgentMode?: MultiAgentMode | null;
	readonly ephemeral?: boolean | null;
	readonly sessionStartSource?: ThreadStartSource | null;
	readonly threadSource?: ThreadSource | null;
	readonly environments?: readonly TurnEnvironmentParams[] | null;
	readonly dynamicTools?: readonly DynamicToolSpec[] | null;
	readonly selectedCapabilityRoots?: readonly SelectedCapabilityRoot[] | null;
	readonly mockExperimentalField?: string | null;
	readonly experimentalRawEvents?: boolean;
};

export type ThreadStartResponse = ThreadRuntimeResponse;

export type ThreadResumeParams = ThreadRuntimeOverrides & {
	readonly threadId: ThreadId;
	readonly history?: readonly JsonValue[] | null;
	readonly path?: string | null;
	readonly personality?: Personality | null;
	readonly excludeTurns?: boolean;
	readonly initialTurnsPage?: JsonValue | null;
};

export type ThreadResumeResponse = ThreadRuntimeResponse & {
	readonly initialTurnsPage: TurnsPage | null;
};

export type ThreadForkParams = ThreadRuntimeOverrides & {
	readonly threadId: ThreadId;
	readonly path?: string | null;
	readonly ephemeral?: boolean;
	readonly threadSource?: ThreadSource | null;
	readonly excludeTurns?: boolean;
};

export type ThreadForkResponse = ThreadRuntimeResponse;

export type ThreadReadParams = { readonly threadId: ThreadId; readonly includeTurns?: boolean };
export type ThreadReadResponse = { readonly thread: Thread };
export type ThreadListParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly sortKey?: ThreadSortKey | null;
	readonly sortDirection?: SortDirection | null;
	readonly modelProviders?: readonly string[] | null;
	readonly sourceKinds?: readonly ThreadSourceKind[] | null;
	readonly archived?: boolean | null;
	readonly cwd?: string | readonly string[] | null;
	readonly useStateDbOnly?: boolean;
	readonly searchTerm?: string | null;
	readonly parentThreadId?: string | null;
};
export type ThreadListResponse = {
	readonly data: readonly Thread[];
	readonly nextCursor: string | null;
	readonly backwardsCursor: string | null;
};
export type ThreadLoadedListParams = { readonly cursor?: string | null; readonly limit?: number | null };
export type ThreadLoadedListResponse = { readonly data: readonly Thread[]; readonly nextCursor: string | null };
export type ThreadSetNameParams = { readonly threadId: ThreadId; readonly name: string };
export type ThreadSetNameResponse = Record<string, never>;
export type ThreadArchiveParams = { readonly threadId: ThreadId };
export type ThreadArchiveResponse = Record<string, never>;
export type ThreadDeleteParams = { readonly threadId: ThreadId };
export type ThreadDeleteResponse = Record<string, never>;
export type ThreadUnsubscribeParams = { readonly threadId: ThreadId };
export type ThreadUnsubscribeResponse = { readonly status: ThreadUnsubscribeStatus };
