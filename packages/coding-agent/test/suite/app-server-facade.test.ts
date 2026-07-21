import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildSenpiCollaborationMode,
	buildSenpiCollaborationModePreset,
	SENPI_COLLABORATION_MODE,
} from "../../src/modes/app-server/protocol/collaboration-mode.ts";
import type { CollaborationMode as GeneratedCollaborationMode } from "../../src/modes/app-server/protocol/generated/CollaborationMode.ts";
import type { FuzzyFileSearchResult as GeneratedFuzzyFileSearchResult } from "../../src/modes/app-server/protocol/generated/FuzzyFileSearchResult.ts";
import type { ThreadGoalUpdatedNotification as GeneratedThreadGoalUpdatedNotification } from "../../src/modes/app-server/protocol/generated/v2/ThreadGoalUpdatedNotification.ts";
import type {
	AccountRateLimitsReadParams,
	AccountRateLimitsReadResponse,
	AccountReadParams,
	AccountReadResponse,
	AccountUsageReadParams,
	AccountUsageReadResponse,
	ClientRequest,
	CollaborationMode,
	CollaborationModeListParams,
	CollaborationModeListResponse,
	ConfigReadParams,
	ConfigReadResponse,
	ConfigRequirementsReadParams,
	ConfigRequirementsReadResponse,
	ErrorNotification,
	ExperimentalFeatureListParams,
	ExperimentalFeatureListResponse,
	FuzzyFileSearchParams,
	FuzzyFileSearchResponse,
	FuzzyFileSearchResult,
	FuzzyFileSearchSessionCompletedNotification,
	FuzzyFileSearchSessionStartParams,
	FuzzyFileSearchSessionStartResponse,
	FuzzyFileSearchSessionStopParams,
	FuzzyFileSearchSessionStopResponse,
	FuzzyFileSearchSessionUpdatedNotification,
	FuzzyFileSearchSessionUpdateParams,
	FuzzyFileSearchSessionUpdateResponse,
	McpServerStatusListParams,
	McpServerStatusListResponse,
	ModelListParams,
	ModelListResponse,
	PermissionProfileListParams,
	PermissionProfileListResponse,
	RemoteControlClientListParams,
	RemoteControlClientListResponse,
	RemoteControlStatusReadParams,
	RemoteControlStatusReadResponse,
	SkillsListParams,
	SkillsListResponse,
	Thread,
	ThreadCompactStartParams,
	ThreadCompactStartResponse,
	ThreadGoalClearedNotification,
	ThreadGoalClearParams,
	ThreadGoalClearResponse,
	ThreadGoalGetParams,
	ThreadGoalGetResponse,
	ThreadGoalSetParams,
	ThreadGoalSetResponse,
	ThreadGoalUpdatedNotification,
	ThreadItemsListParams,
	ThreadItemsListResponse,
	ThreadMetadataUpdateParams,
	ThreadMetadataUpdateResponse,
	ThreadSearchOccurrencesParams,
	ThreadSearchOccurrencesResponse,
	ThreadSearchParams,
	ThreadSearchResponse,
	ThreadSettings,
	ThreadSettingsUpdatedNotification,
	ThreadSettingsUpdateParams,
	ThreadSettingsUpdateResponse,
	ThreadTurnsListParams,
	ThreadTurnsListResponse,
	ThreadUnarchivedNotification,
	ThreadUnarchiveParams,
	ThreadUnarchiveResponse,
	TurnDiffUpdatedNotification,
} from "../../src/modes/app-server/protocol/index.ts";

const appServerSourceRoot = join(import.meta.dirname, "../../src/modes/app-server");

const thread: Thread = {
	id: "thread-1",
	sessionId: "session-1",
	forkedFromId: null,
	parentThreadId: null,
	preview: "",
	ephemeral: false,
	modelProvider: "faux",
	createdAt: 1,
	updatedAt: 1,
	recencyAt: null,
	status: { type: "idle" },
	path: null,
	cwd: "/tmp",
	cliVersion: "0.0.0",
	source: "appServer",
	threadSource: null,
	agentNickname: null,
	agentRole: null,
	gitInfo: null,
	name: null,
	turns: [],
};

const settings: ThreadSettings = {
	cwd: "/tmp",
	approvalPolicy: "never",
	approvalsReviewer: "user",
	sandboxPolicy: { type: "dangerFullAccess" },
	activePermissionProfile: null,
	model: "faux-1",
	modelProvider: "faux",
	serviceTier: null,
	effort: "off",
	summary: null,
	collaborationMode: buildSenpiCollaborationMode("faux-1", "off"),
	personality: null,
};

const requestParams = {
	threadSearch: { searchTerm: "needle" } satisfies ThreadSearchParams,
	threadSearchOccurrences: { threadId: "thread-1", searchTerm: "needle" } satisfies ThreadSearchOccurrencesParams,
	threadTurnsList: { threadId: "thread-1" } satisfies ThreadTurnsListParams,
	threadItemsList: { threadId: "thread-1" } satisfies ThreadItemsListParams,
	threadCompactStart: { threadId: "thread-1" } satisfies ThreadCompactStartParams,
	threadUnarchive: { threadId: "thread-1" } satisfies ThreadUnarchiveParams,
	threadGoalSet: { threadId: "thread-1", objective: "ship" } satisfies ThreadGoalSetParams,
	threadGoalGet: { threadId: "thread-1" } satisfies ThreadGoalGetParams,
	threadGoalClear: { threadId: "thread-1" } satisfies ThreadGoalClearParams,
	threadSettingsUpdate: { threadId: "thread-1", model: "faux-1" } satisfies ThreadSettingsUpdateParams,
	threadMetadataUpdate: { threadId: "thread-1", gitInfo: { branch: "main" } } satisfies ThreadMetadataUpdateParams,
	remoteControlStatusRead: undefined satisfies RemoteControlStatusReadParams,
	remoteControlClientList: { environmentId: "environment-1" } satisfies RemoteControlClientListParams,
	modelList: {} satisfies ModelListParams,
	skillsList: {} satisfies SkillsListParams,
	mcpServerStatusList: {} satisfies McpServerStatusListParams,
	configRead: {} satisfies ConfigReadParams,
	configRequirementsRead: undefined satisfies ConfigRequirementsReadParams,
	accountRead: {} satisfies AccountReadParams,
	accountRateLimitsRead: undefined satisfies AccountRateLimitsReadParams,
	accountUsageRead: undefined satisfies AccountUsageReadParams,
	collaborationModeList: {} satisfies CollaborationModeListParams,
	permissionProfileList: {} satisfies PermissionProfileListParams,
	experimentalFeatureList: {} satisfies ExperimentalFeatureListParams,
	fuzzyFileSearch: { query: "readme", roots: ["/tmp"], cancellationToken: null } satisfies FuzzyFileSearchParams,
	fuzzyFileSearchSessionStart: {
		sessionId: "search-1",
		roots: ["/tmp"],
	} satisfies FuzzyFileSearchSessionStartParams,
	fuzzyFileSearchSessionUpdate: {
		sessionId: "search-1",
		query: "readme",
	} satisfies FuzzyFileSearchSessionUpdateParams,
	fuzzyFileSearchSessionStop: { sessionId: "search-1" } satisfies FuzzyFileSearchSessionStopParams,
};

const fuzzyFileSearchResult = {
	root: "/tmp",
	path: "/tmp/README.md",
	match_type: "file" as const,
	file_name: "README.md",
	score: 1,
	indices: [0],
};
const facadeFuzzyFileSearchResult: FuzzyFileSearchResult = fuzzyFileSearchResult;
const generatedFuzzyFileSearchResult: GeneratedFuzzyFileSearchResult = fuzzyFileSearchResult;

const requests: readonly ClientRequest[] = [
	{ id: 1, method: "thread/search", params: requestParams.threadSearch },
	{ id: 2, method: "thread/searchOccurrences", params: requestParams.threadSearchOccurrences },
	{ id: 3, method: "thread/turns/list", params: requestParams.threadTurnsList },
	{ id: 4, method: "thread/items/list", params: requestParams.threadItemsList },
	{ id: 5, method: "thread/compact/start", params: requestParams.threadCompactStart },
	{ id: 6, method: "thread/unarchive", params: requestParams.threadUnarchive },
	{ id: 7, method: "thread/goal/set", params: requestParams.threadGoalSet },
	{ id: 8, method: "thread/goal/get", params: requestParams.threadGoalGet },
	{ id: 9, method: "thread/goal/clear", params: requestParams.threadGoalClear },
	{ id: 10, method: "thread/settings/update", params: requestParams.threadSettingsUpdate },
	{ id: 11, method: "thread/metadata/update", params: requestParams.threadMetadataUpdate },
	{ id: 12, method: "remoteControl/status/read" },
	{ id: 13, method: "remoteControl/client/list", params: requestParams.remoteControlClientList },
	{ id: 14, method: "model/list", params: requestParams.modelList },
	{ id: 15, method: "skills/list", params: requestParams.skillsList },
	{ id: 16, method: "mcpServerStatus/list", params: requestParams.mcpServerStatusList },
	{ id: 17, method: "config/read", params: requestParams.configRead },
	{ id: 18, method: "configRequirements/read" },
	{ id: 19, method: "account/read", params: requestParams.accountRead },
	{ id: 20, method: "account/rateLimits/read" },
	{ id: 21, method: "account/usage/read" },
	{ id: 22, method: "collaborationMode/list", params: requestParams.collaborationModeList },
	{ id: 23, method: "permissionProfile/list", params: requestParams.permissionProfileList },
	{ id: 24, method: "experimentalFeature/list", params: requestParams.experimentalFeatureList },
	{ id: 25, method: "fuzzyFileSearch", params: requestParams.fuzzyFileSearch },
	{ id: 26, method: "fuzzyFileSearch/sessionStart", params: requestParams.fuzzyFileSearchSessionStart },
	{ id: 27, method: "fuzzyFileSearch/sessionUpdate", params: requestParams.fuzzyFileSearchSessionUpdate },
	{ id: 28, method: "fuzzyFileSearch/sessionStop", params: requestParams.fuzzyFileSearchSessionStop },
];

const responses = {
	threadSearch: {
		data: [{ thread, snippet: "needle" }],
		nextCursor: null,
		backwardsCursor: null,
	} satisfies ThreadSearchResponse,
	threadSearchOccurrences: {
		data: [
			{
				turnId: "turn-1",
				itemId: "item-1",
				snippet: "needle",
				snippetMatchRange: { start: 0, end: 6 },
				turnCursor: "turn-1",
			},
		],
		nextCursor: null,
	} satisfies ThreadSearchOccurrencesResponse,
	threadTurnsList: { data: [], nextCursor: null, backwardsCursor: null } satisfies ThreadTurnsListResponse,
	threadItemsList: { data: [], nextCursor: null, backwardsCursor: null } satisfies ThreadItemsListResponse,
	threadCompactStart: {} satisfies ThreadCompactStartResponse,
	threadUnarchive: { thread } satisfies ThreadUnarchiveResponse,
	threadGoalSet: {
		goal: {
			threadId: "thread-1",
			objective: "ship",
			status: "active",
			tokenBudget: null,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		},
	} satisfies ThreadGoalSetResponse,
	threadGoalGet: { goal: null } satisfies ThreadGoalGetResponse,
	threadGoalClear: { cleared: true } satisfies ThreadGoalClearResponse,
	threadSettingsUpdate: {} satisfies ThreadSettingsUpdateResponse,
	threadMetadataUpdate: { thread } satisfies ThreadMetadataUpdateResponse,
	remoteControlStatusRead: {
		status: "disabled",
		serverName: "senpi",
		installationId: "installation-1",
		environmentId: null,
	} satisfies RemoteControlStatusReadResponse,
	remoteControlClientList: { data: [], nextCursor: null } satisfies RemoteControlClientListResponse,
	modelList: { data: [], nextCursor: null } satisfies ModelListResponse,
	skillsList: { data: [] } satisfies SkillsListResponse,
	mcpServerStatusList: { data: [], nextCursor: null } satisfies McpServerStatusListResponse,
	configRead: {
		config: {
			model: null,
			model_provider: null,
			approval_policy: null,
			sandbox_mode: null,
			model_reasoning_effort: null,
		},
		origins: {},
		layers: null,
	} satisfies ConfigReadResponse,
	configRequirementsRead: { requirements: null } satisfies ConfigRequirementsReadResponse,
	accountRead: { account: null, requiresOpenaiAuth: false } satisfies AccountReadResponse,
	accountRateLimitsRead: {
		rateLimits: {
			limitId: null,
			limitName: null,
			primary: null,
			secondary: null,
			credits: null,
			individualLimit: null,
			spendControlReached: null,
			planType: null,
			rateLimitReachedType: null,
		},
		rateLimitsByLimitId: null,
		rateLimitResetCredits: null,
	} satisfies AccountRateLimitsReadResponse,
	accountUsageRead: {
		summary: {
			lifetimeTokens: null,
			peakDailyTokens: null,
			longestRunningTurnSec: null,
			currentStreakDays: null,
			longestStreakDays: null,
		},
		dailyUsageBuckets: null,
	} satisfies AccountUsageReadResponse,
	collaborationModeList: {
		data: [buildSenpiCollaborationModePreset("faux-1")],
	} satisfies CollaborationModeListResponse,
	permissionProfileList: { data: [], nextCursor: null } satisfies PermissionProfileListResponse,
	experimentalFeatureList: { data: [], nextCursor: null } satisfies ExperimentalFeatureListResponse,
	fuzzyFileSearch: {
		files: [facadeFuzzyFileSearchResult],
	} satisfies FuzzyFileSearchResponse,
	fuzzyFileSearchSessionStart: {} satisfies FuzzyFileSearchSessionStartResponse,
	fuzzyFileSearchSessionUpdate: {} satisfies FuzzyFileSearchSessionUpdateResponse,
	fuzzyFileSearchSessionStop: {} satisfies FuzzyFileSearchSessionStopResponse,
};

const notifications = {
	threadUnarchived: { threadId: "thread-1" } satisfies ThreadUnarchivedNotification,
	threadGoalUpdated: {
		threadId: "thread-1",
		turnId: null,
		goal: responses.threadGoalSet.goal,
	} satisfies ThreadGoalUpdatedNotification,
	threadGoalCleared: { threadId: "thread-1" } satisfies ThreadGoalClearedNotification,
	threadSettingsUpdated: {
		threadId: "thread-1",
		threadSettings: settings,
	} satisfies ThreadSettingsUpdatedNotification,
	turnDiffUpdated: {
		threadId: "thread-1",
		turnId: "turn-1",
		diff: "diff --git",
	} satisfies TurnDiffUpdatedNotification,
	fuzzyFileSearchSessionUpdated: {
		sessionId: "search-1",
		query: "readme",
		files: responses.fuzzyFileSearch.files,
	} satisfies FuzzyFileSearchSessionUpdatedNotification,
	fuzzyFileSearchSessionCompleted: { sessionId: "search-1" } satisfies FuzzyFileSearchSessionCompletedNotification,
	error: {
		threadId: "thread-1",
		turnId: "turn-1",
		error: { message: "failed", codexErrorInfo: "sessionBudgetExceeded", additionalDetails: null },
		willRetry: false,
	} satisfies ErrorNotification,
};

const generatedCollaborationMode: GeneratedCollaborationMode = SENPI_COLLABORATION_MODE;
const facadeCollaborationMode: CollaborationMode = generatedCollaborationMode;
const facadeThreadGoalUpdatedNotification: ThreadGoalUpdatedNotification = notifications.threadGoalUpdated;
const generatedThreadGoalUpdatedNotification: GeneratedThreadGoalUpdatedNotification =
	facadeThreadGoalUpdatedNotification;
const compatibleThreadGoalUpdatedNotification: ThreadGoalUpdatedNotification = generatedThreadGoalUpdatedNotification;

describe("app-server handwritten facade", () => {
	it("covers every request family implemented by the parity plan", () => {
		expect(requests).toHaveLength(28);
		expect(new Set(requests.map((request) => request.method)).size).toBe(28);
		expect(Object.keys(responses)).toHaveLength(28);
		expect(Object.keys(notifications)).toHaveLength(8);
		expect(compatibleThreadGoalUpdatedNotification).toEqual(notifications.threadGoalUpdated);
		expect(generatedFuzzyFileSearchResult).toEqual(responses.fuzzyFileSearch.files[0]);
		expect(responses.fuzzyFileSearch.files[0]).toMatchObject({ match_type: "file", file_name: "README.md" });
	});

	it("routes runtime protocol imports through the handwritten facade", () => {
		const offenders = readdirSync(appServerSourceRoot, { recursive: true, encoding: "utf8" })
			.filter((relativePath) => relativePath.endsWith(".ts") && !relativePath.startsWith("protocol/generated/"))
			.filter((relativePath) => {
				const source = readFileSync(join(appServerSourceRoot, relativePath), "utf8");
				return /from\s+["'][^"']*(?:protocol\/generated|\.\/generated)/u.test(source);
			});

		expect(offenders).toEqual([]);
	});

	it("uses one schema-valid authoritative collaboration-mode projection", () => {
		expect(facadeCollaborationMode).toEqual({
			mode: "default",
			settings: {
				model: "unknown",
				reasoning_effort: "off",
				developer_instructions: null,
			},
		});
		expect(buildSenpiCollaborationMode("faux-1", "medium")).toEqual({
			mode: "default",
			settings: {
				model: "faux-1",
				reasoning_effort: "medium",
				developer_instructions: null,
			},
		});
		expect(buildSenpiCollaborationModePreset("faux-1")).toEqual({
			name: "default",
			mode: null,
			model: "faux-1",
			reasoning_effort: null,
		});
		expect(JSON.stringify(buildSenpiCollaborationModePreset("faux-1"))).toContain('"reasoning_effort":null');
		expect(JSON.stringify(buildSenpiCollaborationModePreset("faux-1"))).not.toContain("reasoningEffort");
	});
});
