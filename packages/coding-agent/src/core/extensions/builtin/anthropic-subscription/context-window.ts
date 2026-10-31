import type { Api, Model } from "@earendil-works/pi-ai";
import { longContextAvailable } from "./long-context.ts";

/** Claude Code's default window when a request does not ask for the long context. */
export const CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Models whose 1M window is reachable only through Claude Code's `[1m]` opt-in, which sends the legacy
 * `context-1m-2025-08-07` beta that a subscription without extra usage refuses. These are the rows of
 * the bundled Claude Code catalog with `supports_1m_beta` and without `native_1m` (pinned against the
 * installed binary by the senpi#3801 regression test). Every other model above 200k has a native 1M
 * window on every plan and is requested by its plain id.
 */
export const LEGACY_LONG_CONTEXT_MODEL_IDS: ReadonlySet<string> = new Set([
	"claude-3-7-sonnet",
	"claude-opus-4-6",
	"claude-sonnet-4-0",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
]);

type WindowedModel = Pick<Model<Api>, "id" | "contextWindow">;

function opensLegacyLongContext(model: WindowedModel): boolean {
	return model.contextWindow > CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW && LEGACY_LONG_CONTEXT_MODEL_IDS.has(model.id);
}

/** The window a request gets, which is what compaction plans against: only a legacy id loses 1M on a refusal. */
export function plannedContextWindow(model: WindowedModel, longContext = longContextAvailable()): number {
	return opensLegacyLongContext(model) && !longContext ? CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW : model.contextWindow;
}

/**
 * The model id Claude Code is given. A subscription (OAuth) session ignores `options.betas`, so `[1m]`
 * is the only way to open a legacy model's 1M window; it is added only for those ids while the account
 * has not refused it. A native-1M model keeps its plain id: `[1m]` would send the legacy beta and get
 * the request refused (senpi#3801).
 */
export function sdkModelId(model: WindowedModel): string {
	return opensLegacyLongContext(model) && longContextAvailable() ? `${model.id}[1m]` : model.id;
}

/** Whether a built request asked for the legacy long-context window, the only request it can be refused for. */
export function asksLegacyLongContext(sdkModel: string | undefined): boolean {
	return sdkModel?.endsWith("[1m]") === true;
}
