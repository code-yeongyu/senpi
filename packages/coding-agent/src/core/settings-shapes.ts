export interface PromptCacheKeepAliveSettings {
	enabled?: boolean; // default: false
	maxRequestsPerSession?: number; // default: 3
	maxCostUsdPerSession?: number; // default: 0.05
	marginSeconds?: number; // default: 60
}

export interface PromptCacheSettings {
	cacheAwareTimeouts?: boolean; // default: true (size foreground tool waits by the model's prompt-cache TTL)
	safetyBufferSeconds?: number; // default: 30 (headroom subtracted from the cache TTL)
	goalBackstopMaxSeconds?: number; // default: 3570 (maximum Goal monitor continuation backstop)
	keepAlive?: PromptCacheKeepAliveSettings;
}

export interface ImageSettings {
	autoResize?: boolean; // default: true (resize images to 2000x2000 max for better model compatibility)
	blockImages?: boolean; // default: false - when true, prevents all images from being sent to LLM providers
	maxHistoricalImages?: number; // default: undefined (preserve existing transport behavior)
}

export interface LookAtSettings {
	enabled?: boolean; // default: true
	models?: string[]; // default: undefined (use the default look-at chain)
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
	serviceTier?: "auto" | "flex" | "priority";
}
