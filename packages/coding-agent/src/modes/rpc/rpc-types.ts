/** Public RPC protocol surface. Definitions are grouped by responsibility. */

export type { RpcSnapshot, RpcSnapshotMarker, RpcUiRequestEvent } from "./snapshot-types.ts";

export type { SessionContext, SessionKind } from "../../core/extensions/types.ts";
export type { RpcCommandInvocationEvent } from "./rpc-command-invocation.ts";
export type { RpcCommandsChangedEvent, RpcSlashCommand } from "./rpc-command-surface.ts";
export type {
	RpcAbortQuiesce,
	RpcEffectAnswer,
	RpcQueuedInputChange,
	RpcUnloadAnswer,
	UnloadRefusalReason,
} from "./rpc-effect-answer-types.ts";
export type { RpcErrorCode } from "./rpc-error-types.ts";
export {
	RPC_ERROR_ATTACHED,
	RPC_ERROR_ATTACHED_ELSEWHERE,
	RPC_ERROR_CONTEXT_BUDGET,
	RPC_ERROR_EFFECT_ID_CONFLICT,
	RPC_ERROR_EMPTY_TEXT,
	RPC_ERROR_ENTRY_NOT_FOUND,
	RPC_ERROR_EVAL_CELL_NOT_FOUND,
	RPC_ERROR_EVAL_CELLS_UNAVAILABLE,
	RPC_ERROR_HOST_DRAINING,
	RPC_ERROR_HOST_MEMORY_PRESSURE,
	RPC_ERROR_HOST_STOPPING,
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_INVALID_EVAL_CELL_REQUEST,
	RPC_ERROR_INVALID_LAUNCH_PROFILE,
	RPC_ERROR_INVALID_PATH,
	RPC_ERROR_INVALID_RELEASE_REASON,
	RPC_ERROR_INVALID_SESSION_CONTEXT,
	RPC_ERROR_INVALID_SESSION_ENV,
	RPC_ERROR_INVALID_SESSION_ID,
	RPC_ERROR_INVALID_SESSION_KIND,
	RPC_ERROR_INVALID_SUBSCRIPTION,
	RPC_ERROR_MEDIA_NOT_FOUND,
	RPC_ERROR_MISSING_SESSION_ID,
	RPC_ERROR_MODEL_NOT_FOUND,
	RPC_ERROR_MULTI_SESSION_DISABLED,
	RPC_ERROR_NOT_ASSISTANT,
	RPC_ERROR_NOT_USER,
	RPC_ERROR_OPEN_FAILED,
	RPC_ERROR_OWNER_CHANGED,
	RPC_ERROR_PROVIDER_UNAVAILABLE,
	RPC_ERROR_RELEASE_FAILED,
	RPC_ERROR_RELEASE_UNSUPPORTED,
	RPC_ERROR_RESPONSE_TOO_LARGE,
	RPC_ERROR_SESSION_BUSY,
	RPC_ERROR_SESSION_BUSY_LIFECYCLE,
	RPC_ERROR_SESSION_CLOSING,
	RPC_ERROR_SESSION_HELD,
	RPC_ERROR_SESSION_ID_IN_USE,
	RPC_ERROR_SESSION_IDENTITY_MISMATCH,
	RPC_ERROR_SESSION_NOT_ATTACHED,
	RPC_ERROR_SESSION_NOT_HELD,
	RPC_ERROR_SESSION_PATH_IN_USE,
	RPC_ERROR_SESSION_RESERVATION_LIMIT,
	RPC_ERROR_STALE_LEAF,
	RPC_ERROR_STREAMING,
	RPC_ERROR_SUBSCRIPTION_LIMIT,
	RPC_ERROR_TRANSCRIPT_UNREADABLE,
	RPC_ERROR_TURN_ACTIVE,
	RPC_ERROR_UNKNOWN_COMMAND,
	RPC_ERROR_UNKNOWN_SESSION,
	RPC_ERROR_UNKNOWN_SUBSCRIPTION,
	RPC_ERROR_UNSUPPORTED_TRANSPORT,
	RPC_ERROR_WARM_FAILED,
} from "./rpc-error-types.ts";
export type { RpcCommand, RpcInboundRecord } from "./rpc-host-command-types.ts";
export type { RpcHostRequest, RpcHostResponse, RpcRelocationDueEvent } from "./rpc-relocation-types.ts";
export type {
	RpcHostKernelMemory,
	RpcHostLifecycleEvent,
	RpcHostMemoryPressureEvent,
	RpcHostStalledEvent,
	RpcHostSupersededEvent,
	RpcHostTrimmedEvent,
	RpcSubscriptionLimitsEvent,
} from "./rpc-host-lifecycle-types.ts";
export type {
	RpcLaunchProfile,
	RpcLaunchProfileCore,
	RpcProtocolIdentity,
	RpcProtocolInfo,
} from "./rpc-protocol-info-types.ts";
export type {
	RpcExtensionUIProgress,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcQuestionAnswers,
	RpcQuestionOutcome,
	RpcQuestionResolvedEvent,
	RpcQuestionSpec,
	RpcQuestionUiRequest,
	RpcQuestionUpdatedEvent,
} from "./rpc-question-types.ts";
export type { RpcResponse } from "./rpc-response-types.ts";
export type {
	EditAssistantMessageResult,
	EditUserMessageResult,
	NavigateTreeResult,
	RpcEvalCell,
	RpcEvalCellSnapshot,
} from "./rpc-result-types.ts";
export type { RpcWhenIdle } from "./rpc-session-command-types.ts";
export { STEER_WHEN_IDLE_CAPABILITY, USER_ACTIVITY_CAPABILITY } from "./rpc-session-command-types.ts";
export type {
	RpcAccountFailoverEvent,
	RpcAuthAccountsChangedEvent,
	RpcExtensionEvent,
	RpcHighReasoningWarningEvent,
	RpcLoadedSurfacesChangedEvent,
	RpcModelChangedEvent,
	RpcOpenQueuedEvent,
	RpcPendingInputUpdateEvent,
	RpcServiceTierChangedEvent,
	RpcSessionClosedEvent,
	RpcSessionClosedReason,
	RpcSessionOpenedEvent,
	RpcSessionParkedEvent,
	RpcSessionReplacedEvent,
	RpcSettingsSourceSelectedEvent,
	RpcSkillInvocationEvent,
	RpcThinkingLevelChangedEvent,
} from "./rpc-session-event-types.ts";
export type {
	RpcAuthProvider,
	RpcAuthStatus,
	RpcLoadedExtension,
	RpcLoadedMcpServer,
	RpcMcpServerStatus,
	RpcProviderAccount,
	RpcSessionModelEntry,
	RpcSessionState,
} from "./rpc-session-state-types.ts";
export type { SessionEffectStatusRecord as RpcEffectStatusEvent } from "./session-effect-status.ts";
export type { SessionStatusRecord as RpcSessionStatusEvent } from "./session-status.ts";
