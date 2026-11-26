import type { Api, Model } from "@earendil-works/pi-ai";
import { CLAUDE_SDK_OAUTH_API_ID } from "./api-id.ts";
import { claudeCodeMaxContextTokens, plannedContextWindow } from "./context-window.ts";

const MCP_DESCRIPTION_LENGTH_VARIABLE = "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH";
/** Claude Code's own ceiling for a tool loaded through its tool search; its default prompt cap is 4096. */
const MCP_DESCRIPTION_LENGTH = "16384";

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
 * - MCP description length: senpi's tools reach Claude Code as MCP tools, and Claude Code cuts each MCP tool
 *   description at 4096 chars with "… [truncated]" (oh-my-openagent#14291), so the model saw a shorter tool contract
 *   than on every other provider. A value the user set in the host environment is left to win.
 */
export function claudeCodeQueryEnvironment(
	model: Model<Api>,
	senpiOwnsCompaction: boolean,
	hostEnvironment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};
	if (hostEnvironment[MCP_DESCRIPTION_LENGTH_VARIABLE] === undefined) {
		environment[MCP_DESCRIPTION_LENGTH_VARIABLE] = MCP_DESCRIPTION_LENGTH;
	}
	if (senpiOwnsCompaction) {
		environment.CLAUDE_CODE_TOTAL_TOKENS_REMINDER = "off";
		environment.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(claudeCodeMaxContextTokens(plannedContextWindow(model)));
		environment.DISABLE_COMPACT = "1";
	}
	if (model.baseUrl !== CLAUDE_SDK_OAUTH_API_ID) environment.ANTHROPIC_BASE_URL = model.baseUrl;
	return environment;
}
