import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import { claudeCodeMaxContextTokens, plannedContextWindow } from "./context-window.ts";

/**
 * Variables the lane layers over the Claude Code subprocess environment the auth lane builds; they win over the
 * host's, including the managed lanes' stripped `ANTHROPIC_BASE_URL`.
 *
 * - Compaction (senpi owner): Claude Code's per-turn token-budget reminder changes the prompt every turn and defeats
 *   prompt-cache reuse; senpi's compaction carries its own budget reminder. With DISABLE_COMPACT set, Claude Code takes
 *   CLAUDE_CODE_MAX_CONTEXT_TOKENS over every model rule of its own (senpi#3801) and its native compaction stays off.
 *   The variable carries the planned window plus the output reserve Claude Code holds back from it, so Claude Code
 *   refuses a request only past the window senpi plans, not 23k below the window senpi compacts against.
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
		environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(claudeCodeMaxContextTokens(plannedContextWindow(model)));
		environment.DISABLE_COMPACT = "1";
	}
	if (model.baseUrl !== CLAUDE_SDK_OAUTH_API_ID) environment.ANTHROPIC_BASE_URL = model.baseUrl;
	return Object.keys(environment).length > 0 ? environment : undefined;
}
