import type { Api, Model } from "@earendil-works/pi-ai";
import { longContextAvailable } from "./long-context.ts";

/** Claude Code's default window when a request does not ask for the long context. */
export const CLAUDE_CODE_DEFAULT_CONTEXT_WINDOW = 200_000;

/** The most of a request's output budget Claude Code holds back from its window (`zoo` in Claude Code 2.1.321). */
const CLAUDE_CODE_OUTPUT_RESERVE_CAP = 20_000;

/** The margin Claude Code keeps below its reserved window before it refuses a request (`Woo` in Claude Code 2.1.321). */
const CLAUDE_CODE_BLOCKING_BUFFER = 3_000;

/**
 * The `CLAUDE_CODE_MAX_CONTEXT_TOKENS` that makes Claude Code accept a conversation up to `window`.
 *
 * With `DISABLE_COMPACT` set, Claude Code takes that variable as the model's window, then refuses a
 * request on its own, with no API call, once the conversation passes the window minus its output reserve
 * (the request's output budget, capped at 20k) minus a 3k buffer. Handing it the bare planned window put
 * that limit 23k below the window senpi compacts against, so every turn between the two failed in
 * milliseconds with "Prompt is too long", and so did the summarization request of the recovery
 * compaction. senpi keeps its own output reserve below `window`, so the variable carries the window plus
 * Claude Code's reserve and Claude Code's limit lands on `window` itself.
 *
 * `outputTokens` is the output budget Claude Code reserves for the request. Without an explicit
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` it is the model's own default, which is at least the cap for every
 * Claude model, so the cap is the default here; a larger addition only lets a request reach the API's own
 * window check, whose error senpi's overflow recovery already parses.
 */
export function claudeCodeMaxContextTokens(window: number, outputTokens = CLAUDE_CODE_OUTPUT_RESERVE_CAP): number {
	return window + Math.min(outputTokens, CLAUDE_CODE_OUTPUT_RESERVE_CAP) + CLAUDE_CODE_BLOCKING_BUFFER;
}

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
