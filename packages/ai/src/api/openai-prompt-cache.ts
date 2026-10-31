import type { TranscriptContext } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { getInitialSystemMessage } from "../utils/transcript.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const PREFIX_VERSION = "senpi-responses-prefix-v1";

/** Cache affinity belongs to the reusable leading prefix, never to a conversation UUID. */
export function deriveOpenAIPromptCacheKey(modelId: string, context: TranscriptContext): string | undefined {
	const initial = getInitialSystemMessage(context.messages);
	const tools = [...(initial?.toolsAdded ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	const prefix = JSON.stringify([
		PREFIX_VERSION,
		modelId,
		initial === undefined ? "" : getSystemMessageText(initial),
		tools.map(({ name, description, parameters, freeform, constrainedSampling }) => ({
			name,
			description,
			parameters,
			freeform,
			constrainedSampling,
		})),
	]);
	return clampOpenAIPromptCacheKey(`${PREFIX_VERSION}-${shortHash(prefix)}`);
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export function applyChatGptSubscriptionCacheAffinityHeaders(headers: Headers, sessionId: string | undefined): void {
	if (!sessionId) return;
	headers.set("session-id", sessionId);
	headers.set("thread-id", sessionId);
	headers.set("x-client-request-id", sessionId);
}
