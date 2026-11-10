import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import { plannedContextWindow } from "./context-window.ts";
import type { Options } from "./sdk-boundary.ts";
import type { AnthropicSubscriptionProviderSettings } from "./settings.ts";

type ClaudeCodeInlineSettings = Exclude<Options["settings"], string | undefined>;

/**
 * The inline settings (`--settings`) the lane sends to the Claude Code subprocess; `configFingerprint` hashes them, so
 * a change restarts the resident process.
 *
 * - Compaction owner: native auto-compact is on only when the SDK owns compaction.
 * - claude.ai connectors: the child runs with `--setting-sources=`, so a user's own Claude Code settings cannot turn
 *   the account connectors off, and each attach adds their tool schemas to the context (oh-my-openagent#12166).
 *   `claudeAiConnectors: false` sends Claude Code's `disableClaudeAiConnectors`; unset leaves the object unchanged.
 */
export function claudeCodeInlineSettings(
	providerSettings: Pick<AnthropicSubscriptionProviderSettings, "claudeAiConnectors">,
	senpiOwnsCompaction: boolean,
): ClaudeCodeInlineSettings {
	return {
		autoCompactEnabled: !senpiOwnsCompaction,
		...(providerSettings.claudeAiConnectors === false ? { disableClaudeAiConnectors: true } : {}),
	};
}

/**
 * Variables the lane layers over the Claude Code subprocess environment the auth lane builds; they win over the
 * host's, including the managed lanes' stripped `ANTHROPIC_BASE_URL`.
 *
 * - Compaction (senpi owner): Claude Code's per-turn token-budget reminder changes the prompt every turn and defeats
 *   prompt-cache reuse; senpi's compaction carries its own budget reminder. With DISABLE_COMPACT set, Claude Code takes
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS over every model rule of its own, so it plans the window senpi plans (senpi#3801),
 *   and its native compaction stays off.
 * - Base URL: the registration baseUrl is the api-id sentinel. Any other value is the user's models.json baseUrl
 *   (senpi#4765); Claude Code sends its requests to `ANTHROPIC_BASE_URL` and keeps the selected login as the credential.
 */
export function claudeCodeQueryEnvironment(
	model: Model<Api>,
	senpiOwnsCompaction: boolean,
): Record<string, string> | undefined {
	const environment: Record<string, string> = {};
	if (senpiOwnsCompaction) {
		environment.CLAUDE_CODE_TOTAL_TOKENS_REMINDER = "off";
		environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(plannedContextWindow(model));
		environment.DISABLE_COMPACT = "1";
	}
	if (model.baseUrl !== CLAUDE_SDK_OAUTH_API_ID) environment.ANTHROPIC_BASE_URL = model.baseUrl;
	return Object.keys(environment).length > 0 ? environment : undefined;
}
