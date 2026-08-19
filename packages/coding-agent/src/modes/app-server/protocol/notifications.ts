import type { ProviderAccountFailoverNotification, ProviderAccountsUpdatedNotification } from "./account.ts";
import type { JsonValue } from "./base.ts";
import type {
	FuzzyFileSearchSessionCompletedNotification,
	FuzzyFileSearchSessionUpdatedNotification,
} from "./fuzzy-search.ts";
import type { SERVER_NOTIFICATION_METHODS } from "./methods.ts";
import type { ErrorNotification } from "./terminal.ts";
import type { ThreadGoal, ThreadSettings } from "./thread-parity.ts";

export type ServerNotificationMethod = (typeof SERVER_NOTIFICATION_METHODS)[number];

export type ThreadUnarchivedNotification = { readonly threadId: string };
export type ThreadGoalUpdatedNotification = {
	readonly threadId: string;
	readonly turnId: string | null;
	readonly goal: ThreadGoal;
};
export type ThreadGoalClearedNotification = { readonly threadId: string };
export type ThreadSettingsUpdatedNotification = {
	readonly threadId: string;
	readonly threadSettings: ThreadSettings;
};
export type TurnDiffUpdatedNotification = {
	readonly threadId: string;
	readonly turnId: string;
	readonly diff: string;
};

// Shape mirrors generated/v2/TurnPlanUpdatedNotification; defined here so runtime
// code imports the facade instead of the generated evidence tree.
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";
export type TurnPlanStep = { readonly step: string; readonly status: TurnPlanStepStatus };
export type TurnPlanUpdatedNotification = {
	readonly threadId: string;
	readonly turnId: string;
	readonly explanation: string | null;
	readonly plan: readonly TurnPlanStep[];
};

export type AppServerPlanNotification =
	| { readonly method: "account/providerAccounts/updated"; readonly params: ProviderAccountsUpdatedNotification }
	| { readonly method: "account/providerAccounts/failover"; readonly params: ProviderAccountFailoverNotification }
	| { readonly method: "thread/unarchived"; readonly params: ThreadUnarchivedNotification }
	| { readonly method: "thread/goal/updated"; readonly params: ThreadGoalUpdatedNotification }
	| { readonly method: "thread/goal/cleared"; readonly params: ThreadGoalClearedNotification }
	| { readonly method: "thread/settings/updated"; readonly params: ThreadSettingsUpdatedNotification }
	| { readonly method: "turn/diff/updated"; readonly params: TurnDiffUpdatedNotification }
	| { readonly method: "turn/plan/updated"; readonly params: TurnPlanUpdatedNotification }
	| {
			readonly method: "fuzzyFileSearch/sessionUpdated";
			readonly params: FuzzyFileSearchSessionUpdatedNotification;
	  }
	| {
			readonly method: "fuzzyFileSearch/sessionCompleted";
			readonly params: FuzzyFileSearchSessionCompletedNotification;
	  };

export type TypedServerNotification =
	| AppServerPlanNotification
	| { readonly method: "error"; readonly params: ErrorNotification };

type UntypedServerNotificationMethod = Exclude<ServerNotificationMethod, TypedServerNotification["method"]>;

export type ServerNotification =
	| TypedServerNotification
	| { readonly method: UntypedServerNotificationMethod; readonly params?: JsonValue };

/** Compatibility envelope accepted from older app-server versions. */
export type ServerNotificationEnvelope = ServerNotification & { readonly emittedAtMs?: number };

/** Envelope emitted by current app-server versions. */
export type PopulatedServerNotificationEnvelope = ServerNotification & { readonly emittedAtMs: number };
