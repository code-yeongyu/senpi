export interface PromptCacheKeepAliveSettings {
	enabled?: boolean; // default: false
	maxRequestsPerSession?: number; // default: 3
	maxCostUsdPerSession?: number; // default: 0.05
	marginSeconds?: number; // default: 60
}

export interface PromptCacheSettings {
	cacheAwareTimeouts?: boolean; // default: true (size foreground tool waits by the model's prompt-cache TTL)
	safetyBufferSeconds?: number; // default: 30 (headroom subtracted from the cache TTL)
	goalBackstopMaxSeconds?: number; // default: 270 (Goal monitor re-check backstop while wake sources are live; 5m TTL - 30s buffer)
	keepAlive?: PromptCacheKeepAliveSettings;
}

export interface HandoffHintSettings {
	enabled?: boolean; // default: true (offer "start fresh with a handoff" when a large session's cache has expired)
	minContextTokens?: number; // default: 200000 (no hint below this context size)
	minSavingUsd?: number; // default: 1 (no hint unless a fresh session saves at least this much on the next reply)
}

export type TodoFirstTurnPlan = "force" | "remind" | "off";

export interface TodoSettings {
	firstTurnPlan?: TodoFirstTurnPlan; // default: "force" (first prompt of a session gets a hidden plan reminder; "force" also names the todo tool in tool_choice where the provider allows it)
	turnEndBackstop?: boolean; // default: true (a main-session turn that ends text-only with open todo tasks and no active goal gets a hidden nudge, at most two per chain)
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
	maxHistoricalImages?: number; // default: undefined (preserve existing transport behavior)
}

export const JOB_WIDGETS_DEFAULT_AUTHOR_AFTER_MS = 15_000;

export interface JobWidgetsSettings {
	enabled?: boolean; // default: true (live widgets for long background jobs)
	model?: string; // default: undefined (host-injected model, else the session's model); `provider/model-id`
	authorAfterMs?: number; // default: 15000 (job age before its widget is written)
}

export interface LookAtSettings {
	enabled?: boolean; // default: true
	models?: string[]; // default: undefined (use the default look-at chain)
}

export const ASK_USER_DEFAULT_TIMEOUT_MINUTES = 30;
export const ASK_USER_MIN_TIMEOUT_MINUTES = 1;
export const ASK_USER_MAX_TIMEOUT_MINUTES = 120;

export interface AskUserSettings {
	enabled?: boolean; // default: true
	bell?: boolean; // default: true; ring once for a newly displayed question
	timeoutMinutes?: number; // default: 30, clamped to 1-120 when read
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export type MermaidRenderingMode = "off" | "final" | "streaming";

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
	mermaid?: MermaidRenderingMode; // default: "streaming"
}

export interface OpenAISettings {
	serviceTier?: "auto" | "flex" | "priority" | "ultrafast";
}

export interface ProviderConcurrencySettings {
	maxConcurrency?: number; // default: unlimited; 0 disables the cap
}

export interface TurnDeadlineSettings {
	turn_inactivity_ms?: number; // default: 3_600_000, min 60_000, 0 disables; renewed only by tool execution events and admitted user input
	turn_max_runtime_ms?: number; // default: 21_600_000, 0 disables; hard cap from prompt accept
}
