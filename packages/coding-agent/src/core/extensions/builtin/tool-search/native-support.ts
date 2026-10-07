import type { AnthropicMessagesCompat, Api, Model } from "@earendil-works/pi-ai";

export type AnthropicToolSearchModel = Pick<Model<Api>, "api" | "id" | "provider"> &
	Partial<Pick<Model<Api>, "compat">>;
export type AnthropicToolSearchTarget = Api | AnthropicToolSearchModel | undefined;

const CLAUDE_VERSIONED_MODEL_ID = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/;
/** A trailing 8-digit group is a release date (claude-opus-4-5-20251101), not a minor version. */
const MODEL_ID_DATE_SUFFIX_LENGTH = 8;

function isSupportedModel(model: AnthropicToolSearchModel): boolean {
	const compat = model.compat as AnthropicMessagesCompat | undefined;
	return compat?.supportsToolReferences ?? defaultSupportsToolSearch(model);
}

/**
 * Byte-for-byte mirror of pi-ai's private
 * `AnthropicMessagesCompat.supportsToolReferences` default; keep in lockstep
 * with `packages/ai/src/utils/prompt-cache-ttl.ts`. Diverging would inject the
 * server tool for a model whose deferred tools pi-ai refuses to defer, so the
 * request would carry a search tool with nothing to find. Anthropic's table
 * lists tool search on Opus/Sonnet 4.5+ and the Fable/Mythos line; Opus 4.1 and
 * earlier reject the server tool and Haiku rejects `tool_reference` blocks.
 */
function defaultSupportsToolSearch(model: AnthropicToolSearchModel): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(CLAUDE_VERSIONED_MODEL_ID);
	if (!version) return false;
	const major = Number(version[1]);
	const rawMinor = version[2];
	const minor = rawMinor !== undefined && rawMinor.length < MODEL_ID_DATE_SUFFIX_LENGTH ? Number(rawMinor) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

/**
 * Anthropic-compatible endpoints (gateways, kimi-coding, proxies) answer the
 * same `anthropic-messages` api but reject the server tool, so the api alone is
 * not a sufficient gate: injecting there 400s the request and disables native
 * search for the rest of the session. A bare api string carries no model
 * identity to gate on and stays supported, so the pure payload transform keeps
 * its api-only contract.
 */
export function supportsAnthropicNativeToolSearch(target: AnthropicToolSearchTarget): boolean {
	if (target === undefined) return false;
	if (typeof target === "string") return target === "anthropic-messages";
	if (target.api !== "anthropic-messages") return false;
	return isSupportedModel(target);
}
