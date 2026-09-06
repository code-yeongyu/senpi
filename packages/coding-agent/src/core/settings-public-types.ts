/**
 * Public settings type surface.
 *
 * `settings-manager.ts` re-exports everything here so existing importers keep their path;
 * the declarations live apart because that module is already far past the size ceiling.
 */
export type { CompactionSettings } from "./compaction-settings-access.ts";
export type {
	ProviderRetrySettings,
	RetrySettings,
} from "./retry-fallback/settings.ts";
export type {
	ImageSettings,
	LookAtSettings,
	MarkdownSettings,
	MermaidRenderingMode,
	OpenAISettings,
	PromptCacheKeepAliveSettings,
	PromptCacheSettings,
	ThinkingBudgetsSettings,
} from "./settings-shapes.ts";
export type { BranchSummarySettings, TerminalSettings } from "./terminal-settings.ts";
