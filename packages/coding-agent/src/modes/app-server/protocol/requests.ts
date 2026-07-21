import type { AccountRateLimitsReadParams, AccountReadParams, AccountUsageReadParams } from "./account.ts";
import type { InitializeParams, JsonValue, RequestId } from "./base.ts";
import type {
	ExperimentalFeatureListParams,
	McpServerStatusListParams,
	PermissionProfileListParams,
	RemoteControlClientListParams,
	RemoteControlStatusReadParams,
	SkillsListParams,
} from "./catalogs.ts";
import type { CollaborationModeListParams } from "./collaboration-mode.ts";
import type { ConfigReadParams, ConfigRequirementsReadParams } from "./config.ts";
import type {
	FuzzyFileSearchParams,
	FuzzyFileSearchSessionStartParams,
	FuzzyFileSearchSessionStopParams,
	FuzzyFileSearchSessionUpdateParams,
} from "./fuzzy-search.ts";
import type {
	EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS,
	SERVER_REQUEST_METHODS,
	STABLE_CLIENT_REQUEST_METHODS,
} from "./methods.ts";
import type { ModelListParams } from "./models.ts";
import type {
	ThreadArchiveParams,
	ThreadDeleteParams,
	ThreadForkParams,
	ThreadListParams,
	ThreadLoadedListParams,
	ThreadReadParams,
	ThreadResumeParams,
	ThreadSetNameParams,
	ThreadStartParams,
	ThreadUnsubscribeParams,
} from "./thread.ts";
import type {
	ThreadCompactStartParams,
	ThreadGoalClearParams,
	ThreadGoalGetParams,
	ThreadGoalSetParams,
	ThreadItemsListParams,
	ThreadMetadataUpdateParams,
	ThreadSearchOccurrencesParams,
	ThreadSearchParams,
	ThreadSettingsUpdateParams,
	ThreadTurnsListParams,
	ThreadUnarchiveParams,
} from "./thread-parity.ts";
import type { TurnInterruptParams, TurnStartParams, TurnSteerParams } from "./turn.ts";

export type StableClientRequestMethod = (typeof STABLE_CLIENT_REQUEST_METHODS)[number];
export type ExperimentalOnlyClientRequestMethod = (typeof EXPERIMENTAL_ONLY_CLIENT_REQUEST_METHODS)[number];
export type ServerRequestMethod = (typeof SERVER_REQUEST_METHODS)[number];

export type ClientRequest =
	| { readonly method: "initialize"; readonly id: RequestId; readonly params: InitializeParams }
	| { readonly method: "account/read"; readonly id: RequestId; readonly params: AccountReadParams }
	| {
			readonly method: "account/rateLimits/read";
			readonly id: RequestId;
			readonly params?: AccountRateLimitsReadParams;
	  }
	| { readonly method: "account/usage/read"; readonly id: RequestId; readonly params?: AccountUsageReadParams }
	| {
			readonly method: "collaborationMode/list";
			readonly id: RequestId;
			readonly params: CollaborationModeListParams;
	  }
	| { readonly method: "config/read"; readonly id: RequestId; readonly params: ConfigReadParams }
	| {
			readonly method: "configRequirements/read";
			readonly id: RequestId;
			readonly params?: ConfigRequirementsReadParams;
	  }
	| {
			readonly method: "experimentalFeature/list";
			readonly id: RequestId;
			readonly params: ExperimentalFeatureListParams;
	  }
	| { readonly method: "fuzzyFileSearch"; readonly id: RequestId; readonly params: FuzzyFileSearchParams }
	| {
			readonly method: "fuzzyFileSearch/sessionStart";
			readonly id: RequestId;
			readonly params: FuzzyFileSearchSessionStartParams;
	  }
	| {
			readonly method: "fuzzyFileSearch/sessionStop";
			readonly id: RequestId;
			readonly params: FuzzyFileSearchSessionStopParams;
	  }
	| {
			readonly method: "fuzzyFileSearch/sessionUpdate";
			readonly id: RequestId;
			readonly params: FuzzyFileSearchSessionUpdateParams;
	  }
	| { readonly method: "mcpServerStatus/list"; readonly id: RequestId; readonly params: McpServerStatusListParams }
	| { readonly method: "model/list"; readonly id: RequestId; readonly params: ModelListParams }
	| {
			readonly method: "permissionProfile/list";
			readonly id: RequestId;
			readonly params: PermissionProfileListParams;
	  }
	| {
			readonly method: "remoteControl/client/list";
			readonly id: RequestId;
			readonly params: RemoteControlClientListParams;
	  }
	| {
			readonly method: "remoteControl/status/read";
			readonly id: RequestId;
			readonly params?: RemoteControlStatusReadParams;
	  }
	| { readonly method: "skills/list"; readonly id: RequestId; readonly params: SkillsListParams }
	| { readonly method: "thread/compact/start"; readonly id: RequestId; readonly params: ThreadCompactStartParams }
	| { readonly method: "thread/goal/clear"; readonly id: RequestId; readonly params: ThreadGoalClearParams }
	| { readonly method: "thread/goal/get"; readonly id: RequestId; readonly params: ThreadGoalGetParams }
	| { readonly method: "thread/goal/set"; readonly id: RequestId; readonly params: ThreadGoalSetParams }
	| { readonly method: "thread/items/list"; readonly id: RequestId; readonly params: ThreadItemsListParams }
	| {
			readonly method: "thread/metadata/update";
			readonly id: RequestId;
			readonly params: ThreadMetadataUpdateParams;
	  }
	| { readonly method: "thread/search"; readonly id: RequestId; readonly params: ThreadSearchParams }
	| {
			readonly method: "thread/searchOccurrences";
			readonly id: RequestId;
			readonly params: ThreadSearchOccurrencesParams;
	  }
	| {
			readonly method: "thread/settings/update";
			readonly id: RequestId;
			readonly params: ThreadSettingsUpdateParams;
	  }
	| { readonly method: "thread/turns/list"; readonly id: RequestId; readonly params: ThreadTurnsListParams }
	| { readonly method: "thread/unarchive"; readonly id: RequestId; readonly params: ThreadUnarchiveParams }
	| { readonly method: "thread/start"; readonly id: RequestId; readonly params: ThreadStartParams }
	| { readonly method: "thread/resume"; readonly id: RequestId; readonly params: ThreadResumeParams }
	| { readonly method: "thread/read"; readonly id: RequestId; readonly params: ThreadReadParams }
	| { readonly method: "thread/list"; readonly id: RequestId; readonly params: ThreadListParams }
	| { readonly method: "thread/loaded/list"; readonly id: RequestId; readonly params: ThreadLoadedListParams }
	| { readonly method: "thread/fork"; readonly id: RequestId; readonly params: ThreadForkParams }
	| { readonly method: "thread/name/set"; readonly id: RequestId; readonly params: ThreadSetNameParams }
	| { readonly method: "thread/archive"; readonly id: RequestId; readonly params: ThreadArchiveParams }
	| { readonly method: "thread/delete"; readonly id: RequestId; readonly params: ThreadDeleteParams }
	| { readonly method: "thread/unsubscribe"; readonly id: RequestId; readonly params: ThreadUnsubscribeParams }
	| { readonly method: "turn/start"; readonly id: RequestId; readonly params: TurnStartParams }
	| { readonly method: "turn/steer"; readonly id: RequestId; readonly params: TurnSteerParams }
	| { readonly method: "turn/interrupt"; readonly id: RequestId; readonly params: TurnInterruptParams };

export type ServerRequest = {
	readonly method: ServerRequestMethod;
	readonly id: RequestId;
	readonly params?: JsonValue;
};
