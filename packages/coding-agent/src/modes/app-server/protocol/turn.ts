import type {
	AbsolutePathBuf,
	AdditionalContextEntry,
	ApprovalsReviewer,
	AskForApproval,
	JsonValue,
	MultiAgentMode,
	Personality,
	ReasoningEffort,
	ReasoningSummary,
	SandboxPolicy,
	ServiceTier,
	ThreadId,
	TurnEnvironmentParams,
	UserInput,
} from "./base.ts";
import type { CollaborationMode } from "./collaboration-mode.ts";
import type { TurnError, TurnStatus } from "./terminal.ts";

export type TurnsPage = JsonValue;
export type TurnItemsView = "notLoaded" | "summary" | "full";

export type Turn = {
	readonly id: string;
	readonly items: readonly JsonValue[];
	readonly itemsView: TurnItemsView;
	readonly status: TurnStatus;
	readonly error: TurnError | null;
	readonly startedAt: number | null;
	readonly completedAt: number | null;
	readonly durationMs: number | null;
};

type TurnCommonParams = {
	readonly threadId: ThreadId;
	readonly clientUserMessageId?: string | null;
	readonly input: readonly UserInput[];
	readonly responsesapiClientMetadata?: { readonly [key: string]: string | undefined } | null;
	readonly additionalContext?: { readonly [key: string]: AdditionalContextEntry | undefined } | null;
};

export type TurnStartParams = TurnCommonParams & {
	readonly environments?: readonly TurnEnvironmentParams[] | null;
	readonly cwd?: string | null;
	readonly runtimeWorkspaceRoots?: readonly AbsolutePathBuf[] | null;
	readonly approvalPolicy?: AskForApproval | null;
	readonly approvalsReviewer?: ApprovalsReviewer | null;
	readonly sandboxPolicy?: SandboxPolicy | null;
	readonly permissions?: string | null;
	readonly model?: string | null;
	readonly serviceTier?: ServiceTier | null;
	readonly effort?: ReasoningEffort | null;
	readonly summary?: ReasoningSummary | null;
	readonly personality?: Personality | null;
	readonly outputSchema?: JsonValue | null;
	readonly collaborationMode?: CollaborationMode | null;
	readonly multiAgentMode?: MultiAgentMode | null;
};
export type TurnStartResponse = { readonly turn: Turn };
export type TurnSteerParams = TurnCommonParams & { readonly expectedTurnId: string };
export type TurnSteerResponse = { readonly turnId: string };
export type TurnInterruptParams = { readonly threadId: ThreadId; readonly turnId: string };
export type TurnInterruptResponse = Record<string, never>;
