import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../src/core/footer-data-provider.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

type FooterUsageEntry =
	| { type: "message"; message: { role: "assistant" | "toolResult"; usage: AssistantUsage } }
	| { type: "branch_summary"; usage: AssistantUsage }
	| { type: "compaction"; usage: AssistantUsage };

export type FooterSessionOptions = {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	fastModeActive?: boolean;
	usage?: AssistantUsage;
	branchUsage?: AssistantUsage;
	compactionUsage?: AssistantUsage;
	toolUsage?: AssistantUsage;
	cwd?: string;
};

export function createFooterSession(options: FooterSessionOptions): AgentSession {
	const entries: FooterUsageEntry[] = [];
	if (options.usage !== undefined) {
		entries.push({ type: "message", message: { role: "assistant", usage: options.usage } });
	}
	if (options.branchUsage !== undefined) {
		entries.push({ type: "branch_summary", usage: options.branchUsage });
	}
	if (options.compactionUsage !== undefined) {
		entries.push({ type: "compaction", usage: options.compactionUsage });
	}
	if (options.toolUsage !== undefined) {
		entries.push({ type: "message", message: { role: "toolResult", usage: options.toolUsage } });
	}

	return {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow: 200_000,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getUsageTotals: () => {
				const totals = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					latestCacheHitRate: undefined as number | undefined,
				};
				for (const entry of entries) {
					const usage = entry.type === "message" ? entry.message.usage : entry.usage;
					totals.input += usage.input;
					totals.output += usage.output;
					totals.cacheRead += usage.cacheRead;
					totals.cacheWrite += usage.cacheWrite;
					totals.cost += usage.cost.total;
					if (entry.type === "message" && entry.message.role === "assistant") {
						const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
						totals.latestCacheHitRate =
							latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
					}
				}
				return totals;
			},
			getSessionName: () => options.sessionName,
			getCwd: () => options.cwd ?? "/tmp/project",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		isFastModeActive: () => options.fastModeActive ?? false,
		modelRuntime: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

export function createFooterData(providerCount: number, omoNative = false): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => providerCount,
		onBranchChange: () => () => {},
		isOmoNative: () => omoNative,
	};
}
