export type PlanType =
	| "free"
	| "go"
	| "plus"
	| "pro"
	| "prolite"
	| "team"
	| "self_serve_business_usage_based"
	| "business"
	| "enterprise_cbp_usage_based"
	| "enterprise"
	| "edu"
	| "unknown";

export type Account =
	| { readonly type: "apiKey" }
	| { readonly type: "chatgpt"; readonly email: string | null; readonly planType: PlanType }
	| { readonly type: "amazonBedrock"; readonly usesCodexManagedCredentials: boolean };

export type AccountReadParams = { readonly refreshToken?: boolean };
export type AccountReadResponse = {
	readonly account: Account | null;
	readonly requiresOpenaiAuth: boolean;
};

/** Additive Senpi provider-account surface; desktop consumers update separately. */
export type ProviderAccountSource = "login" | "import" | "env";
export type ProviderAccount = {
	/** Immutable selector ID; render displayName (name) when metadata is present. */
	readonly name: string;
	readonly displayName?: string;
	readonly source: ProviderAccountSource;
	readonly blocked: boolean;
	readonly pinned: boolean;
};
export type ProviderAccountsReadParams = { readonly provider: string };
export type ProviderAccountsReadResponse = {
	readonly provider: string;
	readonly accounts: readonly ProviderAccount[];
};
export type ProviderAccountsPinParams = { readonly provider: string; readonly name: string | null };
export type ProviderAccountsRemoveParams = { readonly provider: string; readonly name: string };
export type ProviderAccountsUpdatedNotification = { readonly provider: string };
export type ProviderAccountFailoverNotification = {
	readonly provider: string;
	readonly from: string;
	readonly to: string;
	readonly reason: string;
};

export type RateLimitWindow = {
	readonly usedPercent: number;
	readonly windowDurationMins: number | null;
	readonly resetsAt: number | null;
};
export type CreditsSnapshot = {
	readonly hasCredits: boolean;
	readonly unlimited: boolean;
	readonly balance: string | null;
};
export type SpendControlLimitSnapshot = {
	readonly limit: string;
	readonly used: string;
	readonly remainingPercent: number;
	readonly resetsAt: number;
};
export type RateLimitReachedType =
	| "rate_limit_reached"
	| "workspace_owner_credits_depleted"
	| "workspace_member_credits_depleted"
	| "workspace_owner_usage_limit_reached"
	| "workspace_member_usage_limit_reached";
export type RateLimitSnapshot = {
	readonly limitId: string | null;
	readonly limitName: string | null;
	readonly primary: RateLimitWindow | null;
	readonly secondary: RateLimitWindow | null;
	readonly credits: CreditsSnapshot | null;
	readonly individualLimit: SpendControlLimitSnapshot | null;
	readonly spendControlReached: boolean | null;
	readonly planType: PlanType | null;
	readonly rateLimitReachedType: RateLimitReachedType | null;
};

export type RateLimitResetType = "codexRateLimits" | "unknown";
export type RateLimitResetCreditStatus = "available" | "redeeming" | "redeemed" | "unknown";
export type RateLimitResetCredit = {
	readonly id: string;
	readonly resetType: RateLimitResetType;
	readonly status: RateLimitResetCreditStatus;
	readonly grantedAt: number;
	readonly expiresAt: number | null;
	readonly title: string | null;
	readonly description: string | null;
};
export type RateLimitResetCreditsSummary = {
	readonly availableCount: number;
	readonly credits: readonly RateLimitResetCredit[] | null;
};

export type AccountRateLimitsReadParams = undefined;
export type AccountRateLimitsReadResponse = {
	readonly rateLimits: RateLimitSnapshot;
	readonly rateLimitsByLimitId: Readonly<Record<string, RateLimitSnapshot | undefined>> | null;
	readonly rateLimitResetCredits: RateLimitResetCreditsSummary | null;
};

export type AccountTokenUsageSummary = {
	readonly lifetimeTokens: number | null;
	readonly peakDailyTokens: number | null;
	readonly longestRunningTurnSec: number | null;
	readonly currentStreakDays: number | null;
	readonly longestStreakDays: number | null;
};
export type AccountTokenUsageDailyBucket = {
	readonly startDate: string;
	readonly tokens: number;
};
export type AccountUsageReadParams = undefined;
export type AccountUsageReadResponse = {
	readonly summary: AccountTokenUsageSummary;
	readonly dailyUsageBuckets: readonly AccountTokenUsageDailyBucket[] | null;
};
